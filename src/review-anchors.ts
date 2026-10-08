import { bodyStart, hashText } from './editing';
import { currentVersion, ensureReview } from './review-types';
import type { ApplyReceipt, ChangeKind, ReviewCapture, ReviewSuggestionInput, Suggestion, SuggestionAnchors, TextAnchor, TextChange } from './review-types';
import type { DocumentSnapshot, Session } from './types';

/**
 * Keeps the small, mutable part of review positioning in memory.  Persisted
 * anchors are deliberately only trusted again after the document hash has
 * been checked by the caller on startup.
 */
interface ChangeRecord { sequence: number; changes: TextChange[]; kind: ChangeKind; }
interface TrackedDocument { text?: string; sequence: number; gapSequence?: number; changes: ChangeRecord[]; captures: Map<number, number>; }

function safeBoundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
  const previous = offset > 0 ? text.charCodeAt(offset - 1) : 0;
  const next = offset < text.length ? text.charCodeAt(offset) : 0;
  // Do not split a UTF-16 pair or a CRLF line ending.  CM uses UTF-16 offsets.
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) &&
    !(previous === 0x0d && next === 0x0a);
}

function cloneChange(change: TextChange): TextChange { return { from: change.from, to: change.to, insert: change.insert }; }

function sorted(changes: TextChange[]): TextChange[] {
  return [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
}

function changesProduce(before: string, changes: TextChange[]): string | undefined {
  let cursor = 0;
  let output = '';
  for (const change of sorted(changes)) {
    if (!Number.isInteger(change.from) || !Number.isInteger(change.to) ||
      change.from < cursor || change.to < change.from || change.to > before.length ||
      typeof change.insert !== 'string' || !safeBoundary(before, change.from) || !safeBoundary(before, change.to)) return undefined;
    output += before.slice(cursor, change.from) + change.insert;
    cursor = change.to;
  }
  return output + before.slice(cursor);
}

function intersects(change: TextChange, from: number, to: number): boolean {
  if (change.from === change.to) return change.from > from && change.from < to;
  return change.from < to && change.to > from;
}

/** Maps a position through a set of simultaneous, pre-change-coordinate edits. */
function mapPosition(position: number, assoc: -1 | 1, changes: TextChange[]): number {
  let delta = 0;
  for (const change of sorted(changes)) {
    if (position < change.from) break;
    if (position > change.to) { delta += change.insert.length - (change.to - change.from); continue; }
    // An insertion at an anchor boundary belongs outside the anchor: start has
    // assoc +1, end has assoc -1.  This is important for later safe undo.
    if (position === change.from && position === change.to) return change.from + delta + (assoc > 0 ? change.insert.length : 0);
    if (position === change.from) return change.from + delta + (assoc > 0 ? change.insert.length : 0);
    if (position === change.to) return change.from + delta + change.insert.length;
    return change.from + delta + (assoc > 0 ? change.insert.length : 0);
  }
  return position + delta;
}

function mapAnchor(anchor: TextAnchor | undefined, changes: TextChange[], invalidate: boolean): void {
  if (!anchor) return;
  if (invalidate && changes.some(change => intersects(change, anchor.from, anchor.to))) anchor.valid = false;
  anchor.from = mapPosition(anchor.from, 1, changes);
  anchor.to = Math.max(anchor.from, mapPosition(anchor.to, -1, changes));
}

function mapScopeBoundary(position: number, edge: 'start' | 'end', changes: TextChange[]): number {
  let delta = 0;
  for (const change of sorted(changes)) {
    if (position < change.from) break;
    if (position > change.to) { delta += change.insert.length - (change.to - change.from); continue; }
    if (change.from === change.to) return change.from + delta + (edge === 'start' ? change.insert.length : 0);
    // A replacement that includes the authorization boundary carries that
    // boundary with it.  A pure insertion at the boundary remains outside it.
    if (position === change.from) return change.from + delta;
    if (position === change.to) return change.from + delta + change.insert.length;
    return change.from + delta + (edge === 'start' ? 0 : change.insert.length);
  }
  return position + delta;
}

function uniqueIndex(text: string, needle: string, from = 0, to = text.length): number | undefined {
  let result = -1;
  for (let at = text.indexOf(needle, from); at !== -1 && at + needle.length <= to; at = text.indexOf(needle, at + 1)) {
    if (result !== -1) return undefined;
    result = at;
  }
  return result === -1 ? undefined : result;
}

function textAnchor(text: string, from: number, to: number): TextAnchor {
  return { from, to, text: text.slice(from, to), valid: true };
}

function requireInRange(text: string, from: number, to: number, expected: string, label: string): void {
  if (!safeBoundary(text, from) || !safeBoundary(text, to) || from < 0 || to < from || to > text.length || text.slice(from, to) !== expected) {
    throw new Error(`${label}已变化，请重新审阅。`);
  }
}

function anchorMatches(text: string, anchor: TextAnchor | undefined): boolean {
  return !!anchor && anchor.valid && safeBoundary(text, anchor.from) && safeBoundary(text, anchor.to) &&
    anchor.from >= 0 && anchor.to >= anchor.from && anchor.to <= text.length && text.slice(anchor.from, anchor.to) === anchor.text;
}

export class ReviewAnchors {
  private readonly documents = new Map<string, TrackedDocument>();
  constructor(private readonly sessionFor: (id: string) => Session | undefined) {}

  private tracked(documentId: string): TrackedDocument {
    let tracked = this.documents.get(documentId);
    if (!tracked) { tracked = { sequence: 0, changes: [], captures: new Map() }; this.documents.set(documentId, tracked); }
    return tracked;
  }

  track(documentId: string, text: string): void {
    const tracked = this.tracked(documentId);
    const session = this.sessionFor(documentId);
    const review = session ? ensureReview(session) : undefined;
    if (tracked.text === undefined && review?.verifiedHash && review.verifiedHash !== hashText(text)) {
      tracked.sequence += 1; tracked.gapSequence = tracked.sequence;
      this.invalidate(documentId, '重启后无法确认文稿版本');
    }
    if (tracked.text !== undefined && tracked.text !== text) {
      tracked.sequence += 1; tracked.gapSequence = tracked.sequence;
      this.invalidate(documentId, '无法确认的外部修改');
    }
    tracked.text = text;
    if (review) review.verifiedHash = hashText(text);
  }

  currentText(documentId: string): string | undefined { return this.documents.get(documentId)?.text; }

  capture(snapshot: DocumentSnapshot): ReviewCapture {
    const tracked = this.tracked(snapshot.documentId);
    if (tracked.text === undefined) tracked.text = snapshot.fullText;
    // A capture is always made from the actual request snapshot.  If it is not
    // the current continuous version, it cannot later be safely replayed.
    if (tracked.text !== snapshot.fullText) this.invalidate(snapshot.documentId, '审阅快照不在已知版本链中');
    tracked.text = snapshot.fullText;
    const sequence = tracked.sequence;
    tracked.captures.set(sequence, (tracked.captures.get(sequence) ?? 0) + 1);
    return { snapshot, sequence };
  }

  release(capture: ReviewCapture): void {
    const tracked = this.documents.get(capture.snapshot.documentId);
    if (!tracked) return;
    const count = tracked.captures.get(capture.sequence) ?? 0;
    if (count <= 1) tracked.captures.delete(capture.sequence); else tracked.captures.set(capture.sequence, count - 1);
    const floor = Math.min(...tracked.captures.keys());
    if (Number.isFinite(floor)) tracked.changes = tracked.changes.filter(record => record.sequence > floor);
    else tracked.changes = [];
  }

  resolve(capture: ReviewCapture, input: ReviewSuggestionInput): { anchors?: SuggestionAnchors; reason?: string } {
    const { snapshot } = capture;
    const tracked = this.tracked(snapshot.documentId);
    if (!input.quote || !safeBoundary(snapshot.fullText, snapshot.from) || !safeBoundary(snapshot.fullText, snapshot.to)) {
      return { reason: '审稿结果缺少可定位的原句或范围无效。' };
    }
    let candidates: number[] = [];
    for (let at = snapshot.fullText.indexOf(input.quote); at !== -1; at = snapshot.fullText.indexOf(input.quote, at + 1)) {
      const end = at + input.quote.length;
      if (at < snapshot.from || end > snapshot.to) continue;
      if (input.contextBefore && snapshot.fullText.slice(at - input.contextBefore.length, at) !== input.contextBefore) continue;
      if (input.contextAfter && snapshot.fullText.slice(end, end + input.contextAfter.length) !== input.contextAfter) continue;
      candidates.push(at);
    }
    if (candidates.length !== 1) return { reason: candidates.length ? '原句在授权范围内仍不唯一，未形成可应用批注。' : '原句或上下文不在冻结文稿范围内，未形成可应用批注。' };
    const from = candidates[0]!;
    const to = from + input.quote.length;
    const anchors: SuggestionAnchors = {
      target: textAnchor(snapshot.fullText, from, to),
      scope: { from: snapshot.from, to: snapshot.to, valid: true },
      evidence: [],
    };
    if (input.contextBefore) anchors.before = textAnchor(snapshot.fullText, from - input.contextBefore.length, from);
    if (input.contextAfter) anchors.after = textAnchor(snapshot.fullText, to, to + input.contextAfter.length);
    for (const evidence of input.evidenceQuotes ?? []) {
      const at = uniqueIndex(snapshot.fullText, evidence);
      if (at === undefined) return { reason: '依据引用无法唯一定位，未形成可应用批注。' };
      anchors.evidence.push(textAnchor(snapshot.fullText, at, at + evidence.length));
    }
    if (tracked.gapSequence !== undefined && capture.sequence < tracked.gapSequence) return { reason: '审阅期间版本链中断，请重新审阅。' };
    if (tracked.text !== snapshot.fullText && tracked.sequence === capture.sequence) return { reason: '审阅期间版本链中断，请重新审阅。' };
    for (const record of tracked.changes.filter(record => record.sequence > capture.sequence)) this.mapAnchors(anchors, record.changes);
    const criticalValid = anchors.target.valid && anchors.scope.valid &&
      (!anchors.before || anchors.before.valid) && (!anchors.after || anchors.after.valid) && anchors.evidence.every(anchor => anchor.valid);
    if (!criticalValid) anchors.target.valid = false;
    return criticalValid ? { anchors } : { anchors, reason: '审阅期间原句、上下文或关键依据已变化，需要重新检查。' };
  }

  /**
   * Adds a known editor transaction.  A repeated after-value is the ordinary
   * multi-pane/vault echo and must not map anchors a second time.
   */
  update(documentId: string, before: string, after: string, changes: TextChange[], kind: ChangeKind = 'edit'): boolean {
    const tracked = this.tracked(documentId);
    const produced = changesProduce(before, changes);
    if (produced !== after) {
      tracked.text = after;
      tracked.sequence += 1; tracked.gapSequence = tracked.sequence;
      this.invalidate(documentId, '编辑事务坐标无效，无法安全定位批注');
      return false;
    }
    if (tracked.text === after) return true;
    if (tracked.text === undefined) tracked.text = before;
    if (tracked.text !== before) {
      tracked.text = after;
      tracked.sequence += 1; tracked.gapSequence = tracked.sequence;
      this.invalidate(documentId, '文稿版本分叉或存在未知外部修改');
      return false;
    }
    const special = this.reconcileNative(documentId, before, changes, kind);
    this.mapDocument(documentId, changes, special);
    tracked.text = after;
    tracked.sequence += 1;
    tracked.changes.push({ sequence: tracked.sequence, changes: changes.map(cloneChange), kind });
    const session = this.sessionFor(documentId);
    if (session) ensureReview(session).verifiedHash = hashText(after);
    return true;
  }

  private mapAnchors(anchors: SuggestionAnchors, changes: TextChange[]): void {
    const targetChanged = changes.some(change => intersects(change, anchors.target.from, anchors.target.to));
    mapAnchor(anchors.target, changes, targetChanged);
    mapAnchor(anchors.before, changes, changes.some(change => !!anchors.before && intersects(change, anchors.before.from, anchors.before.to)));
    mapAnchor(anchors.after, changes, changes.some(change => !!anchors.after && intersects(change, anchors.after.from, anchors.after.to)));
    for (const evidence of anchors.evidence) mapAnchor(evidence, changes, changes.some(change => intersects(change, evidence.from, evidence.to)));
    anchors.scope.from = mapScopeBoundary(anchors.scope.from, 'start', changes);
    anchors.scope.to = Math.max(anchors.scope.from, mapScopeBoundary(anchors.scope.to, 'end', changes));
  }

  private mapDocument(documentId: string, changes: TextChange[], special: Set<string>): void {
    const session = this.sessionFor(documentId);
    if (!session?.review) return;
    const review = session.review;
    for (const suggestion of review.suggestions) {
      if (!suggestion.anchors) continue;
      if (special.has(`suggestion:${suggestion.id}`)) {
        this.mapSupportingAnchors(suggestion.anchors, changes);
        if ((suggestion.anchors.before && !suggestion.anchors.before.valid) ||
          (suggestion.anchors.after && !suggestion.anchors.after.valid) || suggestion.anchors.evidence.some(anchor => !anchor.valid)) {
          suggestion.state = 'needs-check'; suggestion.invalidReason = '原句已恢复，但关键上下文或依据无法确认，请重新审阅。';
        }
        continue;
      }
      const before = suggestion.anchors.target.valid;
      this.mapAnchors(suggestion.anchors, changes);
      if (before && !suggestion.anchors.target.valid && suggestion.state !== 'ignored') {
        suggestion.state = 'needs-check'; suggestion.invalidReason = '原句或关键依据已被修改';
      }
      if (suggestion.anchors.evidence.some(anchor => !anchor.valid) || (suggestion.anchors.before && !suggestion.anchors.before.valid) || (suggestion.anchors.after && !suggestion.anchors.after.valid)) {
        if (suggestion.state !== 'ignored' && suggestion.state !== 'unlocated') { suggestion.state = 'needs-check'; suggestion.invalidReason = '关键上下文或依据已被修改'; }
      }
    }
    for (const receipt of review.receipts) {
      if (special.has(`receipt:${receipt.id}`)) {
        if (receipt.beforeContext) mapAnchor(receipt.beforeContext, changes, changes.some(change => intersects(change, receipt.beforeContext!.from, receipt.beforeContext!.to)));
        if (receipt.afterContext) mapAnchor(receipt.afterContext, changes, changes.some(change => intersects(change, receipt.afterContext!.from, receipt.afterContext!.to)));
        continue;
      }
      const changed = changes.some(change => intersects(change, receipt.anchor.from, receipt.anchor.to) ||
        (!!receipt.beforeContext && intersects(change, receipt.beforeContext.from, receipt.beforeContext.to)) ||
        (!!receipt.afterContext && intersects(change, receipt.afterContext.from, receipt.afterContext.to)));
      mapAnchor(receipt.anchor, changes, changed);
      mapAnchor(receipt.beforeContext, changes, changed);
      mapAnchor(receipt.afterContext, changes, changed);
      if (changed && receipt.state === 'applied') {
        receipt.state = 'needs-check';
        const suggestion = review.suggestions.find(item => item.id === receipt.suggestionId);
        if (suggestion?.state === 'applied') {
          suggestion.state = 'needs-check'; suggestion.invalidReason = '已采纳文字或撤回依据被修改，无法安全确认状态';
        }
      }
    }
  }

  private mapSupportingAnchors(anchors: SuggestionAnchors, changes: TextChange[]): void {
    mapAnchor(anchors.before, changes, changes.some(change => !!anchors.before && intersects(change, anchors.before.from, anchors.before.to)));
    mapAnchor(anchors.after, changes, changes.some(change => !!anchors.after && intersects(change, anchors.after.from, anchors.after.to)));
    for (const evidence of anchors.evidence) mapAnchor(evidence, changes, changes.some(change => intersects(change, evidence.from, evidence.to)));
    anchors.scope.from = mapScopeBoundary(anchors.scope.from, 'start', changes);
    anchors.scope.to = Math.max(anchors.scope.from, mapScopeBoundary(anchors.scope.to, 'end', changes));
  }

  private reconcileNative(documentId: string, before: string, changes: TextChange[], kind: ChangeKind): Set<string> {
    const special = new Set<string>();
    if (kind !== 'undo' && kind !== 'redo') return special;
    const review = this.sessionFor(documentId)?.review;
    // A native history transaction can be represented as the smallest changed
    // middle, retaining equal prefix/suffix around our replacement.  Do not
    // infer anything from multi-change transactions: an unrelated companion
    // change makes the history step ambiguous for a persisted receipt.
    if (!review || changes.length !== 1) return special;
    const change = changes[0]!;
    for (const receipt of review.receipts) {
      const suggestion = review.suggestions.find(item => item.id === receipt.suggestionId);
      if (!suggestion || receipt.documentId !== documentId || suggestion.documentId !== documentId ||
        !suggestion.versions.some(version => version.id === receipt.versionId) || !anchorMatches(before, receipt.anchor) ||
        (receipt.beforeContext && !anchorMatches(before, receipt.beforeContext)) || (receipt.afterContext && !anchorMatches(before, receipt.afterContext))) continue;
      const relativeFrom = change.from - receipt.anchor.from;
      const relativeTo = change.to - receipt.anchor.from;
      if (relativeFrom < 0 || relativeTo < relativeFrom || relativeTo > receipt.anchor.text.length ||
        !safeBoundary(before, change.from) || !safeBoundary(before, change.to)) continue;
      if (kind === 'undo' && receipt.state === 'applied') {
        const restored = receipt.replacement.slice(0, relativeFrom) + change.insert + receipt.replacement.slice(relativeTo);
        if (restored !== receipt.before) continue;
        receipt.state = 'undone'; receipt.anchor = { from: receipt.anchor.from, to: receipt.anchor.from + receipt.before.length, text: receipt.before, valid: true };
        suggestion.anchors && (suggestion.anchors.target = { ...receipt.anchor });
        suggestion.state = 'pending'; delete suggestion.invalidReason;
        special.add(`receipt:${receipt.id}`); special.add(`suggestion:${suggestion.id}`);
      }
      if (kind === 'redo' && receipt.state === 'undone') {
        const reapplied = receipt.before.slice(0, relativeFrom) + change.insert + receipt.before.slice(relativeTo);
        if (reapplied !== receipt.replacement) continue;
        receipt.state = 'applied'; receipt.anchor = { from: receipt.anchor.from, to: receipt.anchor.from + receipt.replacement.length, text: receipt.replacement, valid: true };
        suggestion.state = 'applied'; delete suggestion.invalidReason;
        special.add(`receipt:${receipt.id}`); special.add(`suggestion:${suggestion.id}`);
      }
    }
    return special;
  }

  validate(suggestion: Suggestion, text: string): void {
    const anchors = suggestion.anchors;
    if (!anchors || !anchors.target.valid || !anchors.scope.valid) throw new Error('批注无法可靠定位，请重新审阅。');
    const version = currentVersion(suggestion);
    if (version.replacement !== null && !version.replacement.trim()) throw new Error('空替换不能自动删除正文。');
    const start = bodyStart(text);
    if (anchors.scope.from < start || anchors.target.from < start || anchors.target.from < anchors.scope.from || anchors.target.to > anchors.scope.to) throw new Error('批注范围进入受保护区域或超出原授权范围。');
    requireInRange(text, anchors.target.from, anchors.target.to, suggestion.quote, '原句');
    if (anchors.before) requireInRange(text, anchors.before.from, anchors.before.to, suggestion.contextBefore, '前文');
    if (anchors.after) requireInRange(text, anchors.after.from, anchors.after.to, suggestion.contextAfter, '后文');
    for (const evidence of anchors.evidence) requireInRange(text, evidence.from, evidence.to, evidence.text, '依据');
  }

  canUndo(receipt: ApplyReceipt, text: string): boolean { try { this.validateUndo(receipt, text); return true; } catch { return false; } }

  validateUndo(receipt: ApplyReceipt, text: string): void {
    if (receipt.state !== 'applied' || !receipt.anchor.valid) throw new Error('该修改目前不能安全撤回。');
    requireInRange(text, receipt.anchor.from, receipt.anchor.to, receipt.replacement, '已采纳文字');
    if (receipt.beforeContext) requireInRange(text, receipt.beforeContext.from, receipt.beforeContext.to, receipt.beforeContext.text, '撤回前文');
    if (receipt.afterContext) requireInRange(text, receipt.afterContext.from, receipt.afterContext.to, receipt.afterContext.text, '撤回后文');
  }

  invalidate(documentId: string, reason: string): void {
    const session = this.sessionFor(documentId);
    if (!session?.review) return;
    for (const suggestion of session.review.suggestions) {
      if (suggestion.state === 'ignored' || suggestion.state === 'comment' || suggestion.state === 'unlocated') continue;
      suggestion.state = 'needs-check'; suggestion.invalidReason = reason;
      if (suggestion.anchors) { suggestion.anchors.target.valid = false; for (const evidence of suggestion.anchors.evidence) evidence.valid = false; }
    }
    for (const receipt of session.review.receipts) if (receipt.state === 'applied') receipt.state = 'needs-check';
  }

  forget(documentId: string): void { this.documents.delete(documentId); }
}
