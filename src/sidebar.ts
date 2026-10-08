import { ItemView, Modal, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import { diffLines } from 'diff';
import type { Candidate, EditScope, Session, TaskMode } from './types';
import type { UIHost } from './ui-host';
import { renderSafeMarkdown } from './render';
import { renderStoredMessage } from './message-render';
import type { AgentTask } from './agent-types';
import { currentVersion, type ReviewRun, type Suggestion } from './review-types';
import { bodyStart } from './editing';

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
function diagnosticText(text: string): string {
  return text.replace(/(?:Authorization\s*[:=]\s*|Bearer\s+)[^\s,;]+/gi, '[凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[凭据已隐藏]').slice(0, 600);
}
const errorLabels: Record<string, string> = {
  auth: '鉴权失败', permission: '没有访问权限', 'rate-limit': '请求过于频繁', quota: '服务额度不足',
  connection: '连接失败', timeout: '请求超时', 'model-unavailable': '模型不可用', format: '结果格式不正确',
  context: '内容超过模型容量', unsupported: '服务不支持请求参数', service: '服务暂时不可用',
  cancelled: '已停止', 'empty-document': '正文为空',
  'empty-output': '模型没有返回内容', truncated: '回复未完整生成', refusal: '模型拒绝了本次审阅',
  interrupted: '审阅已中断',
};

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
  private roleButton!: HTMLButtonElement; private modelButton!: HTMLButtonElement;
  private clearButton!: HTMLButtonElement;
  private targetEl!: HTMLElement; private selectionEl!: HTMLElement; private runningEl!: HTMLElement;
  private dailyButton!: HTMLButtonElement; private dailyStatusEl!: HTMLElement; private dailyStatusLabel!: HTMLElement;
  private brief!: HTMLDetailsElement; private briefInput!: HTMLTextAreaElement; private reader!: HTMLElement; private tabs!: HTMLElement; private chatTab!: HTMLButtonElement; private reviewTab!: HTMLButtonElement;
  private moreButton!: HTMLButtonElement; private taskTag!: HTMLButtonElement; private moreMenu?: HTMLElement; private moreMenuCleanup?: () => void;
  private roleMenu?: HTMLElement; private roleMenuCleanup?: () => void;
  private moreMenuSessionId = ''; private moreMenuRoleId = '';
  private input!: HTMLTextAreaElement; private sendButton!: HTMLButtonElement; private stopButton!: HTMLButtonElement; private undoWholeButton?: HTMLButtonElement; private errorEl!: HTMLElement;
  private currentTab = new Map<string, 'chat' | 'review'>(); private drafts = new Map<string, string>();
  private scrollPositions = new Map<string, number>(); private modes = new Map<string, TaskMode>(); private scopes = new Map<string, EditScope>(); private tasks = new Map<string, AgentTask>();
  private closedTabs = new Map<string, Set<'review'>>();
  private selectedSuggestions = new Map<string, string | undefined>();
  private replyDrafts = new Map<string, string>(); private replyOpen = new Set<string>();
  private sessionId = ''; private composerKey = ''; private readerKey = ''; private composing = false; private busy = false; private boundBriefSession: Session | null = null;
  private readerSignature = ''; private readerRunningId = '';
  private closed = false;

  constructor(leaf: WorkspaceLeaf, private host: UIHost) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; } getDisplayText(): string { return '稿伴'; } getIcon(): string { return 'pencil-line'; }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty(); this.contentEl.addClass('dc-sidebar'); this.addAction('settings', '稿伴设置', () => this.host.openSettings());
    const header = this.contentEl.createDiv({ cls: 'dc-header' }); header.createEl('strong', { text: '稿伴' });
    this.tabs = header.createDiv({ cls: 'dc-tabs', attr: { role: 'tablist', 'aria-label': '稿伴阅读内容' } });
    this.clearButton = button(header, '清空对话', () => this.confirmClear(), 'dc-text-button dc-header-clear');
    this.clearButton.title = '清空当前文稿的所有聊天记录和输入内容';
    this.clearButton.setAttribute('aria-label', '清空当前对话');
    const headerMore = button(header, '⋯', () => this.host.openSettings(), 'dc-text-button dc-header-more');
    headerMore.setAttribute('aria-label', '打开稿伴设置'); headerMore.title = '设置';
    const documentMeta = this.contentEl.createDiv({ cls: 'dc-document-meta' });
    this.targetEl = documentMeta.createDiv({ cls: 'dc-target' }); this.selectionEl = documentMeta.createDiv({ cls: 'dc-context dc-small' });
    this.dailyButton = button(documentMeta, '立即选题', () => {
      const status=this.host.dailyStatus?.();
      if(status && ['queued','collecting','screening','reading','preparing','committing'].includes(status.status))this.host.stopDailyTopics?.();
      else void this.perform(async()=>{
        try { await this.host.startDailyTopics?.(); }
        catch(error){this.host.openSettings();throw error;}
      });
    }, 'dc-daily-start');
    this.dailyButton.title='采集公开来源，筛选后写入已绑定的选题库';
    this.dailyStatusEl=this.contentEl.createDiv({cls:'dc-daily-status',attr:{role:'status','aria-live':'polite'}});
    this.dailyStatusEl.hidden=true;
    this.dailyStatusLabel=this.dailyStatusEl.createEl('span');
    button(this.dailyStatusEl,'查看',()=>this.host.openDailyResult?.(),'dc-text-button');
    this.runningEl = this.contentEl.createDiv({ cls: 'dc-global-running', attr: { role: 'status' } });
    this.brief = this.contentEl.createEl('details', { cls: 'dc-brief', attr: { hidden: 'true' } }); this.brief.createEl('summary', { text: '本文要求（可选）' });
    this.briefInput = this.brief.createEl('textarea', { attr: { rows: '3', 'aria-label': '本文创作要求', placeholder: '读者、目的、语气、篇幅、保留或拒绝的要求……' } });
    this.briefInput.addEventListener('input', () => { if (this.boundBriefSession) this.boundBriefSession.brief = this.briefInput.value; });
    this.briefInput.addEventListener('blur', () => void this.perform(() => this.host.saveSettings()));
    this.reader = this.contentEl.createDiv({ cls: 'dc-reader', attr: { 'aria-live': 'polite' } });
    const composer = this.contentEl.createDiv({ cls: 'dc-composer' });
    this.input = composer.createEl('textarea', { cls: 'dc-input', attr: { rows: '2', 'aria-label': '发送给稿伴的内容', placeholder: '输入你的问题、要求或待处理材料…' } });
    this.input.addEventListener('compositionstart', () => { this.composing = true; }); this.input.addEventListener('compositionend', () => { this.composing = false; });
    this.input.addEventListener('input', () => { this.drafts.set(this.composerKey || this.stateKey(), this.input.value); this.resizeInput(); this.updateButtons(); });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && !this.composing && event.keyCode !== 229) {
        event.preventDefault(); if (this.host.running) { this.host.stop(); this.refresh(); } else void this.send();
      }
    });
    const controls = composer.createDiv({ cls: 'dc-composer-controls' });
    this.moreButton = button(controls, '＋', () => this.toggleMoreMenu(), 'dc-more-button');
    this.moreButton.setAttribute('aria-label', '选择任务或更多操作'); this.moreButton.setAttribute('aria-haspopup', 'menu'); this.moreButton.setAttribute('aria-expanded', 'false');
    this.taskTag = button(controls, '', () => { this.setTask('auto'); this.taskTag.hidden = true; this.input.focus(); }, 'dc-task-tag');
    this.taskTag.title = '关闭本轮任务，恢复自动判断'; this.taskTag.hidden = true;
    this.roleButton = button(controls, '选择伙伴', () => this.toggleRoleMenu(), 'dc-role-model-button');
    this.roleButton.setAttribute('aria-haspopup', 'menu'); this.roleButton.setAttribute('aria-expanded', 'false');
    this.modelButton = button(controls, '选择模型', () => this.toggleRoleMenu(), 'dc-role-model-button');
    this.modelButton.setAttribute('aria-haspopup', 'menu'); this.modelButton.setAttribute('aria-expanded', 'false');
    this.sendButton = button(controls, '', () => void this.send(), 'mod-cta dc-icon-action'); setIcon(this.sendButton, 'arrow-up');
    this.stopButton = button(controls, '', () => { this.host.stop(); this.refresh(); }, 'dc-icon-action'); setIcon(this.stopButton, 'square');
    this.sendButton.setAttribute('aria-label', '发送'); this.sendButton.title = '发送'; this.stopButton.setAttribute('aria-label', '停止生成'); this.stopButton.title = '停止生成';
    this.errorEl = composer.createDiv({ cls: 'dc-inline-status', attr: { role: 'alert' } });
    this.unsubscribe = this.host.subscribe(() => this.refresh()); this.refresh();
  }
  private task(): AgentTask { return this.tasks.get(this.sessionId) || 'auto'; }
  private setTask(task: AgentTask, scope?: EditScope): void { this.tasks.set(this.sessionId, task); if (scope) this.scopes.set(this.sessionId, scope); this.updateButtons(); }
  private taskLabel(task = this.task()): string {
    return ({ auto: '自动', discuss: '讨论', review: '审阅', propose: '改稿建议', execute: '执行工具', topic: '选题', titles: '标题', outline: '大纲' } as Record<AgentTask, string>)[task];
  }
  private taskTemplate(task: AgentTask, scope?: EditScope): string | undefined {
    if (task === 'review') return scope === 'selection' ? '请审阅当前选区，指出最重要的问题。' : '请审阅这篇文稿，优先指出最重要的问题。';
    if (task === 'topic') return '从当前选题库或已绑定的选题库按读者价值和材料充分程度选择值得写的未勾选项目，不凑数，没有合适的可以不选。先确定本轮选择集合，再只改变这些项目的复选框。理由、一句话切入角度、首推标题和四个不同角度的备选标题只放在侧栏。';
    if (task === 'titles') return '请为当前文稿给出 10 个标题，覆盖清晰、好奇和收益三种取向，并说明最推荐的一条。';
    if (task === 'outline') return '请为当前主题拟一个可直接写作的大纲：标题、开头、三个核心段落和结尾。';
    if (task === 'propose') return scope === 'selection' ? '请针对当前选区提出一版可采纳的改稿建议，保留原意和作者口吻。' : '请针对这篇文稿提出最重要的一版改稿建议，保留原意和作者口吻。';
    return undefined;
  }
  private renderTabs(pending: number): void {
    this.tabs.empty(); const closed = this.closedTabs.get(this.sessionId) || new Set<'review'>();
    this.chatTab = button(this.tabs, '对话', () => this.setTab('chat'), 'dc-reader-tab');
    if (!closed.has('review')) {
      const review = this.tabs.createDiv({ cls: 'dc-reader-tab-wrap' }); this.reviewTab = button(review, `批注 ${pending}`, () => this.setTab('review'), 'dc-reader-tab');
      button(review, '×', () => { closed.add('review'); this.closedTabs.set(this.sessionId, closed); if (this.tab() === 'review') this.currentTab.set(this.sessionId, 'chat'); this.refresh(); }, 'dc-close-tab');
    } else this.reviewTab = this.chatTab;
    this.chatTab.classList.toggle('is-active', this.tab() === 'chat'); this.reviewTab.classList.toggle('is-active', this.tab() === 'review');
    this.chatTab.setAttribute('aria-selected', String(this.tab() === 'chat')); this.reviewTab.setAttribute('aria-selected', String(this.tab() === 'review'));
  }
  private showReviewTab(): void { const closed = this.closedTabs.get(this.sessionId); closed?.delete('review'); this.currentTab.set(this.sessionId, 'review'); this.refresh(); }
  private tab(): 'chat' | 'review' { return this.currentTab.get(this.sessionId) || 'chat'; }
  private stateKey(tab = this.tab()): string { return `${this.sessionId}:${tab}`; }
  private setTab(tab: 'chat' | 'review'): void {
    if (this.tab() === tab) return;
    this.drafts.set(this.composerKey || this.stateKey(), this.input.value);
    this.scrollPositions.set(this.readerKey || this.stateKey(), this.reader.scrollTop);
    this.currentTab.set(this.sessionId, tab); this.refresh();
  }
  private toggleMoreMenu(): void {
    if (this.moreMenu) { this.closeMoreMenu(true); return; }
    this.openMoreMenu();
  }
  /**
   * The secondary actions deliberately live in a temporary, fixed popover rather
   * than in the sidebar flex flow. A long task name must never hide Send/Stop.
   */
  private openMoreMenu(): void {
    this.closeMoreMenu(false); this.closeRoleMenu(false);
    const doc = this.contentEl.ownerDocument;
    const menu = doc.createElement('div');
    const menuId = `draft-companion-more-${Math.random().toString(36).slice(2)}`;
    menu.id = menuId; menu.className = 'dc-secondary-popover'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '更多操作');
    menu.style.visibility = 'hidden';
    const role = this.host.data.roles.find(item => item.id === this.host.currentSession()?.selectedRoleId);
    const addItem = (label: string, action: () => void, extra = ''): HTMLButtonElement => {
      const item = button(menu, label, () => { this.closeMoreMenu(false); action(); }, `dc-secondary-item ${extra}`);
      item.setAttribute('role', 'menuitem'); return item;
    };
    menu.createDiv({ cls: 'dc-secondary-heading', text: '本轮任务' });
    const tasks: [AgentTask, string, EditScope?][] = [
      ['auto', '自动判断'], ['discuss', '讨论'], ['review', '审阅全文'], ['propose', '生成改稿建议'],
      ['topic', '选题'], ['titles', '标题'], ['outline', '大纲'], ['propose', '选区改稿', 'selection'], ['propose', '整篇改稿', 'body'],
    ];
    for (const [task, label, scope] of tasks) addItem(`${this.task() === task && (!scope || this.editScope() === scope) ? '✓ ' : ''}${label}`, () => {
      this.setTask(task, scope);
      if (task === 'review') this.showReviewTab();
      const template = this.taskTemplate(task, scope);
      if (template && !this.input.value.trim()) {
        this.input.value = template; this.drafts.set(this.composerKey || this.stateKey(), template); this.resizeInput(); this.updateButtons();
      }
      this.input.focus();
    }, 'dc-task-item');
    menu.createDiv({ cls: 'dc-secondary-divider', attr: { role: 'separator' } });
    if (role?.quickTasks.length) {
      menu.createDiv({ cls: 'dc-secondary-heading', text: '快捷任务' });
      for (const task of role.quickTasks) addItem(task, () => {
        this.input.value = task; this.drafts.set(this.composerKey || this.stateKey(), task);
        if (/选中/.test(task)) this.prepareEdit('selection');
        else { this.resizeInput(); this.updateButtons(); this.input.focus(); }
      }, 'dc-quick-task');
      menu.createDiv({ cls: 'dc-secondary-divider', attr: { role: 'separator' } });
    }
    menu.createDiv({ cls: 'dc-secondary-heading', text: '本文' });
    addItem('本文要求', () => { this.brief.hidden = false; this.brief.open = true; this.briefInput.focus(); });
    addItem('对话历史', () => this.setTab('chat'));
    addItem('查看批注', () => this.showReviewTab());
    addItem('绑定选题库', () => void this.perform(() => this.host.bindTopicLibrary()));
    addItem('每日选题记录', () => this.host.openDailyResult?.());
    addItem('清空对话', () => this.confirmClear());
    menu.createDiv({ cls: 'dc-secondary-divider', attr: { role: 'separator' } });
    menu.createDiv({ cls: 'dc-secondary-heading', text: '候选与撤回' });
    addItem('删除当前范围', () => void this.perform(() => this.host.deleteRange(this.editScope())), 'dc-danger-item');
    const localAction = [...this.host.agentActions()].reverse().find(action => this.host.canUndoAgentAction(action.id));
    const undoLocal = addItem('撤回最近局部修改', () => { if (localAction) void this.perform(() => this.host.undoAgentAction(localAction.id)); });
    undoLocal.disabled = !localAction || !!this.host.running || this.busy;
    this.undoWholeButton = addItem('撤回上次整篇修改', () => void this.perform(() => this.host.undo()));
    this.undoWholeButton.disabled = !this.host.canUndoWhole() || !!this.host.running || this.busy;
    doc.body.appendChild(menu); this.moreMenu = menu; this.moreMenuSessionId = this.sessionId; this.moreMenuRoleId = role?.id || '';
    this.moreButton.setAttribute('aria-controls', menuId); this.moreButton.setAttribute('aria-expanded', 'true');
    const rect = this.moreButton.getBoundingClientRect();
    const maxWidth = Math.max(190, Math.min(340, doc.documentElement.clientWidth - 16));
    menu.style.maxWidth = `${maxWidth}px`; menu.style.minWidth = `${Math.min(Math.max(rect.width, 190), maxWidth)}px`;
    const menuHeight = menu.getBoundingClientRect().height;
    const top = Math.max(8, Math.min(rect.top - menuHeight - 6, doc.documentElement.clientHeight - menuHeight - 8));
    const left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - maxWidth - 8));
    menu.style.top = `${top}px`; menu.style.left = `${left}px`; menu.style.visibility = '';
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && !menu.contains(target) && target !== this.moreButton && !this.moreButton.contains(target)) this.closeMoreMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); this.closeMoreMenu(true); return; }
      const active = doc.activeElement as HTMLElement | null;
      if (!active || !menu.contains(active)) return;
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'));
      const index = items.indexOf(active as HTMLButtonElement);
      if (index < 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const destination = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[destination]?.focus(); return;
      }
      if (event.key === 'Tab' && ((!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0))) setTimeout(() => this.closeMoreMenu(false), 0);
    };
    const onResize = (): void => this.closeMoreMenu(false);
    doc.addEventListener('pointerdown', onPointerDown, true); doc.addEventListener('keydown', onKeyDown, true); doc.defaultView?.addEventListener('resize', onResize);
    this.moreMenuCleanup = () => {
      doc.removeEventListener('pointerdown', onPointerDown, true); doc.removeEventListener('keydown', onKeyDown, true); doc.defaultView?.removeEventListener('resize', onResize);
    };
    const focusFirst = () => { if (this.moreMenu === menu) menu.querySelector<HTMLButtonElement>('button')?.focus(); };
    if (doc.defaultView?.requestAnimationFrame) doc.defaultView.requestAnimationFrame(focusFirst); else setTimeout(focusFirst, 0);
  }
  private closeMoreMenu(returnFocus: boolean): void {
    this.moreMenuCleanup?.(); this.moreMenuCleanup = undefined;
    this.moreMenu?.remove(); this.moreMenu = undefined; this.undoWholeButton = undefined; this.moreMenuSessionId = ''; this.moreMenuRoleId = '';
    if (this.moreButton) { this.moreButton.removeAttribute('aria-controls'); this.moreButton.setAttribute('aria-expanded', 'false'); if (returnFocus) this.moreButton.focus(); }
  }
  private toggleRoleMenu(): void { if (this.roleMenu) this.closeRoleMenu(true); else this.openRoleMenu(); }
  private openRoleMenu(): void {
    this.closeRoleMenu(false); this.closeMoreMenu(false); const doc = this.contentEl.ownerDocument;
    const menu = doc.createElement('div'); const menuId = `draft-companion-role-model-${Math.random().toString(36).slice(2)}`;
    menu.id = menuId; menu.className = 'dc-role-model-popover'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '伙伴与模型'); menu.style.visibility = 'hidden';
    menu.createDiv({ cls: 'dc-secondary-heading', text: '创作伙伴' });
    for (const role of this.host.data.roles) {
      const item = button(menu, role.name, () => { this.closeRoleMenu(false); void this.perform(() => this.host.chooseRole(role.id)); }, 'dc-secondary-item');
      item.setAttribute('role', 'menuitem'); if (role.id === this.host.currentSession()?.selectedRoleId) item.createEl('span', { text: ' 当前', cls: 'dc-muted' });
    }
    menu.createDiv({ cls: 'dc-secondary-divider', attr: { role: 'separator' } });
    const provider = this.host.data.providers.find(item => item.id === this.host.data.activeProviderId);
    menu.createDiv({ cls: 'dc-secondary-heading', text: provider?.name ? `模型 · ${provider.name}` : '模型' });
    if (provider?.model) {
      const current = button(menu, `当前：${provider.model}`, () => undefined, 'dc-secondary-item');
      current.setAttribute('role', 'menuitem'); current.disabled = true;
    }
    const modelList = menu.createDiv({ cls: 'dc-role-model-list' });
    if (provider?.baseUrl.trim()) {
      modelList.createEl('span', { text: '正在读取可用模型…', cls: 'dc-muted dc-small' });
      void this.host.models(provider).then(models => {
        if (this.roleMenu !== menu) return;
        modelList.empty();
        if (!models.length) { modelList.createEl('span', { text: '服务没有返回模型列表。', cls: 'dc-muted dc-small' }); return; }
        for (const model of models.slice(0, 12)) {
          const item = button(modelList, model.id, () => {
            provider.model = model.id; this.closeRoleMenu(false); void this.perform(() => this.host.saveSettings());
          }, 'dc-secondary-item');
          item.setAttribute('role', 'menuitem'); item.toggleClass('is-current', model.id === provider.model);
        }
      }).catch(() => {
        if (this.roleMenu === menu) { modelList.empty(); modelList.createEl('span', { text: '暂时无法读取模型列表，可在设置中手动填写。', cls: 'dc-muted dc-small' }); }
      });
    } else modelList.createEl('span', { text: '先在设置中配置 API 根地址。', cls: 'dc-muted dc-small' });
    const settings = button(menu, '管理服务与模型', () => { this.closeRoleMenu(false); this.host.openSettings(); }, 'dc-secondary-item'); settings.setAttribute('role', 'menuitem');
    doc.body.appendChild(menu); this.roleMenu = menu;
    this.roleButton.setAttribute('aria-controls', menuId); this.modelButton.setAttribute('aria-controls', menuId);
    this.roleButton.setAttribute('aria-expanded', 'true'); this.modelButton.setAttribute('aria-expanded', 'true');
    const rect = this.roleButton.getBoundingClientRect(), maxWidth = Math.max(190, Math.min(320, doc.documentElement.clientWidth - 16));
    menu.style.maxWidth = `${maxWidth}px`; menu.style.minWidth = `${Math.min(Math.max(rect.width, 190), maxWidth)}px`;
    const height = menu.getBoundingClientRect().height;
    menu.style.left = `${Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - maxWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.top - height - 6, doc.documentElement.clientHeight - height - 8))}px`; menu.style.visibility = '';
    const outside = (event: PointerEvent) => { const target = event.target as Node | null; if (target && !menu.contains(target) && !this.roleButton.contains(target) && !this.modelButton.contains(target)) this.closeRoleMenu(false); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); this.closeRoleMenu(true); return; }
      const active = doc.activeElement as HTMLElement | null;
      if (!active || !menu.contains(active)) return;
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'));
      const index = items.indexOf(active as HTMLButtonElement);
      if (index < 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[next]?.focus(); return;
      }
      if (event.key === 'Tab' && ((!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0))) setTimeout(() => this.closeRoleMenu(false), 0);
    };
    const resize = () => this.closeRoleMenu(false);
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', keyboard, true); doc.defaultView?.addEventListener('resize', resize);
    this.roleMenuCleanup = () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', keyboard, true); doc.defaultView?.removeEventListener('resize', resize); };
    const focusFirst = () => { if (this.roleMenu === menu) menu.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus(); };
    if (doc.defaultView?.requestAnimationFrame) doc.defaultView.requestAnimationFrame(focusFirst); else setTimeout(focusFirst, 0);
  }
  private closeRoleMenu(returnFocus: boolean): void {
    this.roleMenuCleanup?.(); this.roleMenuCleanup = undefined; this.roleMenu?.remove(); this.roleMenu = undefined;
    this.roleButton?.removeAttribute('aria-controls'); this.modelButton?.removeAttribute('aria-controls');
    this.roleButton?.setAttribute('aria-expanded', 'false'); this.modelButton?.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.roleButton?.focus();
  }
  private mode(): TaskMode { return this.modes.get(this.sessionId) || this.host.currentSession()?.mode || 'discuss'; }
  private editScope(): EditScope { return this.scopes.get(this.sessionId) || 'auto'; }
  private refresh(): void {
    if (!this.input || this.closed) return;
    const session = this.host.currentSession(); const target = this.host.target(); const provider = this.host.data.providers.find(item => item.id === this.host.data.activeProviderId); const role = this.host.data.roles.find(item => item.id === session?.selectedRoleId);
    const previous = this.sessionId;
    if (this.composerKey) this.drafts.set(this.composerKey, this.input.value);
    if (this.readerKey) this.scrollPositions.set(this.readerKey, this.reader.scrollTop);
    this.sessionId = session?.id || '';
    if (this.moreMenu && (this.moreMenuSessionId !== this.sessionId || this.moreMenuRoleId !== (role?.id || ''))) this.closeMoreMenu(false);
    // Role/model choices belong to the document currently shown; host updates never
    // leave an old popover attached to a newly selected document or role.
    if (this.roleMenu) this.closeRoleMenu(false);
    if (previous !== this.sessionId) { this.boundBriefSession = session; this.briefInput.value = session?.brief || ''; }
    if (this.currentTab.get(this.sessionId) === 'review' && this.closedTabs.get(this.sessionId)?.has('review')) this.currentTab.set(this.sessionId, 'chat');
    const selected = session?.review?.selectedId;
    if (selected && this.selectedSuggestions.get(this.sessionId) !== selected) {
      this.closedTabs.get(this.sessionId)?.delete('review'); this.currentTab.set(this.sessionId, 'review');
    }
    this.selectedSuggestions.set(this.sessionId, selected);
    const composerKey = this.stateKey();
    if (composerKey !== this.composerKey) { this.input.value = this.drafts.get(composerKey) || ''; this.composerKey = composerKey; }
    if (this.briefInput.ownerDocument.activeElement !== this.briefInput) this.briefInput.value = session?.brief || '';
    const selectedRole = this.host.data.roles.find(item => item.id === session?.selectedRoleId);
    const shortModel = provider?.model ? (provider.model.length > 24 ? `${provider.model.slice(0, 21)}…` : provider.model) : '选择模型';
    this.roleButton.setText(selectedRole?.name || '选择伙伴'); this.roleButton.title = selectedRole?.description || '点击管理创作伙伴';
    this.modelButton.setText(shortModel); this.modelButton.title = provider ? `${provider.name} · ${provider.model}\n点击管理服务与模型` : '点击配置服务与模型';
    const name = target?.path.split('/').at(-1) || ''; this.targetEl.setText(target ? `文稿：${name}` : '请聚焦一篇 Markdown 文稿'); this.targetEl.title = target?.path || '';
    const selection = this.host.selectionSummary(); this.selectionEl.setText(selection.kind === 'selection' ? `选中 ${selection.characters} 字` : selection.kind === 'multiple' ? '多选区，请只保留一处选区' : '全文');
    this.selectionEl.title = provider ? `当前模型：${provider.name} / ${provider.model}\n每次请求只发送当前文稿快照。` : '请先在设置中配置模型。';
    const daily=this.host.dailyStatus?.(), dailyActive=!!daily && ['queued','collecting','screening','reading','preparing','committing'].includes(daily.status);
    this.dailyButton.setText(dailyActive ? daily?.status==='queued'?'取消排队':'停止' : '立即选题');
    this.dailyButton.setAttribute('aria-label',dailyActive ? '停止自动选题' : '立即选题');
    this.dailyButton.disabled=!this.host.startDailyTopics;
    // Sidebar focus can refresh between mousedown and click; keep this action's node alive.
    this.dailyStatusEl.hidden=!daily;
    this.dailyStatusEl.classList.toggle('is-error',daily?.status==='failed');
    const dailyLabel=daily ? dailyActive ? `${daily.stage} · ${daily.path?.split('/').at(-1) || '选题库'}` : daily.message || daily.error || daily.stage : '';
    if(this.dailyStatusLabel.textContent!==dailyLabel)this.dailyStatusLabel.setText(dailyLabel);
    this.dailyStatusLabel.title=daily?.path || '';
    this.runningEl.empty(); if (this.host.running?.origin !== 'daily' && this.host.running && this.host.running.sessionId !== session?.id) { this.runningEl.createEl('span', { text: `${this.host.running.path} 正在生成` }); button(this.runningEl, '停止', () => this.host.stop()); }
    // A menu is intentionally rebuilt only when opened. Keeping its long list out of
    // this flex column prevents pasted text or expanded quick tasks from pushing the
    // primary send control outside the sidebar.
    const pending = session?.review?.suggestions.filter(item => item.state !== 'applied' && item.state !== 'ignored').length || 0;
    this.renderTabs(pending);
    const readerKey = this.stateKey(); const readerChanged = readerKey !== this.readerKey;
    const signature = this.readerStateSignature(session);
    const activeRunning = this.host.running?.origin === 'daily' ? undefined : this.host.running;
    const runningId = activeRunning && (activeRunning.sessionId === session?.id || activeRunning.documentId === session?.document.id) ? activeRunning.id : '';
    const patched = !readerChanged && signature === this.readerSignature && runningId === this.readerRunningId && this.patchReaderStream(session);
    if (!patched) this.renderReader(session);
    this.readerSignature = signature; this.readerRunningId = runningId;
    this.contentEl.classList.toggle('dc-reader-is-empty', !!this.reader.querySelector('.dc-empty'));
    if (readerChanged) this.reader.scrollTop = this.scrollPositions.get(readerKey) || 0; this.readerKey = readerKey; this.resizeInput(); this.updateButtons();
  }
  /**
   * This deliberately excludes RunningRequest.text. Provider chunks are the only
   * high-frequency state, so they can update one text node without replacing
   * history (and therefore without losing a reading selection).
   */
  private readerStateSignature(session: Session | null): string {
    const provider = this.host.data.providers.find(item => item.id === this.host.data.activeProviderId);
    const reviewBodyEmpty = this.tab() === 'review' ? this.bodyIsEmpty() : false;
    return JSON.stringify({
      tab: this.tab(), session: session?.id || '', role: session?.selectedRoleId || '',
      provider: provider ? [provider.id, provider.baseUrl, provider.model] : [],
      messages: session?.messages.map(message => [message.id, message.role, message.content, message.status, message.candidateId, message.presentation, message.actionIds]) || [],
      candidate: session?.candidate ? [session.candidate.id, session.candidate.state, session.candidate.deletion] : [],
      receipts: session?.agentActions?.map(receipt => [receipt.id, receipt.state, receipt.label, receipt.invalidReason]) || [],
      review: this.tab() === 'review' ? session?.review : undefined, reviewBodyEmpty,
    });
  }
  private streamText(running: NonNullable<UIHost['running']>): string {
    return running.mode === 'review' ? '正在生成批注，完整校验后才会显示操作。'
      : running.mode === 'edit' ? '正在生成修改候选，完整返回并通过校验后可预览。'
        : running.text || running.stage || '等待服务返回……';
  }
  /** Returns false when the reader’s structural state changed and needs a rerender. */
  private patchReaderStream(session: Session | null): boolean {
    if (this.tab() === 'review') return true; // Review chunks are intentionally never exposed before validation.
    const running = this.host.running?.origin !== 'daily' && this.host.running?.sessionId === session?.id ? this.host.running : undefined;
    const streaming = this.reader.querySelector<HTMLElement>('.dc-streaming');
    if (!running) return !streaming;
    const content = streaming?.querySelector<HTMLElement>('.dc-message-content');
    if (!content) return false;
    const next = this.streamText(running);
    if (content.textContent !== next) content.textContent = next;
    return true;
  }
  private renderReader(session: Session | null): void {
    const nearBottom = this.reader.scrollHeight - this.reader.scrollTop - this.reader.clientHeight < 64; const old = this.reader.scrollTop;
    const active = this.reader.ownerDocument.activeElement as HTMLElement | null;
    const focusedReplyId = active?.dataset.suggestionId;
    this.reader.empty();
    if (this.tab() === 'chat') this.renderConversation(session); else this.renderReview(session);
    if (focusedReplyId) {
      const restored = Array.from(this.reader.querySelectorAll<HTMLTextAreaElement>('textarea[data-suggestion-id]')).find(node => node.dataset.suggestionId === focusedReplyId);
      restored?.focus({ preventScroll: true });
    }
    this.reader.scrollTop = nearBottom ? this.reader.scrollHeight : old;
  }
  private renderConversation(session: Session | null): void {
    const running = this.host.running?.origin !== 'daily' && this.host.running?.sessionId === session?.id ? this.host.running : undefined;
    if (!session || (!session.messages.length && !running)) this.reader.createDiv({ text: session ? '从一个问题开始。讨论、改稿候选和历史会留在本文。' : '打开并聚焦文稿后，稿伴会绑定它。', cls: 'dc-empty' });
    let previousAssistantIdentity = '';
    for (const message of session?.messages || []) {
      if (message.status === 'running') continue;
      const card = this.reader.createDiv({ cls: `dc-message dc-message-${message.role}` });
      const status = message.status === 'failed' ? '失败' : message.status === 'stopped' ? '已停止' : message.status === 'interrupted' ? '已中断' : '';
      const assistantIdentity = [message.roleName || '稿伴', message.providerName, message.model].filter(Boolean).join(' · ');
      const provenance = [message.providerName, message.model].filter(Boolean).join(' · ');
      const label = message.role === 'user' ? '你' : message.role === 'event' ? '文稿记录' : message.roleName || '稿伴';
      const meta = card.createDiv({ text: [label, status].filter(Boolean).join(' · '), cls: 'dc-message-meta' });
      if (message.role === 'assistant' && assistantIdentity !== previousAssistantIdentity) {
        if (provenance) { const details = meta.createEl('details', { cls: 'dc-message-details' }); details.createEl('summary', { text: '回复信息' }); details.createEl('span', { text: provenance }); }
        previousAssistantIdentity = assistantIdentity;
      }
      const body = card.createDiv({ cls: 'dc-message-content' });
      if (message.role === 'assistant' && ['failed', 'stopped', 'interrupted'].includes(message.status || '')) { const raw = body.createEl('details'); raw.createEl('summary', { text: '查看未完成回答（不可应用）' }); raw.createEl('pre', { text: message.content, cls: 'dc-old-version' }); }
      else renderStoredMessage(body, message, this.host.agentActions?.() || [], {
        locateAction: id => void this.perform(() => this.host.locateAgentAction?.(id) || Promise.resolve()),
        undoAction: id => void this.perform(() => this.host.undoAgentAction?.(id) || Promise.resolve()),
        canUndoAction: id => this.host.canUndoAgentAction?.(id) || false,
      });
      if (message.candidateId) card.createDiv({ text: '候选材料 · 应用前不属于正文', cls: 'dc-candidate-label' });
      if (message.role === 'assistant' && message.content) {
        const copy = button(card, '复制回复', () => {
          if (copy.disabled) return; copy.disabled = true;
          const clipboard = navigator.clipboard;
          if (!clipboard?.writeText) { new Notice('复制未完成，请选中文字手动复制。'); copy.disabled = false; return; }
          void clipboard.writeText(message.content).then(() => copy.setText('已复制')).catch(() => { new Notice('复制未完成，请选中文字手动复制。'); copy.setText('复制回复'); }).finally(() => { copy.disabled = false; });
        }, 'dc-text-button dc-copy-message');
      }
    }
    if (session?.candidate) { const row = this.reader.createDiv({ cls: 'dc-candidate-bar' }); row.createEl('span', { text: `${session.candidate.deletion ? '删除候选' : '整篇修改候选'} · ${stateLabels[session.candidate.state]}` }); button(row, '预览差异', () => new CandidateModal(this.host, session.candidate!, () => this.prepareEdit('auto'), this.app).open()); }
    if (running) { const card = this.reader.createDiv({ cls: 'dc-message dc-message-assistant dc-streaming' }); card.createDiv({ text: `${running.roleName} · 正在生成`, cls: 'dc-message-meta' }); card.createDiv({ text: this.streamText(running), cls: 'dc-message-content' }); }
  }
  /** Only inspect this document's public Markdown view, never an unrelated active note. */
  private bodyIsEmpty(): boolean {
    const target = this.host.target();
    if (!target) return false;
    const leaves = this.app.workspace?.getLeavesOfType('markdown') || [];
    const texts = leaves.map(leaf => leaf.view as unknown as {
      file?: { path: string }; editor?: { getValue(): string }; getViewData?: () => string;
    }).filter(view => view.file?.path === target.path).map(view => view.editor?.getValue() ?? view.getViewData?.())
      .filter((text): text is string => typeof text === 'string');
    if (!texts.length || texts.some(text => text !== texts[0])) return false;
    try { return !texts[0]!.slice(bodyStart(texts[0]!)).trim(); } catch { return false; }
  }
  private reviewState(title: string, message: string, kind = ''): HTMLElement {
    const state = this.reader.createDiv({ cls: `dc-review-state ${kind}`, attr: { role: 'status' } });
    state.createEl('strong', { text: title });
    if (message) state.createEl('p', { text: message });
    return state;
  }
  private runDetails(parent: HTMLElement, session: Session, run: ReviewRun): void {
    const details = parent.createEl('details', { cls: 'dc-review-run-details' });
    details.createEl('summary', { text: run.status === 'failed' ? '审阅信息与诊断' : '审阅信息' });
    details.createEl('p', { text: `${run.path || session.document.path} · ${new Date(run.at).toLocaleString('zh-CN')}` });
    details.createEl('p', { text: `${run.author.name} · ${run.providerName} / ${run.model} · ${run.scope === 'selection' ? '请求时选区' : '全文正文'}` });
    if (run.error) details.createEl('p', { text: diagnosticText(run.error) });
    const diagnostic = run.errorDiagnostic;
    if (diagnostic) details.createEl('p', { text: [errorLabels[diagnostic.category] || '请求失败', diagnostic.httpStatus ? `HTTP ${diagnostic.httpStatus}` : '', diagnostic.code, diagnostic.stage].filter(Boolean).join(' · '), cls: 'dc-muted' });
  }
  private renderReview(session: Session | null): void {
    const review = session?.review, all = review?.suggestions || [], latest = review?.runs.at(-1);
    const provider = this.host.data.providers.find(item => item.id === this.host.data.activeProviderId);
    const running = this.host.running?.documentId === session?.document.id && this.host.running?.mode === 'review';
    if (!provider?.baseUrl.trim() || !provider.model.trim()) {
      const state = this.reviewState('尚未配置模型服务', '在已有设置中配置服务并选择模型。');
      button(state, '打开设置', () => this.host.openSettings(), 'dc-text-button');
    } else if (!session || !this.host.target()) this.reviewState('没有可审阅文稿', '打开并聚焦一篇 Markdown 文稿。');
    else if (running) {
      const state = this.reviewState('正在审阅', '完整结果校验后才会形成批注。'); state.setAttribute('aria-busy', 'true');
      button(state, '停止审阅', () => this.host.stop(), 'dc-text-button dc-review-stop');
    } else if (this.bodyIsEmpty() || latest?.errorKind === 'empty-document') this.reviewState('正文为空', '输入 Markdown 内容后再审阅。');
    else if (!latest) this.reviewState('尚未审阅', '点击“审阅全文”，或选择文字后点击“审阅选区”。');
    else if (latest.status === 'completed') {
      const state = this.reviewState(latest.added ? `本次生成 ${latest.added} 条批注` : latest.duplicates ? '本次没有新增批注' : '本次未提出具体修改建议', latest.summary);
      const unlocated = all.filter(item => item.runId === latest.id && ['unlocated', 'needs-check'].includes(item.state)).length;
      if (unlocated) state.createEl('p', { text: `${unlocated} 条无法可靠定位，评论已保留，请重新检查后采纳。`, cls: 'dc-review-warning' });
      if (latest.duplicates) state.createEl('p', { text: `${latest.duplicates} 条与已有批注重复。`, cls: 'dc-muted dc-small' });
      this.runDetails(state, session!, latest);
    } else if (latest.status === 'failed' || latest.status === 'stopped' || latest.status === 'interrupted') {
      const title = latest.status === 'stopped' ? '本次审阅已停止' : latest.status === 'interrupted' ? '本次审阅已中断' : errorLabels[latest.errorKind || latest.errorDiagnostic?.category || ''] || '审阅失败';
      const state = this.reviewState(title, latest.status === 'failed' ? diagnosticText(latest.error || '请求未完成，请检查服务后重试。').slice(0, 120) : '未完成结果没有形成可采纳批注。', latest.status === 'failed' ? 'dc-error' : '');
      const retry = button(state, '重试审阅', () => void this.perform(() => this.host.retryReview(session!.document.id, latest.id)), 'dc-text-button'); retry.disabled = !!this.host.running || this.busy;
      this.runDetails(state, session!, latest);
    }
    const overall = latest?.status === 'completed' ? latest.overall : [];
    if (overall.length) { const box = this.reader.createEl('details', { cls: 'dc-overall' }); box.createEl('summary', { text: `整体建议 · ${overall.length}` }); for (const item of overall) { const row = box.createDiv({ cls: 'dc-overall-item' }); row.createEl('strong', { text: item.title }); row.createEl('p', { text: item.reason }); } }
    const active = all.filter(item => !['applied', 'ignored'].includes(item.state)), handled = all.filter(item => ['applied', 'ignored'].includes(item.state));
    for (const suggestion of active.filter(item => item.runId === latest?.id)) this.renderSuggestion(suggestion, review?.selectedId === suggestion.id);
    const previous = active.filter(item => item.runId !== latest?.id);
    if (previous.length) {
      const history = this.reader.createEl('details', { cls: 'dc-previous-suggestions', attr: previous.some(item => item.id === review?.selectedId) ? { open: 'true' } : {} });
      history.createEl('summary', { text: `之前的未处理批注 · ${previous.length}` });
      for (const suggestion of previous) this.renderSuggestion(suggestion, review?.selectedId === suggestion.id, history);
    }
    const processedSelected = handled.some(item => item.id === review?.selectedId);
    if (handled.length) {
      const done = this.reader.createEl('details', { cls: 'dc-processed', attr: processedSelected ? { open: 'true' } : {} });
      done.createEl('summary', { text: `已处理 · ${handled.length}` });
      for (const suggestion of handled) this.renderSuggestion(suggestion, review?.selectedId === suggestion.id, done);
    }
    if (session && review && review.runs.length > 1) {
      const history = this.reader.createEl('details', { cls: 'dc-review-history' }); history.createEl('summary', { text: `审阅历史 · ${review.runs.length - 1}` });
      for (const run of review.runs.slice(0, -1).reverse()) {
        const row = history.createDiv({ cls: 'dc-suggestion-history' }); row.createEl('strong', { text: `${new Date(run.at).toLocaleString('zh-CN')} · ${run.status === 'completed' ? `${run.added} 条新批注` : run.status === 'stopped' ? '已停止' : run.status === 'failed' ? '失败' : '已中断'}` });
        if (run.summary) row.createEl('p', { text: run.summary }); this.runDetails(row, session, run);
      }
    }
  }
  private renderSuggestion(suggestion: Suggestion, selected: boolean, parent = this.reader): void {
    const card = parent.createDiv({ cls: `dc-suggestion ${selected ? 'is-selected' : ''} dc-suggestion-${suggestion.state}` });
    const canLocate = ['pending', 'comment'].includes(suggestion.state) && !!suggestion.anchors?.target.valid && !!suggestion.anchors.scope.valid;
    const top = card.createDiv({ cls: 'dc-suggestion-top' }); button(top, `#${suggestion.number} ${suggestion.title}`, () => { this.host.selectSuggestion(suggestion.documentId, suggestion.id); this.refresh(); if (canLocate) void this.perform(() => this.host.locateSuggestion(suggestion.documentId, suggestion.id)); }, 'dc-suggestion-title'); top.createEl('span', { text: suggestion.state === 'pending' ? '待处理' : suggestion.state === 'comment' ? '评论' : suggestion.state === 'needs-check' ? '待重检' : suggestion.state === 'unlocated' ? '无法定位' : suggestion.state === 'applied' ? '已采纳' : suggestion.state === 'ignored' ? '已忽略' : '处理中', cls: 'dc-suggestion-state' });
    if (!selected) {
      card.createEl('p', { text: suggestion.quote, cls: 'dc-suggestion-quote' });
      if (['unlocated', 'needs-check'].includes(suggestion.state)) {
        card.createEl('p', { text: currentVersion(suggestion).reason, cls: 'dc-suggestion-reason' });
        card.createEl('p', { text: suggestion.invalidReason || '无法可靠定位，请重新审阅。', cls: 'dc-review-warning' });
      }
      return;
    }
    const version = currentVersion(suggestion); card.createEl('p', { text: suggestion.quote, cls: 'dc-suggestion-quote' }); card.createEl('p', { text: version.reason, cls: 'dc-suggestion-reason' });
    card.createEl('p', { text: `原始作者：${suggestion.author.name} · 当前版本作者：${version.author.name}`, cls: 'dc-muted dc-small' });
    const session = this.host.data.sessions[suggestion.documentId] || Object.values(this.host.data.sessions).find(item => item.document.id === suggestion.documentId);
    const run = session?.review?.runs.find(item => item.id === suggestion.runId);
    if (session && run) this.runDetails(card, session, run);
    if (version.replacement !== null) {
      card.createEl('p', { text: '建议新句（只读）', cls: 'dc-muted dc-small' }); card.createEl('pre', { text: version.replacement, cls: 'dc-old-version' });
    }
    if (suggestion.invalidReason) card.createEl('p', { text: suggestion.invalidReason, cls: 'dc-review-warning' });
    const actions = card.createDiv({ cls: 'dc-actions' }); const generating = !!this.host.running;
    const action = (label: string, run: () => void, cls = '') => { const node = button(actions, label, run, cls); node.disabled = generating; return node; };
    action('预览', () => void this.perform(() => this.host.openReview(suggestion.documentId, suggestion.id)));
    const locate = action('定位', () => void this.perform(() => this.host.locateSuggestion(suggestion.documentId, suggestion.id))); locate.disabled ||= !canLocate;
    if (suggestion.state === 'pending' && version.replacement !== null) {
      const preview = action('预览采纳', () => void this.perform(() => this.host.openReview(suggestion.documentId, suggestion.id)), 'mod-cta');
      preview.title = '先查看原文、修订和改后预览，再从审阅页采纳。'; preview.disabled ||= !canLocate;
    }
    if (suggestion.state === 'pending' || suggestion.state === 'comment' || suggestion.state === 'needs-check' || suggestion.state === 'unlocated') action('忽略', () => void this.runSuggestion(suggestion, () => this.host.ignoreSuggestion(suggestion.documentId, suggestion.id)));
    if (this.host.canUndoSuggestion(suggestion.documentId, suggestion.id)) action('撤回', () => void this.runSuggestion(suggestion, () => this.host.undoSuggestion(suggestion.documentId, suggestion.id)));
    if (suggestion.versions.length > 1) {
      const versions = card.createEl('details', { cls: 'dc-suggestion-versions' }); versions.createEl('summary', { text: `查看旧版本 · ${suggestion.versions.length - 1}` });
      for (const old of suggestion.versions.filter(item => item.id !== version.id)) {
        const history = versions.createDiv({ cls: 'dc-suggestion-history' }); history.createEl('strong', { text: `${old.author.name} · 已被新版本替代` }); history.createEl('p', { text: old.reason }); history.createEl('pre', { text: old.replacement ?? '仅评论，不替换正文', cls: 'dc-old-version' });
      }
    }
    const reply = card.createEl('details', { cls: 'dc-suggestion-reply', attr: this.replyOpen.has(suggestion.id) ? { open: 'true' } : {} });
    reply.createEl('summary', { text: '追问或再改一版' });
    reply.addEventListener('toggle', () => { if (reply.open) this.replyOpen.add(suggestion.id); else this.replyOpen.delete(suggestion.id); });
    const ask = reply.createEl('textarea', { attr: { rows: '2', placeholder: '说明需要澄清或怎样调整这条建议…', 'aria-label': '批注追问', 'data-suggestion-id': suggestion.id } });
    ask.value = this.replyDrafts.get(suggestion.id) || '';
    ask.addEventListener('input', () => this.replyDrafts.set(suggestion.id, ask.value));
    const replyActions = reply.createDiv({ cls: 'dc-actions' }); const askButton = button(replyActions, '追问', () => { if (!ask.value.trim()) return; void this.runSuggestion(suggestion, () => this.host.askSuggestion(suggestion.documentId, suggestion.id, ask.value.trim(), false)); }); const reviseButton = button(replyActions, '再改一版', () => { if (!ask.value.trim()) return; void this.runSuggestion(suggestion, () => this.host.askSuggestion(suggestion.documentId, suggestion.id, ask.value.trim(), true)); }); askButton.disabled = generating; reviseButton.disabled = generating || !canLocate;
    for (const item of suggestion.replies) { const message = reply.createDiv({ cls: 'dc-suggestion-history' }); message.createEl('strong', { text: item.author.name }); message.createEl('p', { text: item.content }); }
  }
  private prepareEdit(scope: EditScope): void { this.modes.set(this.sessionId, 'edit'); this.setTask('propose', scope); this.setTab('chat'); this.input.focus(); this.updateButtons(); }
  private resizeInput(): void { if (!this.input) return; this.input.style.height = 'auto'; this.input.style.height = `${Math.min(Math.max(this.input.scrollHeight, 54), 130)}px`; }
  private updateButtons(): void {
    const session = this.host.currentSession(); const provider = this.host.data.providers.find(item => item.id === this.host.data.activeProviderId);
    const configured = !!provider?.baseUrl.trim() && !!provider.model.trim();
    this.sendButton.disabled = !session || !configured || !!this.host.running || this.busy || !this.input.value.trim(); this.stopButton.disabled = !this.host.running;
    this.clearButton.disabled = !session || (this.busy && !this.host.running);
    if (this.undoWholeButton) this.undoWholeButton.disabled = !this.host.canUndoWhole() || !!this.host.running || this.busy;
    this.sendButton.hidden = !!this.host.running; this.stopButton.hidden = !this.host.running; this.stopButton.classList.add('mod-cta');
    const actionLabel = this.task() === 'auto' ? '发送' : `${this.taskLabel()}并发送`;
    this.sendButton.setAttribute('aria-label', actionLabel); this.sendButton.title = actionLabel;
    if (this.taskTag) {
      const explicit = this.task() !== 'auto'; this.taskTag.hidden = !explicit;
      if (explicit) this.taskTag.setText(`${this.taskLabel()} ×`);
    }
  }
  private async send(): Promise<void> {
    if (this.sendButton.disabled || this.composing) return;
    const text = this.input.value.trim(); const id = this.sessionId; this.busy = true; this.errorEl.empty(); this.updateButtons();
    try { await this.host.sendAgent(text, { task: this.task(), scope: this.editScope() }); if (id === this.sessionId && this.input.value.trim() === text) { this.input.value = ''; this.drafts.set(this.composerKey || this.stateKey(), ''); } }
    catch (error) { this.errorEl.setText(errorText(error)); this.errorEl.addClass('dc-error'); }
    finally { this.busy = false; this.refresh(); }
  }
  private async runSuggestion(_suggestion: Suggestion, action: () => Promise<void>): Promise<void> { if (this.busy) return; this.busy = true; this.updateButtons(); try { await action(); } catch (error) { this.errorEl.setText(errorText(error)); this.errorEl.addClass('dc-error'); new Notice(errorText(error)); } finally { this.busy = false; this.refresh(); } }
  private async perform(action: () => Promise<void>): Promise<void> { this.errorEl?.empty(); try { await action(); } catch (error) { this.errorEl?.setText(errorText(error)); this.errorEl?.addClass('dc-error'); new Notice(errorText(error)); } this.refresh(); }
  private async clearConversation(session: Session): Promise<void> {
    await this.host.clearSession(session.id);
    for (const tab of ['chat', 'review']) {
      this.drafts.delete(`${session.id}:${tab}`); this.scrollPositions.delete(`${session.id}:${tab}`);
    }
    this.tasks.delete(session.id); this.scopes.delete(session.id); this.modes.delete(session.id);
    this.currentTab.set(session.id, 'chat'); this.selectedSuggestions.set(session.id, session.review?.selectedId);
    for (const suggestion of session.review?.suggestions || []) { this.replyDrafts.delete(suggestion.id); this.replyOpen.delete(suggestion.id); }
    if (this.host.currentSession()?.id === session.id) {
      // refresh persists the visible DOM first; clear it as well as the saved per-tab drafts.
      this.input.value = ''; this.input.scrollTop = 0; this.reader.scrollTop = 0;
      this.errorEl.empty(); this.errorEl.removeClass('dc-error');
      this.closeMoreMenu(false); this.closeRoleMenu(false);
    }
    this.refresh();
  }
  private confirmClear(): void {
    const session = this.host.currentSession(); if (!session) return;
    const modal = new Modal(this.app); modal.titleEl.setText('清空当前对话');
    modal.contentEl.createEl('p', { text: `将清除「${session.document.path}」的全部聊天记录和未发送输入。本文要求、批注和撤回记录保留，文稿正文不变。` });
    const clear = button(modal.contentEl, '清空对话', () => {
      clear.disabled = true;
      void this.perform(() => this.clearConversation(session)).finally(() => modal.close());
    }, 'mod-warning');
    button(modal.contentEl, '取消', () => modal.close()); modal.open();
  }
  async onClose(): Promise<void> {
    this.closed = true; this.unsubscribe?.();
    this.closeMoreMenu(false); this.closeRoleMenu(false);
    if (this.host.running?.origin !== 'daily' && this.host.running) this.host.stop();
    this.contentEl.empty();
  }
}
