import { Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { ModelInfo, Provider, Role, TaskMode } from './types';
import type { UIHost } from './ui-host';

function message(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
function action(parent: HTMLElement, text: string, callback: () => void, cls = ''): HTMLButtonElement {
  const node = parent.createEl('button', { text, cls }); node.type = 'button'; node.addEventListener('click', callback); return node;
}
function newId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }

class ProviderModal extends Modal {
  private draft: Provider;
  constructor(private plugin: Plugin, private host: UIHost, provider: Provider | undefined, private done: () => void) {
    super(plugin.app);
    this.draft = provider ? { ...provider } : { id: newId('provider'), name: '', baseUrl: 'https://api.openai.com/v1', secretRef: '', model: '', stream: true, timeoutMs: 60000 };
  }
  onOpen(): void {
    this.titleEl.setText('服务配置'); this.modalEl.addClass('dc-settings-modal');
    new Setting(this.contentEl).setName('名称').addText(input => input.setValue(this.draft.name).setPlaceholder('例如：我的模型服务').onChange(value => { this.draft.name = value; }));
    new Setting(this.contentEl).setName('API 根地址').setDesc('只追加 /models 或 /chat/completions；不会自动补 /v1。').addText(input => input.setValue(this.draft.baseUrl).setPlaceholder('https://example.com/v1').onChange(value => { this.draft.baseUrl = value; }));
    const secret = new Setting(this.contentEl).setName('API 密钥').setDesc('使用 Obsidian 密钥管理器选择或新建。插件配置只保存引用；无需认证的本地服务可留空。');
    new SecretComponent(this.plugin.app, secret.controlEl).setValue(this.draft.secretRef).onChange(value => { this.draft.secretRef = value ?? ''; });
    this.contentEl.createEl('p', { text: `当前模型：${this.draft.model || '保存后获取模型列表并搜索选择'}`, cls: 'dc-muted dc-small' });
    const advanced = this.contentEl.createEl('details', { cls: 'dc-advanced' });
    advanced.createEl('summary', { text: '高级选项：模型 ID、流式、超时与容量' });
    new Setting(advanced).setName('模型 ID').setDesc('当服务不支持模型列表时使用。通常保存后获取模型列表并选择即可。').addText(input => input.setValue(this.draft.model).setPlaceholder('由服务提供的模型 ID').onChange(value => { this.draft.model = value; }));
    new Setting(advanced).setName('流式输出').setDesc('关闭后等待完整回复；协议失败时不会自动重试。').addToggle(toggle => toggle.setValue(this.draft.stream).onChange(value => { this.draft.stream = value; }));
    let timeout = String(this.draft.timeoutMs / 1000);
    new Setting(advanced).setName('请求超时（秒）').setDesc('范围 1–600 秒。').addText(input => input.setValue(timeout).onChange(value => { timeout = value; }));
    let context = this.draft.contextLimit === undefined ? '' : String(this.draft.contextLimit);
    new Setting(advanced).setName('模型上下文容量（可选）').setDesc('填入服务确认的 token 数。为空时显示估算，不自动截断全文或摘要。').addText(input => input.setValue(context).setPlaceholder('例如 128000').onChange(value => { context = value; }));
    const status = this.contentEl.createDiv({ cls: 'dc-inline-status', attr: { role: 'alert' } });
    const controls = this.contentEl.createDiv({ cls: 'dc-actions' });
    let busy = false;
    const save = action(controls, '保存配置', () => {
      if (busy) return;
      void (async () => {
        try {
          const timeoutSeconds = Number(timeout);
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error('超时应为 1–600 秒。');
          if (!this.draft.name.trim()) throw new Error('请填写服务名称。');
          const root = new URL(this.draft.baseUrl.trim());
          if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new Error('API 根地址应为 http/https 地址，不包含账号、密码、查询参数或片段。');
          if (context.trim() && (!/^\d+$/.test(context.trim()) || Number(context) <= 0 || !Number.isSafeInteger(Number(context)))) throw new Error('上下文容量应为正整数或留空。');
          this.draft.name = this.draft.name.trim(); this.draft.baseUrl = this.draft.baseUrl.trim().replace(/\/+$/, '');
          this.draft.model = this.draft.model.trim(); this.draft.timeoutMs = Math.round(timeoutSeconds * 1000);
          this.draft.contextLimit = context.trim() ? Number(context) : undefined;
          busy = true; save.disabled = true;
          const index = this.host.data.providers.findIndex(item => item.id === this.draft.id);
          if (index >= 0) this.host.data.providers[index] = { ...this.draft }; else this.host.data.providers.push({ ...this.draft });
          if (!this.host.data.activeProviderId) this.host.data.activeProviderId = this.draft.id;
          await this.host.saveSettings(); this.close(); this.done();
        } catch (error) { status.setText(message(error)); status.addClass('dc-error'); }
        finally { busy = false; save.disabled = false; }
      })();
    }, 'mod-cta');
    action(controls, '取消', () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

class ModelsModal extends Modal {
  constructor(plugin: Plugin, private host: UIHost, private source: Provider, private models: ModelInfo[], private done: () => void) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText('搜索并选择模型'); this.modalEl.addClass('dc-settings-modal');
    const search = this.contentEl.createEl('input', { type: 'search', cls: 'dc-model-search', attr: { placeholder: '按模型 ID 搜索', 'aria-label': '搜索模型' } });
    const status = this.contentEl.createDiv({ cls: 'dc-inline-status', attr: { role: 'status' } });
    const list = this.contentEl.createDiv({ cls: 'dc-model-list' });
    const render = () => {
      list.empty(); const query = search.value.toLowerCase(); const selected = this.host.data.providers.find(item => item.id === this.source.id)?.model;
      const visible = this.models.filter(item => item.id.toLowerCase().includes(query));
      status.setText(`显示 ${visible.length} / ${this.models.length} 个模型`);
      for (const model of visible) {
        const item = action(list, `${model.id === selected ? '✓ ' : ''}${model.id}`, () => {
          void (async () => {
            item.disabled = true;
            try {
              const provider = this.host.data.providers.find(entry => entry.id === this.source.id);
              if (!provider) throw new Error('该服务已被删除。');
              if (provider.baseUrl !== this.source.baseUrl || provider.secretRef !== this.source.secretRef) throw new Error('服务配置已变化，请关闭列表后重新获取。');
              provider.model = model.id; await this.host.saveSettings(); this.close(); this.done();
            } catch (error) { status.setText(message(error)); status.addClass('dc-error'); item.disabled = false; }
          })();
        }, 'dc-model-option');
        item.setAttribute('aria-pressed', String(model.id === selected));
      }
      if (!visible.length) list.createEl('p', { text: '没有匹配模型。仍可在服务配置中手动输入模型 ID。', cls: 'dc-muted' });
    };
    search.addEventListener('input', render); render();
    action(this.contentEl, '关闭', () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

class RoleModal extends Modal {
  private draft: Role;
  constructor(plugin: Plugin, private host: UIHost, role: Role | undefined, private done: () => void) {
    super(plugin.app);
    this.draft = role ? { ...role, quickTasks: [...role.quickTasks] } : { id: newId('role'), name: '', description: '', systemPrompt: '', defaultMode: 'discuss', quickTasks: [] };
  }
  onOpen(): void {
    this.titleEl.setText('创作伙伴'); this.modalEl.addClass('dc-settings-modal');
    new Setting(this.contentEl).setName('名称').addText(input => input.setValue(this.draft.name).onChange(value => { this.draft.name = value; }));
    new Setting(this.contentEl).setName('职责').addTextArea(input => input.setValue(this.draft.description).onChange(value => { this.draft.description = value; }));
    new Setting(this.contentEl).setName('角色规则').setDesc('每次请求仅启用当前伙伴的规则。正文内容始终作为知识材料处理。').addTextArea(input => {
      input.inputEl.rows = 10; input.inputEl.addClass('dc-role-prompt');
      input.setValue(this.draft.systemPrompt).onChange(value => { this.draft.systemPrompt = value; });
    });
    new Setting(this.contentEl).setName('默认方式').addDropdown(dropdown => dropdown.addOption('discuss', '讨论').addOption('edit', '改稿').setValue(this.draft.defaultMode).onChange(value => { this.draft.defaultMode = value as TaskMode; }));
    let quickText = this.draft.quickTasks.join('\n');
    new Setting(this.contentEl).setName('快捷任务').setDesc('每行一个。点击后只填入输入框，由你确认发送。').addTextArea(input => {
      input.inputEl.rows = 5; input.setValue(quickText).onChange(value => { quickText = value; });
    });
    const status = this.contentEl.createDiv({ cls: 'dc-inline-status', attr: { role: 'alert' } });
    const controls = this.contentEl.createDiv({ cls: 'dc-actions' });
    let busy = false;
    const save = action(controls, '保存伙伴', () => {
      if (busy) return;
      void (async () => {
        try {
          if (!this.draft.name.trim()) throw new Error('请填写伙伴名称。');
          if (!this.draft.systemPrompt.trim()) throw new Error('请填写角色规则。');
          this.draft.name = this.draft.name.trim(); this.draft.quickTasks = quickText.split('\n').map(item => item.trim()).filter(Boolean);
          busy = true; save.disabled = true;
          const index = this.host.data.roles.findIndex(item => item.id === this.draft.id);
          if (index >= 0) this.host.data.roles[index] = { ...this.draft }; else this.host.data.roles.push({ ...this.draft });
          await this.host.saveSettings(); this.close(); this.done();
        } catch (error) { status.setText(message(error)); status.addClass('dc-error'); }
        finally { busy = false; save.disabled = false; }
      })();
    }, 'mod-cta');
    action(controls, '取消', () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

export class DraftCompanionSettings extends PluginSettingTab {
  private disposed = false;
  private status = new Map<string, { models?: { text: string; error: boolean }; chat?: { text: string; error: boolean } }>();
  constructor(private plugin: Plugin, private host: UIHost) { super(plugin.app, plugin); }
  display(): void {
    this.disposed = false;
    this.containerEl.empty(); this.containerEl.addClass('dc-settings');
    this.containerEl.createEl('h2', { text: '稿伴设置' });
    const privacy = this.containerEl.createDiv({ cls: 'dc-settings-note' });
    privacy.createEl('p', { text: '每次发送会把目标文稿最新全文、本文要求、创作偏好和本文会话发送到所选服务。双链、嵌入和其他笔记不会被读取。' });
    privacy.createEl('p', { text: 'API 密钥由 Obsidian 密钥管理器保存。会话、待应用候选及最近撤回版本保存于本地插件数据，可能随你的同步方案同步。' });
    privacy.createEl('p', { text: '首版不联网核实、不操作公众号后台。桌面网络请求不自动继承系统 / PAC 代理；停止请求不保证服务端停止计费。' });
    new Setting(this.containerEl).setName('模型服务').setHeading().addButton(button => button.setButtonText('添加服务').setCta().onClick(() => new ProviderModal(this.plugin, this.host, undefined, () => this.display()).open()));
    if (!this.host.data.providers.length) this.containerEl.createEl('p', { text: '添加兼容 OpenAI 的 API 根地址，然后选择密钥和模型。', cls: 'dc-muted' });
    for (const provider of this.host.data.providers) this.providerCard(provider);
    new Setting(this.containerEl).setName('创作伙伴').setHeading().addButton(button => button.setButtonText('新增伙伴').onClick(() => new RoleModal(this.plugin, this.host, undefined, () => this.display()).open()));
    if (!this.host.data.roles.length) this.containerEl.createEl('p', { text: '没有创作伙伴，请新增角色规则。', cls: 'dc-muted' });
    for (const role of this.host.data.roles) {
      const card = this.containerEl.createDiv({ cls: 'dc-settings-card' });
      card.createEl('strong', { text: role.name }); card.createEl('p', { text: role.description, cls: 'dc-muted dc-small' });
      card.createEl('p', { text: `${role.defaultMode === 'edit' ? '默认改稿' : '默认讨论'} · ${role.quickTasks.length} 个快捷任务`, cls: 'dc-small' });
      const controls = card.createDiv({ cls: 'dc-actions' });
      action(controls, '编辑', () => new RoleModal(this.plugin, this.host, role, () => this.display()).open());
      action(controls, '复制', () => new RoleModal(this.plugin, this.host, { ...role, id: newId('role'), name: `${role.name} 副本` }, () => this.display()).open());
      action(controls, '删除', () => this.confirm(`删除创作伙伴“${role.name}”`, '历史消息会保留伙伴名称；已有文稿会改用剩余的第一个伙伴。', async () => {
        this.host.data.roles = this.host.data.roles.filter(item => item.id !== role.id);
        for (const session of Object.values(this.host.data.sessions)) if (session.selectedRoleId === role.id) session.selectedRoleId = this.host.data.roles[0]?.id || '';
        await this.host.saveSettings(); this.display();
      }));
    }
    new Setting(this.containerEl).setName('全局创作偏好').setHeading();
    let preferences = this.host.data.preferences;
    new Setting(this.containerEl).setName('可留空').setDesc('例如读者与风格偏好。公众号名称和署名不会预填。').addTextArea(input => {
      input.inputEl.rows = 5; input.inputEl.addClass('dc-preferences');
      input.setValue(preferences).onChange(value => { preferences = value; });
    });
    const status = this.containerEl.createDiv({ cls: 'dc-inline-status', attr: { role: 'status' } });
    const savePreferences = action(this.containerEl, '保存创作偏好', () => {
      savePreferences.disabled = true;
      void (async () => {
        try { this.host.data.preferences = preferences; await this.host.saveSettings(); status.setText('创作偏好已保存。'); status.removeClass('dc-error'); }
        catch (error) { status.setText(message(error)); status.addClass('dc-error'); }
        finally { savePreferences.disabled = false; }
      })();
    });
  }
  private providerCard(provider: Provider): void {
    const card = this.containerEl.createDiv({ cls: 'dc-settings-card' });
    card.createEl('strong', { text: `${provider.name}${provider.id === this.host.data.activeProviderId ? ' · 当前服务' : ''}` });
    card.createEl('p', { text: provider.baseUrl, cls: 'dc-path dc-small' });
    card.createEl('p', { text: `模型：${provider.model || '未选择'} · ${provider.stream ? '流式' : '完整回复'} · 超时 ${provider.timeoutMs / 1000} 秒`, cls: 'dc-muted dc-small' });
    const statuses = card.createDiv({ cls: 'dc-provider-statuses', attr: { 'aria-live': 'polite' } });
    const displayStatus = () => {
      statuses.empty(); const state = this.status.get(provider.id);
      statuses.createDiv({ text: `模型列表：${state?.models?.text || '尚未获取'}`, cls: state?.models?.error ? 'dc-error' : 'dc-small' });
      statuses.createDiv({ text: `聊天测试：${state?.chat?.text || '尚未测试'}`, cls: state?.chat?.error ? 'dc-error' : 'dc-small' });
    }; displayStatus();
    const controls = card.createDiv({ cls: 'dc-actions' });
    action(controls, '使用此服务', () => {
      void this.persist(async () => { this.host.data.activeProviderId = provider.id; await this.host.saveSettings(); this.display(); });
    }).disabled = provider.id === this.host.data.activeProviderId;
    action(controls, '编辑', () => new ProviderModal(this.plugin, this.host, provider, () => { this.status.delete(provider.id); this.display(); }).open());
    const models = action(controls, '获取模型并选择', () => {
      if (models.disabled) return; models.disabled = true;
      const state = this.status.get(provider.id) || {}; state.models = { text: '正在获取……', error: false }; this.status.set(provider.id, state); displayStatus();
      void (async () => {
        try {
          const requestedProvider = { ...provider };
          const result = await this.host.models(requestedProvider);
          const current = this.host.data.providers.find(item => item.id === provider.id);
          if (!current || current.baseUrl !== requestedProvider.baseUrl || current.secretRef !== requestedProvider.secretRef) throw new Error('服务配置已变化，请重新获取模型。');
          state.models = { text: `成功，${result.length} 个模型`, error: false };
          if (!this.disposed) new ModelsModal(this.plugin, this.host, requestedProvider, result, () => { const latest = this.status.get(provider.id); if (latest) delete latest.chat; if (!this.disposed) this.display(); }).open();
        } catch (error) { state.models = { text: message(error), error: true }; }
        finally { displayStatus(); models.disabled = false; }
      })();
    });
    const test = action(controls, '独立聊天测试', () => {
      if (test.disabled) return; test.disabled = true;
      const state = this.status.get(provider.id) || {}; state.chat = { text: '正在测试……', error: false }; this.status.set(provider.id, state); displayStatus();
      void (async () => {
        try {
          const requestedProvider = { ...provider };
          const result = await this.host.testProvider(requestedProvider);
          const current = this.host.data.providers.find(item => item.id === provider.id);
          if (!current || current.baseUrl !== requestedProvider.baseUrl || current.secretRef !== requestedProvider.secretRef || current.model !== requestedProvider.model) throw new Error('服务或模型配置已变化，请重新测试。');
          state.chat = { text: `成功 · ${result.slice(0, 160)}`, error: false };
        }
        catch (error) { state.chat = { text: message(error), error: true }; }
        finally { displayStatus(); test.disabled = false; }
      })();
    });
    action(controls, '删除', () => this.confirm(`删除服务“${provider.name}”`, '只删除服务配置，不删除 Obsidian 密钥管理器中的密钥。', async () => {
      this.host.data.providers = this.host.data.providers.filter(item => item.id !== provider.id);
      if (this.host.data.activeProviderId === provider.id) this.host.data.activeProviderId = this.host.data.providers[0]?.id || '';
      await this.host.saveSettings(); this.display();
    }));
  }
  hide(): void { this.dispose(); }
  dispose(): void { this.disposed = true; }
  private async persist(action: () => Promise<void>): Promise<void> { try { await action(); } catch (error) { new Notice(message(error), 7000); } }
  private confirm(title: string, text: string, callback: () => Promise<void>): void {
    const modal = new Modal(this.plugin.app); modal.titleEl.setText(title); modal.contentEl.createEl('p', { text });
    const status = modal.contentEl.createDiv({ cls: 'dc-inline-status', attr: { role: 'alert' } });
    const controls = modal.contentEl.createDiv({ cls: 'dc-actions' });
    const remove = action(controls, '确认删除', () => {
      if (remove.disabled) return; remove.disabled = true;
      void (async () => {
        try { await callback(); modal.close(); }
        catch (error) { status.setText(message(error)); status.addClass('dc-error'); remove.disabled = false; }
      })();
    }, 'mod-warning');
    action(controls, '取消', () => modal.close()); modal.open();
  }
}
