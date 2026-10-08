import { Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TextComponent } from 'obsidian';
import type { ModelInfo, Provider, Role, TaskMode } from './types';
import type { UIHost } from './ui-host';
import { defaultDailyTopicData } from './daily-types';

function message(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
function action(parent: HTMLElement, text: string, callback: () => void, cls = ''): HTMLButtonElement {
  const node = parent.createEl('button', { text, cls }); node.type = 'button'; node.addEventListener('click', callback); return node;
}
function newId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
type ModelListStatus = { text: string; error: boolean };

export class ProviderModal extends Modal {
  private draft: Provider;
  private timeoutText: string;
  private contextText: string;
  private opened = false;
  private saving = false;
  private loading = false;
  private requestId = 0;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connection: string;
  private models: ModelInfo[] = [];
  private modelStatus!: HTMLElement;
  private modelList!: HTMLElement;
  private selectedModel!: HTMLElement;
  private search!: HTMLInputElement;
  private refresh!: HTMLButtonElement;
  private save!: HTMLButtonElement;
  private skipModelSave!: HTMLButtonElement;
  private manualModel!: TextComponent;
  private formStatus!: HTMLElement;
  private footer: HTMLElement | undefined;
  private existing: boolean;
  private modelsResult: ModelListStatus | undefined;
  constructor(private plugin: Plugin, private host: UIHost, provider: Provider | undefined, private done: (provider: Provider, modelsResult?: ModelListStatus) => void) {
    super(plugin.app);
    this.draft = provider ? { ...provider } : { id: newId('provider'), name: '', baseUrl: '', secretRef: '', model: '', stream: true, timeoutMs: 60000 };
    this.existing = !!provider;
    this.timeoutText = String(this.draft.timeoutMs / 1000);
    this.contextText = this.draft.contextLimit === undefined ? '' : String(this.draft.contextLimit);
    this.connection = this.connectionKey();
  }
  onOpen(): void {
    this.opened = true;
    this.plugin.register(() => this.close());
    this.titleEl.setText('服务配置'); this.modalEl.addClass('dc-settings-modal'); this.modalEl.addClass('dc-provider-modal');
    new Setting(this.contentEl).setName('名称').addText(input => input.setValue(this.draft.name).setPlaceholder('例如：我的模型服务').onChange(value => { this.draft.name = value; }));
    new Setting(this.contentEl).setName('API 根地址').setDesc('填写服务商提供的完整 API 地址，例如 https://example.com/v1。').addText(input => input.setValue(this.draft.baseUrl).setPlaceholder('https://example.com/v1').onChange(value => { this.draft.baseUrl = value; this.connectionChanged(); }));
    const secret = new Setting(this.contentEl).setName('API 密钥').setDesc('使用 Obsidian 密钥管理器选择或新建。插件配置只保存引用；无需认证的本地服务可留空。');
    new SecretComponent(this.plugin.app, secret.controlEl).setValue(this.draft.secretRef).onChange(value => { this.draft.secretRef = value ?? ''; this.connectionChanged(true); });
    const discovery = this.contentEl.createDiv({ cls: 'dc-model-discovery' });
    const heading = discovery.createDiv({ cls: 'dc-model-heading' });
    heading.createEl('strong', { text: '选择模型' });
    this.refresh = action(heading, '获取模型', () => { void this.loadModels(); }, 'dc-model-refresh');
    discovery.createEl('p', { text: '填好地址和密钥后自动获取，在这里搜索并选择。获取列表不发送文稿。', cls: 'dc-muted dc-small' });
    this.selectedModel = discovery.createDiv({ cls: 'dc-selected-model' });
    this.modelStatus = discovery.createDiv({ cls: 'dc-model-status dc-inline-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.modelStatus.setText('填写地址并选择密钥后，模型会自动显示。无需密钥的服务可点击“获取模型”。');
    this.search = discovery.createEl('input', { type: 'search', cls: 'dc-model-search', attr: { placeholder: '搜索模型名称或 ID', 'aria-label': '搜索模型' } });
    this.search.hidden = true;
    this.modelList = discovery.createDiv({ cls: 'dc-model-list' });
    this.search.addEventListener('input', () => this.renderModels());
    const advanced = this.contentEl.createEl('details', { cls: 'dc-advanced' });
    advanced.createEl('summary', { text: '高级选项：手动模型 ID、流式、超时与容量' });
    new Setting(advanced).setName('手动模型 ID').setDesc('仅当服务未提供模型列表，或你已知道其他模型 ID 时填写。').addText(input => {
      this.manualModel = input;
      input.setValue(this.draft.model).setPlaceholder('由服务提供的模型 ID').onChange(value => { this.draft.model = value; this.renderSelection(); this.renderModels(); });
    });
    new Setting(advanced).setName('流式输出').setDesc('关闭后等待完整回复；协议失败时不会自动重试。').addToggle(toggle => toggle.setValue(this.draft.stream).onChange(value => { this.draft.stream = value; }));
    new Setting(advanced).setName('工具协议').setDesc('自动方式以合成材料探测当前服务和模型。认证、网络或超时错误不会切换协议。').addDropdown(dropdown=>dropdown.addOptions({auto:'自动检测',native:'原生工具',structured:'结构化兼容'}).setValue(this.draft.toolMode ?? 'auto').onChange(value=>{this.draft.toolMode=value as Provider['toolMode'];}));
    new Setting(advanced).setName('请求超时（秒）').setDesc('单次模型调用的最长等待时间，包含思考和输出。范围 1–600 秒；复杂选题可设为 180 秒。').addText(input => input.setValue(this.timeoutText).onChange(value => { this.timeoutText = value; }));
    new Setting(advanced).setName('模型上下文容量（可选）').setDesc('填入服务确认的 token 数。为空时显示估算，不自动截断全文或摘要。').addText(input => input.setValue(this.contextText).setPlaceholder('例如 128000').onChange(value => { this.contextText = value; }));
    this.formStatus = this.contentEl.createDiv({ cls: 'dc-inline-status', attr: { role: 'alert' } });
    const controls = this.modalEl.createDiv({ cls: 'dc-actions dc-provider-footer' }); this.footer = controls;
    this.save = action(controls, '获取模型并继续', () => { void this.saveDraft(); }, 'mod-cta');
    this.skipModelSave = action(controls, '暂不选模型，保存服务', () => { void this.saveDraft(true); }, 'dc-text-button');
    action(controls, '取消', () => this.close());
    this.renderSelection();
    if (this.existing || this.draft.secretRef) void this.loadModels();
  }
  private connectionKey(): string { return JSON.stringify([this.draft.baseUrl.trim().replace(/\/+$/, ''), this.draft.secretRef]); }
  private cancelDiscovery(): void {
    this.requestId++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort(); this.abort = undefined;
    this.loading = false;
  }
  private connectionChanged(secretChanged = false): void {
    if (!this.opened) return;
    const connection = this.connectionKey();
    if (this.connection === connection && !secretChanged) return;
    this.connection = connection;
    this.cancelDiscovery();
    this.models = []; this.modelsResult = undefined; this.draft.model = ''; this.search.value = ''; this.search.hidden = true;
    this.manualModel.setValue(''); this.modelList.empty(); this.modelStatus.removeClass('dc-error');
    this.modelStatus.setText('地址或密钥已变化，请重新选择模型。');
    this.renderSelection();
    this.refresh.disabled = false; this.refresh.setText('获取模型');
    if (this.existing || this.draft.secretRef) this.timer = setTimeout(() => { this.timer = undefined; void this.loadModels(); }, 500);
  }
  private requestProvider(): Provider {
    let root: URL;
    try { root = new URL(this.draft.baseUrl.trim()); }
    catch { throw new Error('请填写完整的 API 根地址，例如 https://example.com/v1。'); }
    if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new Error('API 根地址应为 http/https 地址，不包含账号、密码、查询参数或片段。');
    const timeoutSeconds = Number(this.timeoutText);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error('超时应为 1–600 秒。');
    return { ...this.draft, baseUrl: this.draft.baseUrl.trim().replace(/\/+$/, ''), model: this.draft.model.trim(), timeoutMs: Math.round(timeoutSeconds * 1000) };
  }
  private async loadModels(): Promise<void> {
    if (!this.opened || this.loading || this.saving) return;
    this.cancelDiscovery();
    const id = this.requestId;
    const abort = new AbortController(); this.abort = abort;
    this.loading = true; this.refresh.disabled = true; this.refresh.setText('正在获取…');
    this.modelStatus.removeClass('dc-error'); this.modelStatus.setText('正在获取模型列表…');
    this.renderSelection();
    try {
      const models = await this.host.models(this.requestProvider(), abort.signal);
      if (!this.opened || id !== this.requestId || abort.signal.aborted) return;
      this.models = models; this.search.hidden = !models.length;
      this.modelsResult = { text: models.length ? `成功，${models.length} 个模型` : '成功，但服务没有返回任何模型', error: false };
      this.renderModels();
      if (!models.length) this.modelStatus.setText('服务没有返回任何模型。可以刷新重试，或在高级选项中手动填写模型 ID。');
    } catch (error) {
      if (!this.opened || id !== this.requestId || abort.signal.aborted) return;
      this.models = []; this.search.hidden = true; this.modelList.empty();
      this.modelsResult = { text: message(error), error: true };
      this.modelStatus.setText(message(error)); this.modelStatus.addClass('dc-error');
    } finally {
      if (this.opened && id === this.requestId) {
        this.loading = false; this.abort = undefined; this.refresh.disabled = false;
        this.refresh.setText(this.models.length ? '刷新模型' : '重试获取');
        this.renderSelection();
      }
    }
  }
  private renderSelection(): void {
    const selected = this.draft.model.trim();
    const absent = selected && this.models.length && !this.models.some(model => model.id === selected);
    this.selectedModel.setText(selected ? `当前选择：${selected}${absent ? '（本次列表未包含，可保留并单独测试）' : ''}` : '尚未选择模型');
    this.save.setText(this.saving ? '正在保存…' : selected ? '保存配置' : this.models.length ? '请先选择模型' : '获取模型并继续');
    this.save.disabled = this.saving || (!selected && (this.loading || this.models.length > 0));
    this.refresh.disabled = this.saving || this.loading;
    this.skipModelSave.hidden = !!selected; this.skipModelSave.disabled = this.saving;
    this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea').forEach(input => { input.disabled = this.saving; });
  }
  private renderModels(): void {
    this.modelList.empty();
    if (!this.models.length) return;
    const query = this.search.value.trim().toLowerCase();
    const visible = this.models.filter(model => model.id.toLowerCase().includes(query));
    this.modelStatus.removeClass('dc-error');
    this.modelStatus.setText(query ? `显示 ${visible.length} / ${this.models.length} 个模型` : `服务返回 ${this.models.length} 个模型，点击选择。聊天是否可用可在保存后单独测试。`);
    for (const model of visible) {
      const selected = model.id === this.draft.model.trim();
      const button = action(this.modelList, `${selected ? '✓ ' : ''}${model.id}`, () => {
        this.draft.model = model.id; this.manualModel.setValue(model.id);
        this.renderSelection(); this.renderModels();
      }, 'dc-model-option');
      button.setAttribute('aria-pressed', String(selected));
    }
    if (!visible.length) this.modelList.createEl('p', { text: '没有匹配的模型，试试其他关键词或清空搜索。', cls: 'dc-muted dc-small' });
  }
  private async saveDraft(allowEmptyModel = false): Promise<void> {
    if (this.saving || !this.opened) return;
    this.formStatus.setText('');
    try {
      const provider = this.requestProvider();
      if (!provider.name.trim()) throw new Error('请填写服务名称。');
      provider.name = provider.name.trim();
      const context = this.contextText.trim();
      if (context && (!/^\d+$/.test(context) || Number(context) <= 0 || !Number.isSafeInteger(Number(context)))) throw new Error('上下文容量应为正整数或留空。');
      provider.contextLimit = context ? Number(context) : undefined;
      if (!provider.model && !allowEmptyModel) {
        if (!this.models.length) await this.loadModels();
        this.search.focus(); return;
      }
      this.saving = true; this.cancelDiscovery(); this.renderSelection();
      const index = this.host.data.providers.findIndex(item => item.id === provider.id);
      if (index >= 0) this.host.data.providers[index] = provider; else this.host.data.providers.push(provider);
      if (!this.host.data.activeProviderId) this.host.data.activeProviderId = provider.id;
      await this.host.saveSettings();
      if (this.opened) { this.close(); this.done(provider, this.modelsResult); }
    } catch (error) {
      if (this.opened) { this.formStatus.setText(message(error)); this.formStatus.addClass('dc-error'); }
    } finally { this.saving = false; if (this.opened) this.renderSelection(); }
  }
  onClose(): void { this.opened = false; this.cancelDiscovery(); this.contentEl.empty(); this.footer?.remove(); this.footer = undefined; }
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
  private dailyUnsubscribe?: () => void;
  private status = new Map<string, { models?: { text: string; error: boolean }; chat?: { text: string; error: boolean } }>();
  constructor(private plugin: Plugin, private host: UIHost) { super(plugin.app, plugin); }
  display(): void {
    this.disposed = false;
    this.dailyUnsubscribe?.(); this.dailyUnsubscribe = undefined;
    this.containerEl.empty(); this.containerEl.addClass('dc-settings');
    new Setting(this.containerEl).setName('稿伴设置').setHeading();
    const privacy = this.containerEl.createDiv({ cls: 'dc-settings-note' });
    privacy.createEl('p', { text: '每次发送会把目标文稿最新全文、本文要求、创作偏好和本文会话发送到所选服务。双链、嵌入和其他笔记不会被读取。' });
    privacy.createEl('p', { text: 'API 密钥由 Obsidian 密钥管理器保存。会话、待应用候选及最近撤回版本保存于本地插件数据，可能随你的同步方案同步。' });
    privacy.createEl('p', { text: '普通聊天不会自动联网；每日选题会采集公开来源及候选原始材料，不操作公众号后台。桌面网络请求不自动继承系统 / PAC 代理；停止请求不保证服务端停止计费。' });
    new Setting(this.containerEl).setName('模型服务').setHeading().addButton(button => button.setButtonText('添加服务').setCta().onClick(() => new ProviderModal(this.plugin, this.host, undefined, (provider, models) => {
      if (models) this.status.set(provider.id, { models }); this.display();
    }).open()));
    if (!this.host.data.providers.length) this.containerEl.createEl('p', { text: '添加兼容 OpenAI 的 API 根地址，然后选择密钥和模型。', cls: 'dc-muted' });
    for (const provider of this.host.data.providers) this.providerCard(provider);
    this.dailySettings();
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
  private dailySettings(): void {
    const daily = this.host.data.dailyTopics ??= defaultDailyTopicData();
    const draft = { ...daily.settings };
    const parent = this.containerEl.createDiv({ cls: 'dc-daily-settings' });
    new Setting(parent).setName('每日选题').setHeading();
    parent.createEl('p', { text: '每天北京时间定时采集，Obsidian 需要保持打开。错过时间后下次打开补跑最近一个到期日，不连续补写多天。手动“立即开始”无需开启定时。', cls: 'dc-muted dc-small' });
    parent.createEl('p', { text: '只向模型发送作者偏好和公开来源材料，不发送整份选题库。候选最多 10 个，优选按质量选择 0–5 个；勾选表示值得创作。', cls: 'dc-muted dc-small' });
    const state = parent.createDiv({ cls: 'dc-inline-status', attr: { role: 'status', 'aria-live': 'polite' } });
    const showError = (error: unknown): void => { state.setText(message(error)); state.addClass('dc-error'); };
    const saveDraft = async (): Promise<void> => {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error('定时时间应为 HH:mm，例如 09:00。');
      const previous = daily.settings;
      daily.settings = { ...draft };
      try { await this.host.saveSettings(); }
      catch (error) { daily.settings = previous; throw error; }
    };
    new Setting(parent).setName('选题库').setDesc(this.host.data.topicLibrary?.deleted ? '原选题库已删除，请重新绑定。' : this.host.data.topicLibrary?.path || '尚未绑定 Markdown 文稿。')
      .addButton(button => button.setButtonText(this.host.data.topicLibrary ? '更换选题库' : '绑定选题库').onClick(() => {
        button.buttonEl.disabled = true;
        void saveDraft().then(() => this.host.bindTopicLibrary()).then(() => { if (!this.disposed) this.display(); }).catch(showError).finally(() => { button.buttonEl.disabled = false; });
      }));
    new Setting(parent).setName('本机每日自动运行').setDesc('此开关仅保存在本机，不随插件数据同步到其他设备。').addToggle(toggle => {
      toggle.setValue(this.host.dailyEnabled?.() ?? false).onChange(value => {
        if (!this.host.setDailyEnabled) { toggle.setValue(false); showError(new Error('当前窗口尚未接入每日调度，请重新加载插件。')); return; }
        const previous = this.host.dailyEnabled?.() ?? false;
        void saveDraft().then(() => this.host.setDailyEnabled!(value)).then(() => { state.removeClass('dc-error'); state.setText(value ? '本机定时已开启；到期任务将自动运行。' : '本机定时已关闭，仍可手动开始。'); }).catch(error => { toggle.setValue(previous); showError(error); });
      });
    });
    new Setting(parent).setName('运行时间（北京时间）').setDesc('24 小时制，时区固定为 Asia/Shanghai。').addText(input => {
      input.inputEl.setAttribute('aria-label', '每日选题时间');
      input.setValue(draft.time).setPlaceholder('09:00').onChange(value => { draft.time = value.trim(); });
    });
    const providers: Record<string, string> = { '': '使用当前服务及模型' };
    for (const provider of this.host.data.providers) providers[provider.id] = `${provider.name} · ${provider.model || '尚未选择模型'}`;
    if (draft.providerId && !providers[draft.providerId]) providers[draft.providerId] = '原服务已删除，请重新选择';
    new Setting(parent).setName('选题服务与模型').setDesc('模型在上方“模型服务”中管理。').addDropdown(dropdown => dropdown.addOptions(providers).setValue(draft.providerId).onChange(value => { draft.providerId = value; }));
    const roles: Record<string, string> = { '': '默认选题编辑' };
    for (const role of this.host.data.roles) roles[role.id] = role.name;
    if (draft.roleId && !roles[draft.roleId]) roles[draft.roleId] = '原伙伴已删除，请重新选择';
    new Setting(parent).setName('选题伙伴').setDesc('保留伙伴原有自定义规则；采集与写作预设由本轮运行协议补充。').addDropdown(dropdown => dropdown.addOptions(roles).setValue(draft.roleId).onChange(value => { draft.roleId = value; }));
    for (const field of [
      { key: 'authorBackground' as const, label: '作者背景', description: '可留空。填写你熟悉的领域和真实经历；不会默认编造职业或亲测记录。' },
      { key: 'targetReader' as const, label: '目标读者', description: '说明文章主要帮助谁，以及他们正在解决什么问题。' },
      { key: 'interests' as const, label: '感兴趣的内容', description: '例如 AI 实用工具、Agent、知识管理、内容创作和可复用工作流。' },
      { key: 'exclusions' as const, label: '排除内容', description: '可留空。填写不想选的方向、项目或叙述方式。' },
    ]) new Setting(parent).setName(field.label).setDesc(field.description).addTextArea(input => {
      input.inputEl.rows = 3; input.inputEl.setAttribute('aria-label', field.label);
      input.setValue(draft[field.key]).onChange(value => { draft[field.key] = value; });
    });
    new Setting(parent).setName('GitHub 补充来源').setDesc('Git Stars 受阻时使用 GitHub 官方仓库搜索，标明实际来源，不冒充 Git Stars 排名。').addToggle(toggle => toggle.setValue(draft.githubFallback).onChange(value => { draft.githubFallback = value; }));
    const controls = parent.createDiv({ cls: 'dc-actions' });
    const save = action(controls, '保存每日选题配置', () => {
      save.disabled = true;
      void saveDraft().then(() => { state.removeClass('dc-error'); state.setText('每日选题配置已保存。'); }).catch(showError).finally(() => { save.disabled = false; });
    });
    const start = action(controls, '立即开始', () => {
      const run = this.host.dailyStatus?.();
      if (run && ['queued', 'collecting', 'screening', 'reading', 'preparing', 'committing'].includes(run.status)) { this.host.stopDailyTopics?.(); return; }
      start.disabled = true;
      void saveDraft().then(() => this.host.startDailyTopics?.()).catch(showError).finally(() => { start.disabled = !this.host.startDailyTopics; });
    }, 'mod-cta');
    start.disabled = !this.host.startDailyTopics;
    const records = action(controls, '查看记录', () => this.host.openDailyResult?.()); records.disabled = !this.host.openDailyResult;
    const refresh = (): void => {
      if (this.disposed) return;
      const run = this.host.dailyStatus?.(), active = !!run && ['queued', 'collecting', 'screening', 'reading', 'preparing', 'committing'].includes(run.status);
      start.setText(active ? '停止选题' : '立即开始'); start.disabled = active ? !this.host.stopDailyTopics : !this.host.startDailyTopics;
      if (run) { state.setText(run.message || run.error || run.stage); if (run.status === 'failed') state.addClass('dc-error'); else state.removeClass('dc-error'); }
    };
    this.dailyUnsubscribe = this.host.subscribe(refresh); refresh();
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
    const configure = () => new ProviderModal(this.plugin, this.host, provider, (saved, models) => {
      this.status.delete(saved.id); if (models) this.status.set(saved.id, { models }); if (!this.disposed) this.display();
    }).open();
    action(controls, provider.model ? '更换模型' : '选择模型', configure, 'mod-cta');
    action(controls, '编辑服务', configure);
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
  dispose(): void { this.disposed = true; this.dailyUnsubscribe?.(); this.dailyUnsubscribe = undefined; }
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
