import { randomUUID } from 'node:crypto';
import type { Documents } from './documents';
import { bodyStart, hashText, replaceExact } from './editing';
import type { Store } from './store';
import type { Session, Role } from './types';
import { ReviewAnchors } from './review-anchors';
import { authorSnapshot, currentVersion, ensureReview } from './review-types';
import type { ApplyReceipt, ReviewCapture, ReviewResult, ReviewRun, Suggestion, SuggestionPreview, SuggestionVersion, TextAnchor } from './review-types';

function suggestionAfter(before: string, from: number, to: number, replacement: string): string {
  const after = replaceExact(before, from, to, replacement);
  const start = bodyStart(before);
  if (bodyStart(after) !== start || after.slice(0, start) !== before.slice(0, start))
    throw new Error('建议会改变 frontmatter 边界，请重新生成只修改正文的建议。');
  return after;
}

export class Reviews {
  readonly anchors: ReviewAnchors;
  constructor(private store: Store, private documents: Documents, private changed: () => void,
    private event: (session: Session, text: string) => void, private editing: Set<string>) {
    this.anchors = new ReviewAnchors(id => store.data.sessions[id]);
  }
  session(documentId: string): Session {
    const session = this.store.data.sessions[documentId];
    if (!session || session.document.deleted) throw new Error('批注所属文稿已删除或无法确认身份。');
    this.documents.resolve(documentId);
    return session;
  }
  suggestion(documentId: string, id: string): Suggestion {
    const s = this.session(documentId).review?.suggestions.find(s => s.id === id);
    if (!s) throw new Error('批注不存在。');
    return s;
  }
  async latest(documentId: string): Promise<string> {
    const session = this.session(documentId);
    const read = await this.documents.read(session.document);
    // A preview may have yielded while a real editor transaction advanced the ledger.
    // Re-check the buffer synchronously instead of treating that stale read as external text.
    const text = this.documents.bufferText(session.document) ?? read;
    this.anchors.track(documentId, text);
    return text;
  }
  addResult(session: Session, run: ReviewRun, capture: ReviewCapture, result: ReviewResult, role: Role): void {
    const review = ensureReview(session);
    let added = 0, duplicates = 0;
    for (const input of result.suggestions) {
      const resolution = this.anchors.resolve(capture, input);
      const fingerprint = hashText(JSON.stringify([role.id, role.systemPrompt, input.type, input.title, input.quote,
        input.contextBefore, input.contextAfter, input.reason, input.replacement, [...new Set(input.evidenceQuotes ?? [])].sort()]));
      const duplicate = resolution.anchors && review.suggestions.find(s => s.fingerprint === fingerprint && s.anchors?.target.valid &&
        s.anchors.target.from === resolution.anchors!.target.from && s.anchors.target.to === resolution.anchors!.target.to);
      if (duplicate) { duplicates++; continue; }
      const version: SuggestionVersion = { id: randomUUID(), at: Date.now(), author: authorSnapshot(role), reason: input.reason, replacement: input.replacement, evidenceQuotes: input.evidenceQuotes ?? [] };
      const suggestion: Suggestion = {
        id: randomUUID(), documentId: session.document.id, runId: run.id,
        number: Math.max(0, ...review.suggestions.map(s => s.number)) + 1,
        type: input.type, title: input.title, quote: input.quote, contextBefore: input.contextBefore, contextAfter: input.contextAfter,
        author: authorSnapshot(role), versions: [version], currentVersionId: version.id, anchors: resolution.anchors,
        state: resolution.anchors ? input.replacement === null ? 'comment' : 'pending' : 'unlocated',
        invalidReason: resolution.reason, fingerprint, replies: [],
      };
      if (resolution.anchors && (!resolution.anchors.target.valid || resolution.reason)) suggestion.state = 'needs-check';
      review.suggestions.push(suggestion); added++;
    }
    run.summary = result.summary; run.overall = result.overall; run.added = added; run.duplicates = duplicates; run.status = 'completed';
    if (!review.selectedId || !review.suggestions.some(s => s.id === review.selectedId && ['pending','comment'].includes(s.state))) {
      review.selectedId = review.suggestions.find(s => ['pending','comment'].includes(s.state))?.id
        ?? review.suggestions.find(s => s.runId === run.id && ['unlocated','needs-check'].includes(s.state))?.id;
    }
    this.event(session, `审阅完成：新增 ${added} 条句级批注，重复 ${duplicates} 条。批注均为候选；已忽略意见不会自动恢复。`);
  }
  revise(s: Suggestion, capture: ReviewCapture, role: Role, revision: {reason:string;replacement:string;evidenceQuotes:string[]}): void {
    const old = currentVersion(s);
    if (!['pending','comment'].includes(s.state) || !s.anchors) throw new Error('当前批注已处理或需要重新审阅，不能扩大或重建旧授权范围。');
    const latest = this.anchors.currentText(s.documentId);
    if (latest === undefined) throw new Error('无法确认当前文稿版本，请重新审阅。');
    // s.anchors has already been mapped through known editor changes.  Validate
    // it in that current text, never against the older network snapshot.
    this.anchors.validate(s, latest);
    const frozen = capture.snapshot;
    // Resolve from the frozen request range and original model-quoted context,
    // then replay the retained transaction chain.  This prevents a harmless
    // insertion before the target from being mistaken for an edited target.
    const resolution = this.anchors.resolve(capture, { type: s.type, title: s.title, quote: s.quote,
      contextBefore: s.contextBefore, contextAfter: s.contextAfter, reason: revision.reason,
      replacement: revision.replacement, evidenceQuotes: revision.evidenceQuotes });
    if (!resolution.anchors || resolution.reason || !resolution.anchors.target.valid ||
      resolution.anchors.target.from !== s.anchors.target.from || resolution.anchors.target.to !== s.anchors.target.to ||
      frozen.documentId !== s.documentId) throw new Error('生成期间原句或依据变化，请重新审阅。');
    const version: SuggestionVersion = { id: randomUUID(), at: Date.now(), author: authorSnapshot(role), ...revision };
    old.supersededBy = version.id; s.versions.push(version); s.currentVersionId = version.id;
    // Preserve original authorization scope and independent context anchors.
    s.anchors.evidence = resolution.anchors.evidence; s.state = 'pending'; s.invalidReason = undefined;
  }
  async preview(documentId: string, id: string): Promise<SuggestionPreview> {
    const s = this.suggestion(documentId,id); const before = await this.latest(documentId);
    const version = currentVersion(s); const path = this.documents.resolve(documentId).path;
    try {
      if (!['pending','comment'].includes(s.state)) throw new Error(s.invalidReason || '这条意见已处理或需要重新检查。这里只展示旧引用和候选。');
      this.anchors.validate(s,before); const {from,to} = s.anchors!.target;
      return {documentId,path,suggestion:s,version,before,after:version.replacement === null ? before : suggestionAfter(before,from,to,version.replacement),from,to,valid:true};
    } catch (e) { return {documentId,path,suggestion:s,version,before,valid:false,reason:e instanceof Error ? e.message : '无法定位当前原句。'}; }
  }
  next(session: Session, currentId: string): void {
    const r = ensureReview(session), at = r.suggestions.findIndex(s => s.id === currentId);
    const ordered = [...r.suggestions.slice(at+1), ...r.suggestions.slice(0,at)];
    r.selectedId = ordered.find(s => ['pending','comment'].includes(s.state) && s.anchors?.target.valid)?.id;
  }
  async accept(documentId: string, id: string): Promise<void> {
    const session = this.session(documentId), s = this.suggestion(documentId,id), r = ensureReview(session), version = currentVersion(s);
    if (this.editing.has(documentId)) throw new Error('此文稿正在写入，请稍后重试。');
    if (s.state !== 'pending' || version.replacement === null) throw new Error('此批注没有可采纳的新句，或已处理。');
    this.editing.add(documentId); s.state = 'applying'; this.changed();
    let wrote = false; let receipt: ApplyReceipt | undefined;
    try {
      const before = await this.latest(documentId); this.anchors.validate(s,before);
      const {from,to} = s.anchors!.target, replacement = version.replacement;
      const after = suggestionAfter(before,from,to,replacement);
      receipt = {id:randomUUID(),suggestionId:id,versionId:version.id,documentId,at:Date.now(),before:before.slice(from,to),replacement,
        anchor:{from,to:from+replacement.length,text:replacement,valid:true}, beforeContext:s.anchors!.before ? {...s.anchors!.before} : undefined,
        afterContext:s.anchors!.after ? {...s.anchors!.after} : undefined,state:'needs-check',beforeHash:hashText(before),afterHash:hashText(after)};
      // Persist the intent before writing; a restart cannot mistake an interrupted write for acceptance.
      await this.store.save();
      await this.documents.applyRangeValidated(session.document,before,from,to,replacement,current => this.anchors.validate(s,current));
      wrote = true;
      const delta = replacement.length-(to-from);
      if (receipt.afterContext) {receipt.afterContext.from += delta;receipt.afterContext.to += delta;}
      receipt.state = 'applied'; r.receipts.push(receipt); s.state = 'applied'; s.handledAt = Date.now(); s.invalidReason = undefined;
      if (session.candidate?.state === 'ready') session.candidate.state = 'stale';
      this.event(session, `已采纳批注 ${s.number}「${s.title}」的版本 ${version.id}。仅此原句写入正文；其他未采纳建议仍为候选。`);
      this.next(session,id); await this.store.save();
    } catch (e) {
      if (!wrote) { s.state = 'needs-check'; s.invalidReason = e instanceof Error ? e.message : '写入未完成。'; }
      else throw new Error('本条已写入，但撤回记录保存失败。请保留当前窗口，检查存储空间后重新保存配置；不要重复采纳。');
      throw e;
    } finally { this.editing.delete(documentId); this.changed(); }
  }
  async ignore(documentId: string, id: string): Promise<void> {
    const session = this.session(documentId), s = this.suggestion(documentId,id);
    if (this.editing.has(documentId) || s.state === 'applying') throw new Error('请等待此文稿的写入完成。');
    if (['ignored','applied'].includes(s.state)) return;
    const previous = s.state; s.state = 'ignored'; s.handledAt = Date.now();
    try { await this.store.save(); } catch(e) {s.state=previous;s.handledAt=undefined;throw e;}
    this.event(session, `已忽略批注 ${s.number}「${s.title}」，用户明确拒绝此建议，正文没有修改。`);
    this.next(session,id); this.changed(); await this.store.save();
  }
  canUndo(documentId:string,id:string):boolean {
    const session = this.store.data.sessions[documentId]; const text = this.anchors.currentText(documentId);
    const receipt = session?.review?.receipts.filter(r => r.suggestionId===id && r.state==='applied').at(-1);
    if (!receipt || text===undefined || !this.anchors.canUndo(receipt,text) || this.editing.has(documentId)) return false;
    try { suggestionAfter(text,receipt.anchor.from,receipt.anchor.to,receipt.before); return true; }
    catch { return false; }
  }
  async undo(documentId:string,id:string):Promise<void> {
    const session = this.session(documentId), s=this.suggestion(documentId,id), r=ensureReview(session);
    const receipt = r.receipts.filter(r=>r.suggestionId===id && r.state==='applied').at(-1);
    if (!receipt || this.editing.has(documentId)) throw new Error('没有可安全撤回的这条修改，或文稿正在写入。');
    this.editing.add(documentId);
    try {
      const before=await this.latest(documentId); this.anchors.validateUndo(receipt,before);
      const {from,to}=receipt.anchor;
      suggestionAfter(before,from,to,receipt.before);
      await this.documents.applyRangeValidated(session.document,before,from,to,receipt.before,current=>this.anchors.validateUndo(receipt,current));
      receipt.state='undone';receipt.anchor={from,to:from+receipt.before.length,text:receipt.before,valid:true};
      s.state='pending';s.handledAt=undefined;s.invalidReason=undefined;
      if (s.anchors) {s.anchors.target={...receipt.anchor};s.anchors.before=receipt.beforeContext;s.anchors.after=receipt.afterContext;}
      const latest = this.anchors.currentText(documentId);
      const supports = s.anchors && (!s.anchors.before || s.anchors.before.valid) && (!s.anchors.after || s.anchors.after.valid) && s.anchors.evidence.every(anchor => anchor.valid);
      try {
        if (!latest || !supports) throw new Error('关键上下文或依据无法确认');
        this.anchors.validate(s, latest);
      } catch {
        s.state='needs-check';s.invalidReason='原句已撤回，但关键上下文或依据无法确认，请重新审阅。';
      }
      if (session.candidate?.state==='ready') session.candidate.state='stale';
      this.event(session,`已逐条撤回批注 ${s.number}，保留后续无关修改。`);
      r.selectedId=id; await this.store.save();
    } finally {this.editing.delete(documentId);this.changed();}
  }
}
