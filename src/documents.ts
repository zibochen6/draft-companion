import { App, MarkdownView, TFile, type TAbstractFile, type WorkspaceLeaf, type Editor } from 'obsidian';
import { randomUUID } from 'node:crypto';
import { bodyStart, hashText, replaceExact, undoAfter } from './editing';
import type { DocumentRecord, DocumentSnapshot, EditScope, Session, UndoRecord } from './types';
import type { ChangeKind, SelectionSummary, TextChange, TextAnchor } from './review-types';
import {nativeFileIdentity} from './document-identity';

export interface DocumentChange {
  documentId: string; before: string; after: string; changes: TextChange[]; kind: ChangeKind;
}

type ChangeListener = (change: DocumentChange) => void;
interface CachedSelection { kind: SelectionSummary['kind']; from?: number; to?: number; characters: number; textHash?: string }

/** CodeMirror has LF logical lines, while a vault file can retain CRLF. */
export function rawOffsetToCmOffset(raw: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > raw.length) throw new Error('范围无效。');
  let cm = 0;
  for (let index = 0; index < offset; index++, cm++) if (raw[index] === '\r' && raw[index + 1] === '\n') index++;
  return cm;
}
export function cmOffsetToRawOffset(raw: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('范围无效。');
  let cm = 0;
  for (let index = 0; index < raw.length; index++) {
    if (cm === offset) return index;
    if (raw[index] === '\r' && raw[index + 1] === '\n') index++;
    cm++;
  }
  if (cm === offset) return raw.length;
  throw new Error('范围无效。');
}
export function isSafeTextBoundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
    && !(before === 0x0d && after === 0x0a);
}
function checkedRange(text: string, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length
    || !isSafeTextBoundary(text, from) || !isSafeTextBoundary(text, to)) throw new Error('范围无效。');
}
function replacementAfter(text: string, from: number, to: number, replacement: string): string {
  checkedRange(text, from, to); return replaceExact(text, from, to, replacement);
}

export class Documents {
  private target: MarkdownView | null = null;
  private pinnedId: string | undefined;
  private ids = new WeakMap<TFile, string>();
  private files = new Map<string, TFile>();
  private canonical = new Map<string, string>();
  private selections = new Map<string, CachedSelection>();
  private ignoredProgrammaticSelection = new Map<string, string>();
  private listeners = new Set<ChangeListener>();
  private suppressSelection = 0;
  private ownWrites = new Set<string>();

  constructor(private app: App, private sessions: Record<string, Session>, trustedFiles?:Map<string,TFile>) {
    for (const session of Object.values(sessions)) {
      const file = app.vault.getAbstractFileByPath(session.document.path);
      const native=file instanceof TFile?nativeFileIdentity(app,file):undefined;
      const trusted=trustedFiles?.get(session.document.id)===file;
      const identity=!session.document.nativeId || session.document.nativeId===native;
      if (!session.document.deleted && file instanceof TFile && file.extension === 'md' && file.stat.ctime === session.document.ctime && identity) {
        this.ids.set(file, session.document.id); this.files.set(session.document.id, file);
        if(native && !session.document.nativeId && !trusted) {
          if(session.candidate)session.candidate.state='stale';
          if(session.undo)session.undo.needsCheck=true;
          for(const receipt of session.agentActions ?? []) {receipt.state='needs-check';receipt.invalidReason='旧版本未保存稳定文件身份，重新生成后才能执行。';}
          for(const suggestion of session.review?.suggestions ?? [])if(['pending','comment','applying'].includes(suggestion.state)){suggestion.state='needs-check';suggestion.invalidReason='旧版文稿身份需重新核实，请重新审阅。';}
          for(const receipt of session.review?.receipts ?? [])receipt.state='needs-check';
        }
        if(native)session.document.nativeId=native;
      } else {
        if (session.candidate) session.candidate.state = 'stale'; if(session.undo)session.undo.needsCheck=true;
        for (const receipt of session.agentActions ?? []) { receipt.state = 'needs-check'; receipt.invalidReason = '文稿身份无法在重启后确认。'; }
        if (session.review) {
          session.review.verifiedHash = '';
          for (const suggestion of session.review.suggestions) if (suggestion.state === 'pending' || suggestion.state === 'comment' || suggestion.state === 'applying') {
            suggestion.state = 'needs-check'; suggestion.invalidReason = '文稿身份无法在重启后确认。';
          }
          for (const receipt of session.review.receipts) if (receipt.state === 'applied') receipt.state = 'needs-check';
        }
      }
    }
  }

  setChangeListener(listener: ChangeListener | undefined): () => void {
    const previous = [...this.listeners]; this.listeners.clear(); if (listener) this.listeners.add(listener);
    return () => { this.listeners.clear(); for (const item of previous) this.listeners.add(item); };
  }
  onChange(listener: ChangeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(change: DocumentChange): void { for (const listener of this.listeners) listener(change); }

  focus(leaf: WorkspaceLeaf | null): void {
    if (leaf?.view instanceof MarkdownView && leaf.view.file?.extension === 'md') {
      this.target = leaf.view; this.pinnedId = undefined;
      const document = this.recordFor(leaf.view.file);
      this.cacheSelection(leaf.view.file, leaf.view.editor, true); this.remember(document.id, leaf.view.editor.getValue());
    }
  }
  bind(documentId: string): void { this.resolve(documentId); this.pinnedId = documentId; }
  recordFor(file: TFile): DocumentRecord {
    if (file.extension !== 'md' || this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error('原文稿已删除或身份无法确认，请在当前文稿重新生成。');
    let id = this.ids.get(file);
    if (!id) { id = randomUUID(); this.ids.set(file, id); this.files.set(id, file); }
    const nativeId=nativeFileIdentity(this.app,file);
    return { id, path: file.path, ctime: file.stat.ctime, ...(nativeId?{nativeId}:{}) };
  }
  current(): DocumentRecord | null {
    if (this.pinnedId) { try { return this.recordFor(this.resolve(this.pinnedId)); } catch { this.pinnedId = undefined; } }
    if (!this.target?.file || !this.app.workspace.getLeavesOfType('markdown').some(l => l.view === this.target)) {
      this.target = null; this.focus(this.app.workspace.getMostRecentLeaf());
    }
    const file = this.target?.file;
    return file?.extension === 'md' ? this.recordFor(file) : null;
  }
  resolve(id: string): TFile {
    const file = this.files.get(id);
    if (!file || this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error('原文稿已删除或身份无法确认，请在当前文稿重新生成。');
    return file;
  }
  private editors(file: TFile): { view: MarkdownView; editor: Editor }[] {
    return this.app.workspace.getLeavesOfType('markdown').map(l => l.view)
      .filter((v): v is MarkdownView => v instanceof MarkdownView && v.file === file && v.getMode() === 'source')
      .map(view => ({ view, editor: view.editor }));
  }
  private source(file: TFile): Editor | undefined {
    const buffers = this.editors(file);
    if (buffers.some(b => b.editor.getValue() !== buffers[0]?.editor.getValue())) throw new Error('同一文稿的编辑缓冲不一致，请先同步或关闭重复视图。');
    return (buffers.find(b => b.view === this.target) ?? buffers[0])?.editor;
  }
  private remember(id: string, text: string): void { this.canonical.set(id, text); }
  async read(document: DocumentRecord): Promise<string> {
    const file = this.resolve(document.id); if (file.path !== document.path) throw new Error('目标文稿身份已变化，请重新生成。');
    const editor = this.source(file); const text = editor ? editor.getValue() : await this.app.vault.read(file);
    this.remember(document.id, text); return text;
  }
  /** Returns the current authoritative source-editor buffer without awaiting disk I/O. */
  bufferText(document: DocumentRecord): string | undefined {
    const file = this.resolve(document.id);
    if (file.path !== document.path || document.deleted) throw new Error('目标文稿身份已变化，请重新生成。');
    const editor = this.source(file); if (!editor) return undefined;
    const text = editor.getValue(); this.remember(document.id, text); return text;
  }
  cacheSelection(file: TFile, editor: Editor, user = true): void {
    if (!user || this.suppressSelection) return;
    const document = this.recordFor(file), selections = editor.listSelections();
    if (selections.length !== 1) {
      const ignored = this.ignoredProgrammaticSelection.get(document.id);
      if (ignored === `multiple:${selections.length}`) return;
      this.ignoredProgrammaticSelection.delete(document.id); this.selections.set(document.id, { kind: 'multiple', characters: 0 }); return;
    }
    const selection = selections[0];
    if (!selection) { this.selections.set(document.id, { kind: 'body', characters: 0 }); return; }
    const a = editor.posToOffset(selection.anchor), b = editor.posToOffset(selection.head);
    const signature = `${a}:${b}`;
    if (this.ignoredProgrammaticSelection.get(document.id) === signature) return;
    this.ignoredProgrammaticSelection.delete(document.id);
    this.selections.set(document.id, a === b ? { kind: 'body', characters: 0, from:a, to:b, textHash:hashText(editor.getValue()) }
      : { kind: 'selection', from: Math.min(a, b), to: Math.max(a, b), characters: Math.abs(a - b), textHash: hashText(editor.getValue()) });
  }
  selectionSummary(document = this.current() ?? undefined): SelectionSummary {
    if (!document) return { kind: 'body', characters: 0 };
    const cached = this.selections.get(document.id);
    if (cached) return { kind: cached.kind, characters: cached.characters };
    try { const file = this.resolve(document.id), editor = this.source(file); if (editor) this.cacheSelection(file, editor, true); } catch { /* report buffer divergence at operation time */ }
    const selected = this.selections.get(document.id);
    return { kind: selected?.kind ?? 'body', characters: selected?.characters ?? 0 };
  }
  suppressProgrammaticSelection<T>(operation: () => T): T { this.suppressSelection++; try { return operation(); } finally { this.suppressSelection--; } }
  insertionAnchor(document:DocumentRecord, snapshot:DocumentSnapshot):TextAnchor | undefined {
    const selection=this.selections.get(document.id);
    if(selection?.kind!=='body' || selection.from===undefined || selection.textHash!==snapshot.hash || !isSafeTextBoundary(snapshot.fullText,selection.from))return undefined;
    return {from:selection.from,to:selection.from,text:'',valid:true};
  }
  markProgrammaticSelection(documentId: string, from: number, to: number): void { this.ignoredProgrammaticSelection.set(documentId, `${from}:${to}`); }

  private mapCachedSelection(documentId: string, changes: TextChange[], after: string): void {
    const selection = this.selections.get(documentId);
    if (!selection || selection.kind !== 'selection' || selection.from === undefined || selection.to === undefined) return;
    const map = (position: number, association: -1 | 1): number => {
      let mapped = position;
      // Change coordinates are in the pre-change document. Applying backwards
      // keeps them valid when a transaction contains more than one range.
      for (const change of [...changes].sort((a, b) => b.from - a.from || b.to - a.to)) {
        const removed = change.to - change.from, delta = change.insert.length - removed;
        if (mapped > change.to || (mapped === change.to && association > 0)) mapped += delta;
        else if (mapped >= change.from) mapped = association < 0 ? change.from : change.from + change.insert.length;
      }
      return mapped;
    };
    const from = map(selection.from, 1), to = map(selection.to, -1);
    if (to <= from) this.selections.set(documentId, { kind: 'body', characters: 0 });
    else this.selections.set(documentId, { kind: 'selection', from, to, characters: to - from, textHash: hashText(after) });
  }

  async snapshot(document: DocumentRecord, scope: EditScope, protect = true): Promise<DocumentSnapshot> {
    const file = this.resolve(document.id), editor = this.source(file);
    const fullText = editor ? editor.getValue() : await this.app.vault.read(file); this.remember(document.id, fullText);
    const start = protect ? bodyStart(fullText) : 0;
    let from = start, to = fullText.length, selected = false;
    if (scope !== 'body') {
      if (editor) this.cacheSelection(file, editor, true);
      const selection = this.selections.get(document.id);
      if (selection?.kind === 'multiple') throw new Error('首版只修改一个连续选区，请重新选择。');
      if (selection?.kind === 'selection' && selection.from !== undefined && selection.to !== undefined) {
        if (!editor && selection.textHash !== hashText(fullText)) throw new Error('缓存选区的文稿版本已变化，请切换编辑模式重新选择，或明确选择全文范围。');
        from = selection.from; to = selection.to; selected = true;
      }
    }
    if (scope === 'selection' && !selected) throw new Error('请先在文稿中选择要修改的文字。');
    checkedRange(fullText, from, to);
    if (selected && protect && from < start) throw new Error('选区进入了受保护的 frontmatter，请只选择正文。');
    return { documentId: document.id, path: file.path, fullText, hash: hashText(fullText), scope: selected ? 'selection' : 'body', from, to, selectedText: fullText.slice(from, to) };
  }

  observeEditor(file: TFile, before: string, after: string, changes: TextChange[], kind: ChangeKind = 'edit'): void {
    let document: DocumentRecord; try { document = this.recordFor(file); } catch { return; }
    if (this.ownWrites.has(document.id)) return; // the synchronous write emits its authoritative transaction once
    const known = this.canonical.get(document.id);
    if (known === after && before !== after) return; // our own transaction echo
    if (known !== undefined && known !== before) {
      this.emit({ documentId: document.id, before: known, after, changes: [], kind: 'edit' }); this.remember(document.id, after); return;
    }
    if (before === after) return;
    this.mapCachedSelection(document.id, changes, after); this.remember(document.id, after); this.emit({ documentId: document.id, before, after, changes, kind });
  }

  async applyRange(document: DocumentRecord, expected: string, from: number, to: number, replacement: string): Promise<void> {
    return this.applyRangeValidated(document, expected, from, to, replacement, () => undefined);
  }
  /** Validation runs synchronously between the final compare and write. */
  async applyRangeValidated(document: DocumentRecord, expected: string, from: number, to: number, replacement: string, validate: (current: string) => void, protectionText = expected): Promise<void> {
    return this.applyChangesValidated(document, expected, [{ from, to, insert: replacement }], validate, protectionText);
  }
  /** Every range uses the same original version and is committed in one transaction. */
  async applyChangesValidated(document: DocumentRecord, expected: string, changes: TextChange[], validate: (current: string) => void = () => undefined, protectionText = expected): Promise<void> {
    const file = this.resolve(document.id);
    const assertIdentity = (): void => {
      if (this.resolve(document.id) !== file || file.path !== document.path || document.deleted
        || file.stat.ctime !== document.ctime || (document.nativeId && nativeFileIdentity(this.app, file) !== document.nativeId)) {
        throw new Error('目标文稿身份已变化，请重新生成。');
      }
    };
    assertIdentity();
    const sorted = changes.map(change => ({ ...change })).sort((a, b) => a.from - b.from || a.to - b.to);
    let cursor = 0, updated = '', previous: TextChange | undefined;
    const protectedStart = bodyStart(protectionText);
    for (const change of sorted) {
      checkedRange(expected, change.from, change.to);
      if (typeof change.insert !== 'string' || change.from < cursor || (previous && change.from === previous.from)) throw new Error('修改范围重叠或无效。');
      if (change.from < protectedStart) throw new Error('修改范围进入了受保护的 frontmatter。');
      updated += expected.slice(cursor, change.from) + change.insert; cursor = change.to; previous = change;
    }
    updated += expected.slice(cursor);
    const editor = this.source(file);
    if (editor) {
      // The public Editor API serializes CRLF as LF on save. Preserve the existing refusal.
      const onDisk = await this.app.vault.read(file);
      if (onDisk.includes('\r\n')) throw new Error('该文稿使用 CRLF 换行，Obsidian 源文编辑器会重写整篇换行，已阻止写入。请先备份原文，关闭此文稿的全部源文窗格后重新审阅；宿主切换模式也可能统一换行。无源文缓冲且原文件仍为 CRLF 时，稿伴可以保留原换行。');
      if (this.source(file) !== editor || file.path !== document.path) throw new Error('文稿的编辑模式或目标已变化，请重试。');
      const current = editor.getValue();
      if (current !== expected) throw new Error('文稿已变化，旧候选不能覆盖新文字。请基于最新文稿重新生成。');
      assertIdentity(); validate(current);
      if (!sorted.length) return;
      this.ownWrites.add(document.id);
      try {
        // Descending coordinates work with the public Editor transaction and simple test editors.
        const editorChanges = [...sorted].reverse().map(change => ({ from: editor.offsetToPos(change.from), to: editor.offsetToPos(change.to), text: change.insert }));
        this.suppressProgrammaticSelection(() => editor.transaction({ changes: editorChanges }, 'draft-companion'));
      } finally { this.ownWrites.delete(document.id); }
      const selections = editor.listSelections();
      if (selections.length === 1 && selections[0]) this.markProgrammaticSelection(document.id, editor.posToOffset(selections[0].anchor), editor.posToOffset(selections[0].head));
      this.mapCachedSelection(document.id, sorted, updated); this.remember(document.id, updated);
      this.emit({ documentId: document.id, before: current, after: updated, changes: sorted, kind: 'apply' }); return;
    }
    await this.app.vault.process(file, current => {
      if (this.source(file)) throw new Error('文稿刚进入编辑模式，请重试以使用编辑缓冲。');
      assertIdentity();
      if (current !== expected) throw new Error('文稿已变化，已阻止覆盖。请基于最新文稿重新生成。');
      validate(current);
      if (sorted.length) {
        this.mapCachedSelection(document.id, sorted, updated); this.remember(document.id, updated);
        this.emit({ documentId: document.id, before: current, after: updated, changes: sorted, kind: 'apply' });
      }
      return updated;
    });
  }
  async restoreRange(document: DocumentRecord, record: UndoRecord): Promise<void> {
    if(record.needsCheck)throw new Error('旧撤回记录的文稿身份无法可靠确认，请查看旧版本后重新改稿。');
    if (record.documentId !== document.id || record.path !== document.path) throw new Error('撤回记录的文稿身份不匹配。');
    return this.applyRangeValidated(document, undoAfter(record), record.from, record.from + record.replacement.length, record.before.slice(record.from, record.to), () => undefined, record.before);
  }
  async locate(document: DocumentRecord, from: number, to: number): Promise<void> {
    const file = this.resolve(document.id);
    if((await this.app.vault.read(file)).includes('\r\n'))throw new Error('勾选或修改可保留 CRLF，但自动切换源文定位可能改变换行。请手动在原文查看；本次写入结果仍保留。');
    const leaf = this.app.workspace.getLeavesOfType('markdown').find(item => item.view instanceof MarkdownView && item.view.file === file) ?? this.app.workspace.getLeaf(false);
    if (!leaf) throw new Error('无法打开文稿编辑器。');
    if (!(leaf.view instanceof MarkdownView) || leaf.view.file !== file) await leaf.openFile(file);
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || view.file !== file) throw new Error('无法切换到文稿编辑模式。');
    if (view.getMode() !== 'source') { const state = await view.getState(); await view.setState({ ...state, mode: 'source' }, { history: false }); }
    const text = view.editor.getValue(); checkedRange(text, from, to);
    // The mark shows the quote. Navigation moves a caret without creating a new
    // nonempty user selection, including across a subsequent plugin reload.
    this.markProgrammaticSelection(document.id, from, from);
    this.suppressProgrammaticSelection(() => view.editor.setSelection(view.editor.offsetToPos(from)));
    view.editor.scrollIntoView?.({from:view.editor.offsetToPos(from),to:view.editor.offsetToPos(to)},true);
    this.target = view; this.pinnedId = undefined; this.remember(document.id, text);
  }
  renamed(file: TAbstractFile, oldPath: string): void {
    for (const session of Object.values(this.sessions)) {
      const path = session.document.path;
      if (path === oldPath || path.startsWith(`${oldPath}/`)) { const next = file.path + path.slice(oldPath.length); session.document.path = next; if (session.candidate) session.candidate.path = next; if (session.undo) session.undo.path = next; for(const receipt of session.agentActions ?? [])receipt.path=next; }
    }
  }
  deleted(file: TAbstractFile): void {
    for (const session of Object.values(this.sessions)) if (session.document.path === file.path || session.document.path.startsWith(`${file.path}/`)) {
      session.document.deleted = true; if (session.candidate) session.candidate.state = 'stale'; session.undo = undefined;
      for(const receipt of session.agentActions ?? []) {receipt.state='needs-check';receipt.invalidReason='原文稿已删除。';}
      this.files.delete(session.document.id); this.canonical.delete(session.document.id); this.selections.delete(session.document.id); this.ignoredProgrammaticSelection.delete(session.document.id); if (this.pinnedId === session.document.id) this.pinnedId = undefined;
      if (session.review) {
        session.review.verifiedHash = '';
        for (const suggestion of session.review.suggestions) if (suggestion.state === 'pending' || suggestion.state === 'comment' || suggestion.state === 'applying') { suggestion.state = 'needs-check'; suggestion.invalidReason = '原文稿已删除。'; }
        for (const receipt of session.review.receipts) if (receipt.state === 'applied') receipt.state = 'needs-check';
      }
    }
    if (file instanceof TFile) this.ids.delete(file); if (this.target?.file === file) this.target = null;
  }
}
