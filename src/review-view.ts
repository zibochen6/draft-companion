import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { renderSafeMarkdown } from './render';
import { currentVersion, type Suggestion, type SuggestionPreview } from './review-types';
import { renderRevisionMarkdown } from './revision-render';
import type { UIHost } from './ui-host';

export const REVIEW_VIEW_TYPE = 'draft-companion-review';
type ReviewMode = 'before' | 'revision' | 'after';
interface ReviewState { documentId?: string; suggestionId?: string; mode?: ReviewMode; expanded?: boolean }

function button(parent: HTMLElement, text: string, action: () => void, cls = ''): HTMLButtonElement {
  const node = parent.createEl('button', { text, cls }); node.type = 'button'; node.addEventListener('click', action); return node;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : '操作未完成，请重试。'; }

/** A main-area, read-only preview. Its only document mutation actions delegate to an explicit sidebar/controller command. */
export class DraftReviewView extends ItemView {
  private unsubscribe?: () => void;
  private state: ReviewState = {};
  private preview?: SuggestionPreview;
  private request = 0;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private operating = false;
  private closed = false;

  constructor(leaf: WorkspaceLeaf, private host: UIHost) { super(leaf); }
  get documentId(): string | undefined { return this.state.documentId; }
  getViewType(): string { return REVIEW_VIEW_TYPE; }
  getDisplayText(): string { return '稿伴审阅'; }
  getIcon(): string { return 'message-square-quote'; }
  getState(): Record<string, unknown> { return { ...this.state }; }
  async setState(value: unknown): Promise<void> {
    const input = value && typeof value === 'object' ? value as ReviewState : {};
    this.state = {
      documentId: typeof input.documentId === 'string' ? input.documentId : undefined,
      suggestionId: typeof input.suggestionId === 'string' ? input.suggestionId : undefined,
      mode: input.mode === 'before' || input.mode === 'after' || input.mode === 'revision' ? input.mode : 'revision',
      expanded: input.expanded === true,
    };
    if (this.state.documentId) this.host.bindReview(this.state.documentId);
    if (this.state.documentId && this.state.suggestionId) this.host.selectSuggestion(this.state.documentId, this.state.suggestionId);
    await this.loadPreview();
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass('dc-review-view');
    this.unsubscribe = this.host.subscribe(() => { void this.loadPreview(); });
    await this.loadPreview();
  }
  async onClose(): Promise<void> { this.closed = true; ++this.request; this.unsubscribe?.(); this.preview = undefined; this.contentEl.empty(); }
  private suggestion(): Suggestion | undefined {
    const review = this.state.documentId ? this.host.data.sessions[this.state.documentId]?.review : undefined;
    const id = review?.selectedId || this.state.suggestionId;
    return id ? review?.suggestions.find(item => item.id === id) : undefined;
  }
  private async loadPreview(): Promise<void> {
    if (this.closed) return;
    const documentId = this.state.documentId;
    const suggestion = this.suggestion();
    const request = ++this.request;
    if (!documentId || !suggestion) { this.preview = undefined; this.render(); return; }
    try {
      const preview = await this.host.previewSuggestion(documentId, suggestion.id);
      if (request !== this.request || this.closed) return;
      this.preview = preview; this.render();
    } catch (error) {
      if (request !== this.request || this.closed) return;
      this.preview = undefined; this.render(errorText(error));
    }
  }
  private setMode(mode: ReviewMode): void { this.state.mode = mode; void this.loadPreview(); }
  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.operating || this.host.running) return;
    this.operating = true;
    try { await action(); }
    catch (error) { new Notice(errorText(error)); }
    finally { this.operating = false; await this.loadPreview(); }
  }
  private render(problem?: string): void {
    if (!this.contentEl || this.closed) return;
    this.contentEl.empty();
    const suggestion = this.suggestion(); const preview = this.preview;
    const head = this.contentEl.createDiv({ cls: 'dc-review-head' });
    head.createEl('strong', { text: '稿伴审阅' });
    if (preview) head.createEl('span', { text: preview.path, cls: 'dc-review-path', attr: { title: preview.path } });
    const switcher = this.contentEl.createDiv({ cls: 'dc-review-switcher', attr: { role: 'tablist', 'aria-label': '审阅预览方式' } });
    for (const [mode, label] of [['before', '原文'], ['revision', '修订'], ['after', '改后']] as const) {
      const node = button(switcher, label, () => this.setMode(mode), this.state.mode === mode ? 'is-active' : '');
      node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(this.state.mode === mode));
    }
    this.status = this.contentEl.createDiv({ cls: 'dc-inline-status', attr: { role: 'status' } });
    if (problem) { this.status.addClass('dc-error'); this.status.setText(problem); }
    if (!suggestion) {
      this.body = this.contentEl.createDiv({ cls: 'dc-review-body dc-empty' });
      this.body.setText('从侧栏选择一条句级批注后，这里会展示不写入文稿的原文、修订和改后预览。'); return;
    }
    const version = currentVersion(suggestion);
    const meta = this.contentEl.createDiv({ cls: 'dc-review-meta' });
    meta.createEl('strong', { text: `#${suggestion.number} ${suggestion.title}` });
    meta.createEl('span', { text: `${suggestion.author.name} · ${suggestion.type}` });
    const controls = meta.createDiv({ cls: 'dc-actions' }); const generating = !!this.host.running;
    const action = (label: string, run: () => Promise<void>, cls = '', unavailable = false) => {
      const node = button(controls, label, () => void this.runAction(run), cls); node.disabled = generating || this.operating || unavailable; return node;
    };
    action('切换到编辑模式并定位', () => this.host.locateSuggestion(suggestion.documentId, suggestion.id), '', !preview?.valid);
    button(controls, '查看全文', () => { this.state.expanded = !this.state.expanded; this.render(); }, 'dc-text-button');
    if (suggestion.state === 'pending' && version.replacement !== null) action('采纳', () => this.host.acceptSuggestion(suggestion.documentId, suggestion.id), 'mod-cta', !preview?.valid);
    if (['pending', 'comment', 'needs-check', 'unlocated'].includes(suggestion.state)) action('忽略', () => this.host.ignoreSuggestion(suggestion.documentId, suggestion.id));
    if (this.host.canUndoSuggestion(suggestion.documentId, suggestion.id)) action('撤回', () => this.host.undoSuggestion(suggestion.documentId, suggestion.id));
    const detail = this.contentEl.createDiv({ cls: 'dc-review-detail' });
    detail.createEl('p', { text: version.reason });
    if (!preview?.valid) {
      const warning = detail.createEl('p', { cls: 'dc-review-warning' });
      warning.setText(preview?.reason || suggestion.invalidReason || '这条建议需要重新检查，只能查看保存的引用和旧候选。');
    }
    this.body = this.contentEl.createDiv({ cls: 'dc-review-body' });
    const source = this.state.expanded && preview ? preview.before : preview ? this.excerpt(preview, false) : suggestion.contextBefore + suggestion.quote + suggestion.contextAfter;
    if (!preview) {
      this.body.createEl('pre', { text: `${suggestion.quote}\n\n建议：${version.replacement ?? '仅评论，不替换正文'}`, cls: 'dc-old-version' });
    } else if (this.state.mode === 'before') renderSafeMarkdown(this.body, source || preview.before);
    else if (this.state.mode === 'after') {
      if (preview.valid && preview.after !== undefined) renderSafeMarkdown(this.body, this.state.expanded ? preview.after : this.excerpt(preview, true));
      else this.body.createEl('pre', { text: `${suggestion.quote}\n\n建议：${version.replacement ?? '仅评论，不替换正文'}`, cls: 'dc-old-version' });
    } else if (preview.valid && preview.after !== undefined) {
      const before = this.state.expanded ? preview.before : source;
      const after = this.state.expanded ? preview.after : this.excerpt(preview, true);
      renderRevisionMarkdown(this.body, before, after);
    } else this.body.createEl('pre', { text: `${suggestion.quote}\n\n建议：${version.replacement ?? '仅评论，不替换正文'}`, cls: 'dc-old-version' });
    this.body.createEl('p', { text: '预览当前建议，尚未写入。切换预览不会调用模型或改动文稿。', cls: 'dc-muted dc-small' });
  }
  /** The compact preview comes from the latest validated document, not frozen request context. */
  private excerpt(preview: SuggestionPreview, revised: boolean): string {
    const text = revised ? preview.after : preview.before;
    if (text === undefined || preview.from === undefined) return preview.before;
    const replacement = preview.version.replacement ?? preview.suggestion.quote;
    const targetEnd = preview.from + (revised ? replacement.length : preview.suggestion.quote.length);
    let from = 0, to = text.length;
    for (const paragraph of text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
      const at = paragraph.index, end = at + paragraph[0].length;
      if (end <= preview.from) from = end;
      else if (at >= targetEnd) { to = at; break; }
    }
    return text.slice(from, to);
  }
}

/** Backwards-friendly name for callers created while 0.2 was being assembled. */
export { DraftReviewView as DraftCompanionReviewView };
