import { ItemView, Modal, Notice, WorkspaceLeaf } from 'obsidian';
import { diffLines } from 'diff';
import type { Candidate, EditScope, Session, TaskMode } from './types';
import type { UIHost } from './ui-host';
import { renderSafeMarkdown } from './render';

export const VIEW_TYPE = 'draft-companion-view';
const stateLabels: Record<Candidate['state'], string> = {
  ready: '待应用', applying: '正在应用', applied: '已应用', discarded: '已放弃',
  superseded: '已被新候选替代', stale: '文稿已变化', undone: '已撤回',
};

function button(parent: HTMLElement, label: string, action: () => void, extra = ''): HTMLButtonElement {
  const node = parent.createEl('button', { text: label, cls: extra });
  node.type = 'button'; node.addEventListener('click', action); return node;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }

export class CandidateModal extends Modal {
  private busy = false;
  constructor(private host: UIHost, private candidate: Candidate, private continueEditing: () => void, app: ItemView['app']) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('dc-candidate-modal');
    this.titleEl.setText(this.candidate.deletion ? '预览删除候选' : '预览修改候选');
    const { contentEl, candidate } = this;
    contentEl.createEl('p', { text: candidate.path, cls: 'dc-path' });
    contentEl.createEl('p', { text: `${candidate.scope === 'selection' ? '发送时选区' : '正文（保护 frontmatter）'} · ${stateLabels[candidate.state]} · 整批应用`, cls: 'dc-muted' });
    const description = contentEl.createDiv({ cls: 'dc-message-content' }); renderSafeMarkdown(description, candidate.explanation);
    if (candidate.notes.length) {
      const details = contentEl.createEl('details', { cls: 'dc-notes' });
      details.createEl('summary', { text: '待核实与修改说明' });
      const list = details.createEl('ul'); candidate.notes.forEach(note => list.createEl('li', { text: note }));
    }
    const diff = contentEl.createDiv({ cls: 'dc-diff', attr: { 'aria-label': '整批修改差异' } });
    const oldText = candidate.baseline.slice(candidate.from, candidate.to);
    for (const part of diffLines(oldText, candidate.replacement)) {
      const line = diff.createDiv({ cls: part.added ? 'dc-diff-add' : part.removed ? 'dc-diff-remove' : 'dc-diff-same' });
      line.createEl('span', { text: part.added ? '+' : part.removed ? '−' : ' ', cls: 'dc-diff-marker', attr: { 'aria-hidden': 'true' } });
      line.createEl('pre', { text: part.value });
    }
    if (oldText === candidate.replacement) contentEl.createEl('p', { text: '候选与原文一致。', cls: 'dc-muted' });
    const status = contentEl.createDiv({ cls: 'dc-inline-status', attr: { role: 'status' } });
    const controls = contentEl.createDiv({ cls: 'dc-actions' });
    const run = async (action: () => Promise<void>) => {
      if (this.busy) return; this.busy = true;
      controls.querySelectorAll('button').forEach(node => (node.disabled = true));
      try { await action(); this.close(); } catch (error) { status.setText(errorText(error)); status.addClass('dc-error'); }
      finally {
        this.busy = false;
        controls.querySelectorAll('button').forEach(node => (node.disabled = false));
        apply.disabled = candidate.state !== 'ready'; discard.disabled = candidate.state !== 'ready';
      }
    };
    const apply = button(controls, candidate.deletion ? '应用删除' : '应用整批修改', () => { void run(() => this.host.apply(candidate)); }, 'mod-cta');
    const discard = button(controls, '放弃候选', () => { void run(() => this.host.discard(candidate)); });
    apply.disabled = candidate.state !== 'ready'; discard.disabled = candidate.state !== 'ready';
    button(controls, '继续调整', () => { this.close(); this.continueEditing(); });
    button(controls, '关闭', () => this.close());
    contentEl.createEl('p', { text: '仅候选正文写入文稿。文稿变化后请重新生成，说明与待核实事项不会写入。', cls: 'dc-muted dc-small' });
  }
  onClose(): void { this.contentEl.empty(); }
}

class TextModal extends Modal {
  constructor(app: ItemView['app'], private title: string, private path: string, private text: string) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.title); this.modalEl.addClass('dc-candidate-modal');
    this.contentEl.createEl('p', { text: this.path, cls: 'dc-path' });
    this.contentEl.createEl('pre', { text: this.text, cls: 'dc-old-version' });
    button(this.contentEl, '关闭', () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

export class DraftCompanionView extends ItemView {
  private unsubscribe?: () => void;
  private roleSelect!: HTMLSelectElement;
  private providerSelect!: HTMLSelectElement;
  private modelInput!: HTMLInputElement;
  private targetEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private runningEl!: HTMLElement;
  private briefInput!: HTMLTextAreaElement;
  private conversation!: HTMLElement;
  private quickTasks!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private modeSelect!: HTMLSelectElement;
  private scopeSelect!: HTMLSelectElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private deleteButton!: HTMLButtonElement;
  private undoButton!: HTMLButtonElement;
  private candidateEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private composing = false;
  private sending = false;
  private editingBusy = false;
  private sessionId = '';
  private roleId = '';
  private renderedConversation = '';
  private drafts = new Map<string, string>();
  private chosenScopes = new Map<string, EditScope>();
  private chosenModes = new Map<string, TaskMode>();
  private scrollPositions = new Map<string, number>();
  private boundBriefSession: Session | null = null;

  constructor(leaf: WorkspaceLeaf, private host: UIHost) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return '稿伴'; }
  getIcon(): string { return 'pencil-line'; }

  async onOpen(): Promise<void> {
    this.contentEl.empty(); this.contentEl.addClass('dc-sidebar');
    this.addAction('settings', '稿伴设置', () => this.host.openSettings());
    const header = this.contentEl.createDiv({ cls: 'dc-header' });
    header.createEl('strong', { text: '稿伴' });
    button(header, '设置', () => this.host.openSettings(), 'dc-text-button');
    button(header, '清空会话', () => this.confirmClear(), 'dc-text-button');
    const controls = this.contentEl.createDiv({ cls: 'dc-top-controls' });
    this.roleSelect = this.selectField(controls, '创作伙伴');
    this.roleSelect.addEventListener('change', () => { void this.perform(() => this.host.chooseRole(this.roleSelect.value)); });
    this.providerSelect = this.selectField(controls, '服务');
    this.providerSelect.addEventListener('change', () => {
      this.host.data.activeProviderId = this.providerSelect.value;
      void this.perform(() => this.host.saveSettings());
    });
    const modelField = controls.createEl('label', { cls: 'dc-field dc-model-field' });
    modelField.createEl('span', { text: '模型' });
    this.modelInput = modelField.createEl('input', { type: 'text', attr: { placeholder: '在设置中选择模型', 'aria-label': '当前模型（在设置中选择）', spellcheck: 'false', readonly: 'true' } });
    this.modelInput.addEventListener('click', () => this.host.openSettings());
    this.modelInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.host.openSettings(); } });
    this.modelInput.title = '点击打开设置，获取模型列表并选择模型';
    this.targetEl = this.contentEl.createDiv({ cls: 'dc-target' });
    this.contextEl = this.contentEl.createDiv({ cls: 'dc-context dc-small' });
    this.runningEl = this.contentEl.createDiv({ cls: 'dc-global-running', attr: { role: 'status' } });
    const brief = this.contentEl.createEl('details', { cls: 'dc-brief' });
    brief.createEl('summary', { text: '本文要求（可选）' });
    this.briefInput = brief.createEl('textarea', { attr: { placeholder: '读者、目的、语气、篇幅、明确保留或拒绝的要求……', 'aria-label': '本文创作要求', rows: '3' } });
    this.briefInput.addEventListener('input', () => { if (this.boundBriefSession) this.boundBriefSession.brief = this.briefInput.value; });
    this.briefInput.addEventListener('blur', () => { void this.perform(() => this.host.saveSettings()); });
    this.conversation = this.contentEl.createDiv({ cls: 'dc-conversation', attr: { 'aria-label': '本文会话' } });
    this.candidateEl = this.contentEl.createDiv({ cls: 'dc-candidate-bar' });
    this.quickTasks = this.contentEl.createDiv({ cls: 'dc-quick-tasks', attr: { 'aria-label': '快捷任务，只填入输入框' } });
    const composer = this.contentEl.createDiv({ cls: 'dc-composer' });
    const modeControls = composer.createDiv({ cls: 'dc-mode-controls' });
    this.modeSelect = this.selectField(modeControls, '方式');
    this.modeSelect.createEl('option', { text: '讨论', value: 'discuss' });
    this.modeSelect.createEl('option', { text: '改稿', value: 'edit' });
    this.modeSelect.addEventListener('change', () => { this.chosenModes.set(this.sessionId, this.modeSelect.value as TaskMode); this.refresh(); });
    this.scopeSelect = this.selectField(modeControls, '修改范围');
    this.scopeSelect.createEl('option', { text: '选中部分 / 正文（自动）', value: 'auto' });
    this.scopeSelect.createEl('option', { text: '正文', value: 'body' });
    this.scopeSelect.createEl('option', { text: '选中部分', value: 'selection' });
    this.scopeSelect.addEventListener('change', () => { this.chosenScopes.set(this.sessionId, this.scopeSelect.value as EditScope); this.refresh(); });
    this.input = composer.createEl('textarea', { cls: 'dc-input', attr: { placeholder: '和当前伙伴讨论，或说明你希望怎样修改……', rows: '4', 'aria-label': '发送给稿伴的内容' } });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; });
    this.input.addEventListener('input', () => { this.drafts.set(this.sessionId, this.input.value); this.updateButtons(); });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && !this.composing && event.keyCode !== 229) {
        event.preventDefault(); void this.send();
      }
    });
    const actions = composer.createDiv({ cls: 'dc-actions' });
    this.sendButton = button(actions, '发送', () => { void this.send(); }, 'mod-cta');
    this.stopButton = button(actions, '停止', () => { this.host.stop(); this.refresh(); });
    this.deleteButton = button(actions, '删除当前范围', () => { void this.performEdit(() => this.host.deleteRange(this.scopeSelect.value as EditScope)); });
    this.undoButton = button(actions, '撤回上次修改', () => { void this.performEdit(() => this.host.undo()); });
    composer.createEl('p', { text: 'Enter 换行 · ⌘ / Ctrl + Enter 发送', cls: 'dc-muted dc-small' });
    this.errorEl = composer.createDiv({ cls: 'dc-inline-status', attr: { role: 'alert' } });
    this.unsubscribe = this.host.subscribe(() => this.refresh()); this.refresh();
  }

  private selectField(parent: HTMLElement, title: string): HTMLSelectElement {
    const field = parent.createEl('label', { cls: 'dc-field' }); field.createEl('span', { text: title });
    return field.createEl('select', { attr: { 'aria-label': title } });
  }
  private fillSelect(select: HTMLSelectElement, options: { id: string; name: string }[], value: string, empty: string): void {
    const signature = JSON.stringify(options.map(item => [item.id, item.name]));
    if (select.dataset.options !== signature) {
      select.empty(); select.dataset.options = signature;
      if (!options.length) select.createEl('option', { text: empty, value: '' });
      for (const item of options) select.createEl('option', { text: item.name, value: item.id });
    }
    select.value = value;
  }
  private refresh(): void {
    if (!this.input) return;
    const session = this.host.currentSession(); const target = this.host.target(); const running = this.host.running;
    const id = session?.id || '';
    const role = this.host.data.roles.find(item => item.id === session?.selectedRoleId);
    const provider = this.host.data.providers.find(item => item.id === this.host.data.activeProviderId);
    if (id !== this.sessionId) {
      this.drafts.set(this.sessionId, this.input.value);
      this.scrollPositions.set(this.sessionId, this.conversation.scrollTop);
      this.sessionId = id;
      this.conversation.scrollTop = this.scrollPositions.get(id) || 0;
      this.input.value = this.drafts.get(id) || ''; this.boundBriefSession = session;
      this.briefInput.value = session?.brief || '';
      this.scopeSelect.value = this.chosenScopes.get(id) || 'auto';
      this.modeSelect.value = this.chosenModes.get(id) || session?.mode || role?.defaultMode || 'discuss';
      this.renderedConversation = ''; this.roleId = role?.id || '';
    } else if ((role?.id || '') !== this.roleId) {
      this.roleId = role?.id || ''; this.modeSelect.value = role?.defaultMode || 'discuss';
      this.chosenModes.set(id, this.modeSelect.value as TaskMode);
    }
    if (document.activeElement !== this.briefInput) this.briefInput.value = session?.brief || '';
    this.fillSelect(this.roleSelect, this.host.data.roles, session?.selectedRoleId || '', '请先添加伙伴');
    this.fillSelect(this.providerSelect, this.host.data.providers, this.host.data.activeProviderId, '请先配置服务');
    if (document.activeElement !== this.modelInput) this.modelInput.value = provider?.model || '';
    this.targetEl.setText(target ? `文稿：${target.path}` : '请聚焦一篇 Markdown 文稿');
    this.targetEl.title = target?.path || '侧栏始终绑定最近聚焦的文稿';
    const scopeLabel = this.scopeSelect.value === 'body' ? '正文' : this.scopeSelect.value === 'selection' ? '选中部分' : '选中部分 / 正文（自动）';
    this.contextEl.setText(provider ? `上下文：当前全文 · 修改范围：${scopeLabel}` : '在设置中添加兼容 OpenAI 聊天接口的服务。');
    this.contextEl.title = provider ? `每次发送本文最新全文至 ${provider.name}。双链、嵌入及其他笔记不会被读取。` : '';
    this.runningEl.empty();
    if (running && running.sessionId !== session?.id) {
      this.runningEl.createEl('span', { text: `正在生成：${running.path}` });
      button(this.runningEl, '停止该请求', () => this.host.stop());
    }
    this.renderConversation(session);
    this.renderCandidate(session);
    const taskSignature = JSON.stringify([role?.id, role?.quickTasks]);
    if (this.quickTasks.dataset.tasks !== taskSignature) {
      this.quickTasks.dataset.tasks = taskSignature; this.quickTasks.empty();
      if (role?.quickTasks.length) {
        const tasks = this.quickTasks.createEl('details');
        tasks.createEl('summary', { text: `快捷任务 · ${role.quickTasks.length}` });
        const grid = tasks.createDiv({ cls: 'dc-quick-grid' });
        for (const task of role.quickTasks) button(grid, task, () => {
          this.input.value = task; this.drafts.set(this.sessionId, task);
          if (['只起草当前选中部分', '改好当前选中的段落'].includes(task.replace(/[。.!！]+$/, '').trim())) {
            this.modeSelect.value = 'edit'; this.scopeSelect.value = 'selection';
            this.chosenModes.set(this.sessionId, 'edit'); this.chosenScopes.set(this.sessionId, 'selection');
          }
          this.refresh(); this.input.focus();
        }, 'dc-quick-task');
      }
    }
    this.roleSelect.disabled = !session || !this.host.data.roles.length;
    this.briefInput.disabled = !session;
    this.updateButtons();
  }

  private renderConversation(session: Session | null): void {
    const running = this.host.running?.sessionId === session?.id ? this.host.running : undefined;
    const signature = JSON.stringify([session?.id, session?.messages, running?.id, running?.text]);
    if (signature === this.renderedConversation) return;
    const changedSession = this.conversation.dataset.sessionId !== (session?.id || '');
    this.conversation.dataset.sessionId = session?.id || '';
    this.renderedConversation = signature;
    const nearBottom = this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 64;
    const oldScroll = this.conversation.scrollTop;
    this.conversation.empty();
    if (!session || (!session.messages.length && !running)) {
      const empty = this.conversation.createDiv({ cls: 'dc-empty' });
      empty.createEl('p', { text: session ? '从一个问题开始。选择伙伴，讨论后再生成修改候选。' : '打开并聚焦文稿后，稿伴会绑定它。' });
      empty.createEl('p', { text: '修改先预览，经你应用后写入；当前伙伴只处理这篇文稿。', cls: 'dc-muted dc-small' });
    }
    for (const message of session?.messages || []) {
      if (message.status === 'running') continue;
      const card = this.conversation.createDiv({ cls: `dc-message dc-message-${message.role}` });
      const name = message.role === 'user' ? '你' : message.role === 'event' ? '文稿记录' : message.roleName || '稿伴';
      const meta = [name, message.model, message.status === 'stopped' ? '已停止' : message.status === 'failed' ? '失败' : message.status === 'interrupted' ? '已中断' : ''].filter(Boolean).join(' · ');
      card.createDiv({ text: meta, cls: 'dc-message-meta' });
      if (message.role === 'assistant' && ['failed', 'stopped', 'interrupted'].includes(message.status || '')) {
        const raw = card.createEl('details', { cls: 'dc-raw-response' });
        raw.createEl('summary', { text: '查看原始 / 未完成回答（不可应用）' });
        raw.createEl('pre', { text: message.content, cls: 'dc-old-version' });
      } else {
        const body = card.createDiv({ cls: 'dc-message-content' }); renderSafeMarkdown(body, message.content);
      }
      if (message.candidateId) card.createDiv({ text: '候选材料 · 应用前不属于正文', cls: 'dc-candidate-label' });
      if (message.role === 'assistant' && message.content) {
        const copy = button(card, '复制回复', () => {
          if (copy.disabled) return; copy.disabled = true;
          void (async () => {
            try { await navigator.clipboard.writeText(message.content); copy.setText('已复制'); }
            catch { new Notice('复制未完成，请选中文字手动复制。'); copy.setText('复制回复'); }
            finally { copy.disabled = false; }
          })();
        }, 'dc-text-button dc-copy-message');
      }
    }
    if (running) {
      const card = this.conversation.createDiv({ cls: 'dc-message dc-message-assistant dc-streaming' });
      card.createDiv({ text: `${running.roleName} · 正在生成`, cls: 'dc-message-meta' });
      const body = card.createDiv({ cls: 'dc-message-content' });
      renderSafeMarkdown(body, running.mode === 'edit' ? '正在生成修改候选，完整返回并通过校验后可预览。' : running.text || '等待服务返回……');
    }
    this.conversation.scrollTop = changedSession ? this.scrollPositions.get(session?.id || '') || 0 : nearBottom ? this.conversation.scrollHeight : oldScroll;
  }
  private renderCandidate(session: Session | null): void {
    this.candidateEl.empty();
    if (session?.candidate) {
      const candidate = session.candidate;
      this.candidateEl.createEl('span', { text: `${candidate.deletion ? '删除候选' : '修改候选'} · ${stateLabels[candidate.state]}` });
      button(this.candidateEl, '预览差异', () => new CandidateModal(this.host, candidate, () => {
        this.modeSelect.value = 'edit'; this.input.value = '请继续调整刚才的候选：';
        this.chosenModes.set(this.sessionId, 'edit'); this.drafts.set(this.sessionId, this.input.value); this.updateButtons(); this.input.focus();
      }, this.app).open());
    }
    if (session?.undo) {
      const undo = session.undo;
      button(this.candidateEl, '查看上次修改前版本', () => new TextModal(this.app, '上次修改前版本（只读）', undo.path, undo.before).open(), 'dc-text-button');
    }
  }
  private updateButtons(): void {
    if (!this.sendButton) return;
    const session = this.host.currentSession(); const provider = this.host.data.providers.find(item => item.id === this.host.data.activeProviderId);
    this.sendButton.disabled = !session || !provider?.model.trim() || !this.input.value.trim() || !!this.host.running || this.sending || this.editingBusy;
    this.stopButton.disabled = !this.host.running;
    this.deleteButton.disabled = !session || !!this.host.running || this.sending || this.editingBusy;
    this.undoButton.disabled = !session?.undo || !!this.host.running || this.sending || this.editingBusy;
    this.scopeSelect.disabled = this.modeSelect.value !== 'edit';
    this.sendButton.setText(this.sending || this.host.running ? '正在生成' : this.modeSelect.value === 'edit' ? '生成修改候选' : '发送讨论');
  }
  private async send(): Promise<void> {
    if (this.sendButton.disabled || this.composing) return;
    const text = this.input.value.trim(); const id = this.sessionId;
    this.sending = true; this.errorEl.empty(); this.updateButtons();
    try {
      // Keep the draft while generating. Clear only if the user has not changed it and the same document is visible.
      await this.host.send(text, this.modeSelect.value as TaskMode, this.scopeSelect.value as EditScope);
      if ((this.drafts.get(id) || '').trim() === text) this.drafts.set(id, '');
      if (id === this.sessionId && this.input.value.trim() === text) { this.input.value = ''; this.drafts.set(id, ''); }
    } catch (error) { this.errorEl.setText(errorText(error)); this.errorEl.addClass('dc-error'); }
    finally { this.sending = false; this.refresh(); }
  }
  private async performEdit(action: () => Promise<void>): Promise<void> {
    if (this.editingBusy) return;
    this.editingBusy = true; this.updateButtons();
    try { await this.perform(action); } finally { this.editingBusy = false; this.refresh(); }
  }
  private async perform(action: () => Promise<void>): Promise<void> {
    this.errorEl?.empty();
    try { await action(); } catch (error) { this.errorEl?.setText(errorText(error)); this.errorEl?.addClass('dc-error'); new Notice(errorText(error)); }
    this.refresh();
  }
  private confirmClear(): void {
    const session = this.host.currentSession(); if (!session) return;
    const modal = new Modal(this.app); modal.titleEl.setText('清空当前文稿的会话');
    modal.contentEl.createEl('p', { text: `${session.document.path}\n本文要求和上次撤回记录会保留，文稿不会删除。` });
    button(modal.contentEl, '清空会话', () => {
      if (this.host.currentSession()?.id !== session.id) { new Notice('目标文稿已切换，请重新操作。'); modal.close(); return; }
      void this.perform(() => this.host.clearSession()); modal.close();
    }, 'mod-warning');
    button(modal.contentEl, '取消', () => modal.close()); modal.open();
  }
  async onClose(): Promise<void> { this.unsubscribe?.(); this.unsubscribe = undefined; this.contentEl.empty(); }
}
