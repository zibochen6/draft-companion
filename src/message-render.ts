import type { AgentActionReceipt } from './agent-types';
import type { Message } from './types';
import { renderSafeMarkdown } from './render';

export interface MessageRenderCallbacks {
  locateAction?: (id: string) => void;
  undoAction?: (id: string) => void;
  canUndoAction?: (id: string) => boolean;
}

function button(parent: HTMLElement, label: string, action: () => void, cls = ''): HTMLButtonElement {
  const node = parent.createEl('button', { text: label, cls });
  node.type = 'button'; node.addEventListener('click', action); return node;
}

function object(source: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(source);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function text(value: unknown): value is string { return typeof value === 'string'; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }

function readonlyProposal(parent: HTMLElement, source: Record<string, unknown>): boolean {
  if (text(source.explanation) && text(source.replacement) && strings(source.notes)) {
    parent.createEl('strong', { text: '历史改稿建议（只读）' });
    parent.createEl('p', { text: source.explanation });
    const details = parent.createEl('details'); details.createEl('summary', { text: '查看建议正文' }); details.createEl('pre', { text: source.replacement, cls: 'dc-old-version' });
    if (source.notes.length) { const list = parent.createEl('ul'); source.notes.forEach(note => list.createEl('li', { text: note })); }
    parent.createEl('p', { text: '这是一条历史建议，不代表已经写入文稿。', cls: 'dc-muted dc-small' });
    return true;
  }
  if (text(source.summary) && Array.isArray(source.suggestions) && Array.isArray(source.overall)) {
    parent.createEl('strong', { text: '历史审阅总结（只读）' }); parent.createEl('p', { text: source.summary });
    parent.createEl('p', { text: `整体建议 ${source.overall.length} 条；句级建议 ${source.suggestions.length} 条。`, cls: 'dc-muted dc-small' });
    parent.createEl('p', { text: '具体状态以“批注”阅读标签中的本地记录为准。', cls: 'dc-muted dc-small' });
    return true;
  }
  if (text(source.summary) && Array.isArray(source.edits)) {
    parent.createEl('strong', { text: '历史改稿摘要（只读）' }); parent.createEl('p', { text: source.summary });
    const details = parent.createEl('details'); details.createEl('summary', { text: `查看 ${source.edits.length} 条历史建议` });
    for (const edit of source.edits) {
      const item = details.createDiv({ cls: 'dc-history-edit' });
      if (text(edit)) item.createEl('p', { text: edit });
      else if (edit && typeof edit === 'object' && !Array.isArray(edit)) {
        const value = edit as Record<string, unknown>;
        item.createEl('strong', { text: text(value.title) ? value.title : '历史建议' });
        if (text(value.reason)) item.createEl('p', { text: value.reason });
        if(text(value.oldText)) {item.createEl('span',{text:'原文：',cls:'dc-muted dc-small'});item.createEl('pre',{text:value.oldText,cls:'dc-old-version'});}
        if(text(value.newText)) {item.createEl('span',{text:'历史建议：',cls:'dc-muted dc-small'});item.createEl('pre',{text:value.newText,cls:'dc-old-version'});}
        if (text(value.replacement)) item.createEl('pre', { text: value.replacement, cls: 'dc-old-version' });
      } else item.createEl('p', { text: '一条无法完整恢复的历史建议。', cls: 'dc-muted dc-small' });
    }
    parent.createEl('p', { text: '这些内容只供阅读；没有对应回执时不会执行或声称已写入。', cls: 'dc-muted dc-small' });
    return true;
  }
  return false;
}

function receiptState(receipt: AgentActionReceipt): string {
  if (receipt.state === 'applied') return '已写入';
  if (receipt.state === 'prepared') return '已准备，尚未写入';
  if (receipt.state === 'undone') return '已撤回';
  return '待重新检查';
}

function renderToolReceipts(parent: HTMLElement, message: Message, receipts: AgentActionReceipt[], callbacks: MessageRenderCallbacks): void {
  const ids = message.actionIds || [];
  if (!ids.length) { renderSafeMarkdown(parent, message.content); return; }
  const matched = ids.map(id => receipts.find(receipt => receipt.id === id)).filter((receipt): receipt is AgentActionReceipt => !!receipt);
  if (!matched.length) {
    parent.createEl('strong', { text: '工具操作未确认' });
    parent.createEl('p', { text: '这条消息引用的本地操作回执不存在或无法验证；不会把模型文字当作已写入结果。' });
    return;
  }
  for (const receipt of matched) {
    const card = parent.createDiv({ cls: `dc-tool-receipt dc-tool-${receipt.state}` });
    card.createEl('strong', { text: receipt.label }); card.createEl('span', { text: receiptState(receipt), cls: 'dc-tool-state' });
    card.createEl('p',{text:receipt.path,cls:'dc-muted dc-small'});
    if (receipt.invalidReason) card.createEl('p', { text: receipt.invalidReason, cls: 'dc-review-warning' });
    const actions = card.createDiv({ cls: 'dc-tool-actions' });
    const locate=button(actions, '定位原文', () => callbacks.locateAction?.(receipt.id), 'dc-text-button');locate.disabled=receipt.state!=='applied'||!receipt.anchor.valid;
    const undo = button(actions, receipt.kind==='topic-check'?'撤回勾选':'撤回修改', () => callbacks.undoAction?.(receipt.id), 'dc-text-button');
    undo.disabled = !callbacks.canUndoAction?.(receipt.id);
  }
}

/**
 * Present stored replies without granting text any ability to claim or perform a
 * document operation. Only host-owned action receipts can render an applied state.
 */
export function renderStoredMessage(parent: HTMLElement, message: Message, receipts: AgentActionReceipt[], callbacks: MessageRenderCallbacks = {}): void {
  if (message.presentation === 'tool') { renderToolReceipts(parent, message, receipts, callbacks); return; }
  const parsed = object(message.content.trim());
  if (parsed) {
    const box = parent.createDiv({ cls: 'dc-structured-message' });
    if (readonlyProposal(box, parsed)) return;
    box.createEl('strong', { text: '无法识别的结构化历史回复' });
    box.createEl('p', { text: '该内容仅保留供查看，未形成候选、批注或本地工具操作。' });
    const raw = box.createEl('details'); raw.createEl('summary', { text: '查看原始结构内容' }); raw.createEl('pre', { text: message.content, cls: 'dc-old-version' });
    return;
  }
  let visible = message.content;
  if(message.role==='assistant')for(const receipt of receipts.filter(r=>message.actionIds?.includes(r.id))) {
    const id=receipt.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    visible=visible.replace(new RegExp(`(?:actionId|action_id)\\s*[:：]\\s*\u0060?${id}\u0060?`,'g'),'本地回执已确认');
  }
  renderSafeMarkdown(parent, visible);
}
