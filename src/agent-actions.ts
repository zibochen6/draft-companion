import { randomUUID } from 'node:crypto';
import type { Documents } from './documents';
import { bodyStart, hashText, replaceExact } from './editing';
import type { DocumentRecord } from './types';
import type { TextAnchor, TextChange } from './review-types';
import type { AgentActionReceipt, AgentDocumentChange, AgentRequestContext, ToolOutcome } from './agent-types';

export interface AgentActionServices {
  documents: Documents;
  receipts(documentId: string): AgentActionReceipt[];
  save(): Promise<void>;
  changed(): void;
  editing: Set<string>;
}

class Conflict extends Error {}
function boundary(text: string, at: number): boolean {
  if (!Number.isInteger(at) || at < 0 || at > text.length) return false;
  const a = text.charCodeAt(at - 1), b = text.charCodeAt(at);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) && !(a === 13 && b === 10);
}
function matches(text: string, anchor: TextAnchor | undefined): boolean {
  return !!anchor && anchor.valid && anchor.to >= anchor.from && boundary(text, anchor.from) && boundary(text, anchor.to)
    && text.slice(anchor.from, anchor.to) === anchor.text;
}
function ordered(changes: TextChange[]): TextChange[] { return [...changes].sort((a, b) => a.from - b.from || a.to - b.to); }
function overlaps(change: TextChange, anchor: TextAnchor): boolean {
  if (anchor.from === anchor.to) return change.from <= anchor.from && change.to >= anchor.to;
  return change.from === change.to ? change.from > anchor.from && change.from < anchor.to
    : change.from < anchor.to && change.to > anchor.from;
}
function mapPosition(position: number, assoc: -1 | 1, changes: TextChange[]): number {
  let delta = 0;
  for (const change of ordered(changes)) {
    if (position < change.from) break;
    if (position > change.to) { delta += change.insert.length - (change.to - change.from); continue; }
    if (position === change.from) return change.from + delta + (assoc > 0 ? change.insert.length : 0);
    if (position === change.to) return change.from + delta + change.insert.length;
    return change.from + delta + (assoc > 0 ? change.insert.length : 0);
  }
  return position + delta;
}
function mapAnchor(anchor: TextAnchor | undefined, changes: TextChange[], invalidate = true): void {
  if (!anchor) return;
  if (invalidate && changes.some(change => overlaps(change, anchor))) anchor.valid = false;
  const from = mapPosition(anchor.from, 1, changes), to = mapPosition(anchor.to, -1, changes);
  anchor.from = from; anchor.to = Math.max(from, to);
}
function validChanges(before: string, after: string, changes: TextChange[]): boolean {
  let cursor = 0, result = '';
  for (const change of ordered(changes)) {
    if (change.from < cursor || change.to < change.from || !boundary(before, change.from) || !boundary(before, change.to) || typeof change.insert !== 'string') return false;
    result += before.slice(cursor, change.from) + change.insert; cursor = change.to;
  }
  return result + before.slice(cursor) === after;
}
function assertSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('操作已停止，未继续写入。'); }
function assertContext(context: AgentRequestContext): void { assertSignal(context.signal); context.assertActive(); }
function checkProtected(before: string, after: string): void {
  const start = bodyStart(before);
  if (bodyStart(after) !== start || before.slice(0, start) !== after.slice(0, start)) throw new Conflict('操作会改变受保护的 frontmatter 边界。');
}
function failure(error: unknown): ToolOutcome {
  const message = error instanceof Error ? error.message : '操作未完成。';
  return { status: error instanceof Conflict || /已变化|已阻止覆盖|旧候选|身份|范围无效/.test(message) ? 'conflict' : 'failed', message };
}

/** A shared local-edit ledger. It never searches for a replacement location by text. */
export class AgentActions {
  private contexts = new Map<AgentRequestContext, (() => void)[]>();
  private anchors = new Map<string, Set<TextAnchor>>();
  private text = new Map<string, string>();
  private contextText = new Map<AgentRequestContext, string>();
  private ownReceipts = new Set<string>();
  constructor(private services: AgentActionServices) {}

  trackAnchor(documentId: string, anchor: TextAnchor): () => void {
    let anchors = this.anchors.get(documentId);
    if (!anchors) { anchors = new Set(); this.anchors.set(documentId, anchors); }
    anchors.add(anchor);
    return () => { anchors!.delete(anchor); if (!anchors!.size) this.anchors.delete(documentId); };
  }
  trackContext(context: AgentRequestContext): void {
    if (this.contexts.has(context)) return;
    const known = this.text.get(context.document.id);
    if (known === undefined || !context.changeChain?.length) this.reconcile(context.document, context.snapshot.fullText);
    this.contextText.set(context, context.snapshot.fullText);
    this.contexts.set(context, [context.range, context.insertion].filter((anchor): anchor is TextAnchor => !!anchor)
      .map(anchor => this.trackAnchor(context.document.id, anchor)));
  }
  releaseContext(context: AgentRequestContext): void {
    for (const release of this.contexts.get(context) ?? []) release();
    this.contexts.delete(context);
    this.contextText.delete(context);
  }
  /** Replay only a newly registered request; never replay the global receipt ledger. */
  mapContext(context: AgentRequestContext, change: AgentDocumentChange): void {
    if (context.document.id !== change.documentId) return;
    const known = this.contextText.get(context) ?? context.snapshot.fullText;
    if (known === change.after && known !== change.before) return;
    if (known !== change.before || !validChanges(change.before, change.after, change.changes)) {
      if (context.range) context.range.valid = false;
      if (context.insertion) context.insertion.valid = false;
    } else { mapAnchor(context.range, change.changes); mapAnchor(context.insertion, change.changes); }
    this.contextText.set(context, change.after);
  }
  replayAnchor(documentId: string, anchor: TextAnchor, before: string, chain: AgentDocumentChange[]): void {
    let known = before;
    for (const change of chain) {
      if (change.documentId !== documentId || change.before !== known || !validChanges(change.before, change.after, change.changes)) {
        anchor.valid = false; return;
      }
      mapAnchor(anchor, change.changes); known = change.after;
    }
    if (this.text.get(documentId) !== undefined && this.text.get(documentId) !== known) anchor.valid = false;
  }
  reconcile(document: DocumentRecord, text: string): void {
    const known = this.text.get(document.id);
    if (known !== undefined && known !== text) this.invalidate(document.id, '存在无法确认的外部修改，操作回执需要重新检查。');
    const hash = hashText(text);
    for (const receipt of this.services.receipts(document.id)) {
      if (receipt.state === 'needs-check') continue;
      const verifiedHash = receipt.state === 'applied' ? receipt.afterHash : receipt.beforeHash;
      if (receipt.state === 'prepared' || receipt.path !== document.path || receipt.documentId !== document.id || verifiedHash !== hash
        || !matches(text, receipt.anchor) || (receipt.beforeContext && !matches(text, receipt.beforeContext))
        || (receipt.afterContext && !matches(text, receipt.afterContext))) {
        receipt.state = 'needs-check'; receipt.anchor.valid = false; receipt.invalidReason = '重启或外部修改后无法核实操作回执。';
      }
    }
    this.text.set(document.id, text);
  }
  private invalidate(documentId: string, reason: string): void {
    for (const anchor of this.anchors.get(documentId) ?? []) anchor.valid = false;
    for (const receipt of this.services.receipts(documentId)) {
      receipt.anchor.valid = false;
      if (receipt.beforeContext) receipt.beforeContext.valid = false;
      if (receipt.afterContext) receipt.afterContext.valid = false;
      receipt.state = 'needs-check'; receipt.invalidReason = reason;
    }
  }
  map(change: AgentDocumentChange): void {
    const known = this.text.get(change.documentId);
    if (known === change.after && change.before !== change.after) return;
    if (!validChanges(change.before, change.after, change.changes) || (known !== undefined && known !== change.before)) {
      this.invalidate(change.documentId, '文稿版本链中断，无法安全确认操作位置。');
      this.text.set(change.documentId, change.after); return;
    }
    if (known === undefined) {
      const hash = hashText(change.before);
      for (const receipt of this.services.receipts(change.documentId)) {
        const expected = receipt.state === 'applied' ? receipt.afterHash : receipt.beforeHash;
        if (receipt.state === 'prepared' || expected !== hash || !matches(change.before, receipt.anchor)
          || (receipt.beforeContext && !matches(change.before, receipt.beforeContext)) || (receipt.afterContext && !matches(change.before, receipt.afterContext))) {
          receipt.state = 'needs-check'; receipt.anchor.valid = false; receipt.invalidReason = '首个编辑事务之前的文稿版本无法核实。';
        }
      }
    }
    const special = new Set<string>();
    if ((change.kind === 'undo' || change.kind === 'redo') && change.changes.length === 1) {
      const edit = change.changes[0]!;
      for (const receipt of this.services.receipts(change.documentId)) {
        if (!matches(change.before, receipt.anchor) || (receipt.beforeContext && !matches(change.before, receipt.beforeContext))
          || (receipt.afterContext && !matches(change.before, receipt.afterContext))) continue;
        const from = edit.from - receipt.anchor.from, to = edit.to - receipt.anchor.from;
        if (from < 0 || to < from || to > receipt.anchor.text.length) continue;
        const next = replaceExact(receipt.anchor.text, from, to, edit.insert);
        const undone = change.kind === 'undo' && receipt.state === 'applied' && next === receipt.before;
        const redone = change.kind === 'redo' && receipt.state === 'undone' && next === receipt.replacement;
        if (undone || redone) {
          receipt.state = undone ? 'undone' : 'applied';
          receipt.anchor = { from: receipt.anchor.from, to: receipt.anchor.from + next.length, text: next, valid: true };
          special.add(receipt.id);
        }
      }
    }
    for (const anchor of this.anchors.get(change.documentId) ?? []) mapAnchor(anchor, change.changes);
    for (const context of this.contexts.keys()) if (context.document.id === change.documentId) this.contextText.set(context, change.after);
    for (const receipt of this.services.receipts(change.documentId)) {
      if (this.ownReceipts.has(receipt.id)) continue;
      const changed = !special.has(receipt.id) && [receipt.anchor, receipt.beforeContext, receipt.afterContext]
        .some(anchor => !!anchor && change.changes.some(edit => overlaps(edit, anchor)));
      if (!special.has(receipt.id)) mapAnchor(receipt.anchor, change.changes);
      mapAnchor(receipt.beforeContext, change.changes); mapAnchor(receipt.afterContext, change.changes);
      if (changed) { receipt.state = 'needs-check'; receipt.invalidReason = '操作文字或撤回上下文已变化。'; }
      if (receipt.state === 'applied') receipt.afterHash = hashText(change.after);
      if (receipt.state === 'undone') receipt.beforeHash = hashText(change.after);
    }
    this.text.set(change.documentId, change.after);
  }

  private async latest(document: DocumentRecord): Promise<string> {
    const read = await this.services.documents.read(document);
    const current = this.services.documents.bufferText(document) ?? read;
    this.reconcile(document, current); return current;
  }
  private contextAnchor(text: string, from: number, to: number): TextAnchor | undefined {
    if (from === to) return undefined;
    while (from < to && !boundary(text, from)) from++;
    while (to > from && !boundary(text, to)) to--;
    return from < to ? { from, to, text: text.slice(from, to), valid: true } : undefined;
  }
  async apply(context: AgentRequestContext, target: TextAnchor, replacement: string, label: string, kind: AgentActionReceipt['kind'], validate?: (current: string) => void): Promise<ToolOutcome> {
    const document = context.document, receipts = this.services.receipts(document.id);
    let receipt: AgentActionReceipt | undefined, wrote = false, locked = false;
    try {
      assertContext(context);
      const permission = kind === 'topic-check' ? 'select-topic' : kind === 'replace' ? 'replace' : 'insert';
      if (context.intent.intent !== permission) throw new Conflict('当前请求没有授权这类写入。');
      if (kind !== 'topic-check' && target !== (kind === 'replace' ? context.range : context.insertion)) throw new Conflict('操作范围不属于本次授权引用。');
      const previous = receipts.find(item => item.requestId === context.snapshot.requestId && item.kind === kind
        && (kind !== 'topic-check' || (item.anchor.from === target.from && item.anchor.to === target.to)));
      if (previous) return { status: previous.state === 'applied' ? 'noop' : 'conflict', message: previous.state === 'applied' ? '本次请求已完成这项操作，未重复写入。' : '本次请求已有操作记录，请重新确认后发起新请求。', actionId: previous.id };
      if (this.services.editing.has(document.id)) throw new Conflict('此文稿正在写入，请稍后重试。');
      this.services.editing.add(document.id); locked = true;
      const before = await this.latest(document); assertContext(context);
      validate?.(before);
      if (kind !== 'topic-check' && this.contextText.get(context) !== before) throw new Conflict('授权快照没有连续映射到当前文稿版本。');
      if (!matches(before, target)) throw new Conflict('授权文字或操作位置已变化，请重新发起请求。');
      if (kind === 'topic-check' && (target.to - target.from !== 1 || replacement !== 'x' || !/^\[[ \u00a0xX]\]$/.test(before.slice(target.from - 1, target.to + 1))))
        throw new Conflict('选题操作只能修改已授权任务的单个状态字符。');
      if (typeof replacement !== 'string' || (kind !== 'topic-check' && !replacement.trim())) throw new Conflict('不能用空文字自动删除或插入正文。');
      const from = target.from, to = target.to;
      if (replacement === target.text) return { status: 'noop', message: '目标已经是要求的内容，未写入。' };
      const after = replaceExact(before, from, to, replacement); checkProtected(before, after);
      receipt = { id: randomUUID(), requestId: context.snapshot.requestId, documentId: document.id, path: document.path, at: Date.now(), kind, label,
        before: target.text, replacement, anchor: { ...target },
        beforeContext: this.contextAnchor(before, Math.max(bodyStart(before), from - 32), from),
        afterContext: this.contextAnchor(before, to, Math.min(before.length, to + 32)),
        beforeHash: hashText(before), afterHash: hashText(after), state: 'prepared' };
      receipts.push(receipt); this.services.changed();
      await this.services.save(); assertContext(context);
      this.ownReceipts.add(receipt.id);
      try {
        await this.services.documents.applyRangeValidated(document, before, from, to, replacement, current => {
          assertContext(context);
          validate?.(current);
          if (target.from !== from || target.to !== to || !matches(current, target)) throw new Conflict('写入前授权位置已变化。');
          checkProtected(current, replaceExact(current, from, to, replacement));
        });
        wrote = true;
      } finally { this.ownReceipts.delete(receipt.id); }
      const delta = replacement.length - (to - from);
      if (receipt.afterContext) { receipt.afterContext.from += delta; receipt.afterContext.to += delta; }
      receipt.anchor = { from, to: from + replacement.length, text: replacement, valid: true }; receipt.state = 'applied';
      this.text.set(document.id, after); this.services.changed();
      const verified = await this.latest(document);
      if (receipt.state !== 'applied' || !matches(verified, receipt.anchor) || receipt.anchor.text !== replacement)
        throw new Conflict('已执行局部写入，但最新文字无法核实。请检查文稿，勿重复操作。');
      receipt.afterHash = hashText(verified);
      const data = { document_ref: context.documentRef, path: document.path, kind, label, verified: true, replacement };
      try { await this.services.save(); }
      catch { return { status: 'success', message: '已完成局部写入，但撤回记录保存失败。请保留当前窗口，勿重复操作。', actionId: receipt.id, data: { ...data, persistenceWarning: true } }; }
      return { status: 'success', message: `已${label}，只修改了授权位置。`, actionId: receipt.id, data };
    } catch (error) {
      if (receipt) { receipt.state = 'needs-check'; receipt.invalidReason = error instanceof Error ? error.message : '写入未完成。'; this.services.changed(); }
      const outcome = failure(error);
      if (wrote && receipt) { outcome.actionId = receipt.id; outcome.data = { wrote: true, verified: false, path: document.path }; }
      return outcome;
    } finally {
      if (locked) this.services.editing.delete(document.id);
    }
  }

  private validateUndo(document: DocumentRecord, receipt: AgentActionReceipt, text: string): void {
    if (receipt.documentId !== document.id || receipt.path !== document.path || receipt.state !== 'applied' || !matches(text, receipt.anchor)
      || (receipt.beforeContext && !matches(text, receipt.beforeContext)) || (receipt.afterContext && !matches(text, receipt.afterContext))) throw new Conflict('该操作文字或上下文已变化，目前不能安全撤回。');
    checkProtected(text, replaceExact(text, receipt.anchor.from, receipt.anchor.to, receipt.before));
  }
  canUndo(document: DocumentRecord, id: string): boolean {
    const receipt = this.services.receipts(document.id).find(item => item.id === id);
    if (!receipt || this.services.editing.has(document.id)) return false;
    try {
      const text = this.services.documents.bufferText(document) ?? this.text.get(document.id);
      if (text === undefined) return false;
      this.reconcile(document, text);
      this.validateUndo(document, receipt, text); return true;
    } catch { return false; }
  }
  async undo(document: DocumentRecord, id: string, signal?: AbortSignal): Promise<ToolOutcome> {
    let locked = false, wrote = false;
    let receipt: AgentActionReceipt | undefined;
    try {
      assertSignal(signal);
      receipt = this.services.receipts(document.id).find(item => item.id === id);
      if (!receipt) throw new Conflict('撤回引用不属于当前文稿。');
      if (receipt.documentId !== document.id || receipt.path !== document.path) throw new Conflict('撤回记录的文稿身份不匹配。');
      if (receipt.state === 'undone') return { status: 'noop', message: '这项操作已经撤回。', actionId: id };
      if (this.services.editing.has(document.id)) throw new Conflict('此文稿正在写入，请稍后重试。');
      this.services.editing.add(document.id); locked = true;
      const before = await this.latest(document); assertSignal(signal); this.validateUndo(document, receipt, before);
      const from = receipt.anchor.from, to = receipt.anchor.to;
      this.ownReceipts.add(id);
      const action = receipt;
      try {
        await this.services.documents.applyRangeValidated(document, before, from, to, action.before, current => {
          assertSignal(signal);
          if (action.anchor.from !== from || action.anchor.to !== to) throw new Conflict('撤回前操作位置已变化。');
          this.validateUndo(document, action, current);
        });
        wrote = true;
      } finally { this.ownReceipts.delete(id); }
      const after = replaceExact(before, from, to, receipt.before), delta = receipt.before.length - (to - from);
      if (receipt.afterContext) { receipt.afterContext.from += delta; receipt.afterContext.to += delta; }
      receipt.anchor = { from, to: from + receipt.before.length, text: receipt.before, valid: true }; receipt.state = 'undone';
      receipt.beforeHash = hashText(after);
      this.text.set(document.id, after); this.services.changed();
      const verified = await this.latest(document);
      if (receipt.state !== 'undone' || !matches(verified, receipt.anchor) || receipt.anchor.text !== receipt.before)
        throw new Conflict('已执行局部撤回，但最新文字无法核实。请检查文稿，勿重复操作。');
      const data = { path: document.path, kind: receipt.kind, label: receipt.label, verified: true, undone: true };
      try { await this.services.save(); }
      catch { return { status: 'success', message: '已局部撤回，但回执保存失败。请保留当前窗口，勿重复操作。', actionId: id, data: { ...data, persistenceWarning: true } }; }
      return { status: 'success', message: '已撤回这项操作，保留其他修改。', actionId: id, data };
    } catch (error) {
      const result = failure(error);
      if (wrote && receipt) { receipt.state = 'needs-check'; receipt.invalidReason = result.message; result.actionId = id; result.data = { wrote: true, verified: false, path: document.path }; this.services.changed(); }
      return result;
    }
    finally { if (locked) this.services.editing.delete(document.id); }
  }
}
