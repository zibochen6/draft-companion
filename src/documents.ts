import { App, MarkdownView, TFile, type TAbstractFile, type WorkspaceLeaf, type Editor } from 'obsidian';
import { randomUUID } from 'node:crypto';
import { bodyStart, hashText, replaceExact, undoAfter } from './editing';
import type { DocumentRecord, DocumentSnapshot, EditScope, Session, UndoRecord } from './types';

export class Documents {
  private target: MarkdownView | null = null;
  private ids = new WeakMap<TFile, string>();
  private files = new Map<string, TFile>();
  constructor(private app: App, private sessions: Record<string, Session>) {
    for (const session of Object.values(sessions)) {
      const file = app.vault.getAbstractFileByPath(session.document.path);
      if (!session.document.deleted && file instanceof TFile && file.extension === 'md' && file.stat.ctime === session.document.ctime) {
        this.ids.set(file, session.document.id); this.files.set(session.document.id, file);
      } else {
        if (session.candidate) session.candidate.state = 'stale';
        session.undo = undefined;
      }
    }
  }
  focus(leaf: WorkspaceLeaf | null): void {
    if (leaf?.view instanceof MarkdownView && leaf.view.file?.extension === 'md') this.target = leaf.view;
  }
  current(): DocumentRecord | null {
    if (!this.target?.file || !this.app.workspace.getLeavesOfType('markdown').some(l => l.view === this.target)) {
      this.target = null;
      this.focus(this.app.workspace.getMostRecentLeaf());
    }
    const file = this.target?.file;
    if (!file || file.extension !== 'md' || this.app.vault.getAbstractFileByPath(file.path) !== file) return null;
    let id = this.ids.get(file);
    if (!id) { id = randomUUID(); this.ids.set(file, id); this.files.set(id, file); }
    return { id, path: file.path, ctime: file.stat.ctime };
  }
  resolve(id: string): TFile {
    const file = this.files.get(id);
    if (!file || this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error('原文稿已删除或身份无法确认，请在当前文稿重新生成。');
    return file;
  }
  private editors(file: TFile): { view: MarkdownView; editor: Editor }[] {
    return this.app.workspace.getLeavesOfType('markdown')
      .map(l => l.view).filter((v): v is MarkdownView => v instanceof MarkdownView && v.file === file && v.getMode() === 'source')
      .map(view => ({ view, editor: view.editor }));
  }
  private source(file: TFile): Editor | undefined {
    const buffers = this.editors(file);
    if (buffers.some(b => b.editor.getValue() !== buffers[0]?.editor.getValue())) throw new Error('同一文稿的编辑缓冲不一致，请先同步或关闭重复视图。');
    return (buffers.find(b => b.view === this.target) ?? buffers[0])?.editor;
  }
  async snapshot(document: DocumentRecord, scope: EditScope, protect = true): Promise<DocumentSnapshot> {
    const file = this.resolve(document.id);
    const editor = this.source(file);
    const fullText = editor ? editor.getValue() : await this.app.vault.read(file);
    // Read-only discussions remain possible even while the author is repairing YAML.
    const start = protect ? bodyStart(fullText) : 0;
    let from = start, to = fullText.length;
    let selected = false;
    if (editor && scope !== 'body') {
      const selections = editor.listSelections();
      if (selections.length > 1) throw new Error('首版只修改一个连续选区，请重新选择。');
      const selection = selections[0];
      if (selection) {
        const a = editor.posToOffset(selection.anchor), b = editor.posToOffset(selection.head);
        if (a !== b) { from = Math.min(a, b); to = Math.max(a, b); selected = true; }
      }
    }
    if (scope === 'selection' && !selected) throw new Error('请先在文稿中选择要修改的文字。');
    if (selected && protect && from < start) throw new Error('选区进入了受保护的 frontmatter，请只选择正文。');
    return { documentId: document.id, path: file.path, fullText, hash: hashText(fullText), scope: selected ? 'selection' : 'body', from, to, selectedText: fullText.slice(from, to) };
  }
  async applyRange(document: DocumentRecord, expected: string, from: number, to: number, replacement: string): Promise<void> {
    return this.commitRange(document, expected, from, to, replacement, expected);
  }
  async restoreRange(document: DocumentRecord, record: UndoRecord): Promise<void> {
    if (record.documentId !== document.id || record.path !== document.path) throw new Error('撤回记录的文稿身份不匹配。');
    // Undo protects the original frontmatter, including when AI introduced YAML into a plain body.
    return this.commitRange(document, undoAfter(record), record.from, record.from + record.replacement.length,
      record.before.slice(record.from, record.to), record.before);
  }
  private async commitRange(document: DocumentRecord, expected: string, from: number, to: number, replacement: string, original: string): Promise<void> {
    const id = document.id;
    const file = this.resolve(id);
    if (file.path !== document.path || document.deleted) throw new Error('目标文稿身份已变化，请重新生成。');
    // The target is a registered TFile, never an AI-supplied filesystem path.
    // Validate the range here too, so future callers cannot bypass edit protection.
    const updated = replaceExact(expected, from, to, replacement);
    if (from < bodyStart(original)) throw new Error('修改范围进入了受保护的 frontmatter。');
    const editor = this.source(file);
    if (editor) {
      if (editor.getValue() !== expected) throw new Error('文稿已变化，旧候选不能覆盖新文字。请基于最新文稿重新生成。');
      // There is deliberately no await between the last comparison and the edit.
      if (this.resolve(id) !== file) throw new Error('目标文稿已变化。');
      editor.transaction({ changes: [{ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text: replacement }] }, 'draft-companion');
    } else {
      await this.app.vault.process(file, current => {
        if (this.source(file)) throw new Error('文稿刚进入编辑模式，请重试以使用编辑缓冲。');
        if (this.resolve(id) !== file || current !== expected) throw new Error('文稿已变化，已阻止覆盖。请基于最新文稿重新生成。');
        return updated;
      });
    }
  }
  renamed(file: TAbstractFile, oldPath: string): void {
    for (const session of Object.values(this.sessions)) {
      const path = session.document.path;
      if (path === oldPath || path.startsWith(`${oldPath}/`)) {
        const next = file.path + path.slice(oldPath.length);
        session.document.path = next;
        if (session.candidate) session.candidate.path = next;
        if (session.undo) session.undo.path = next;
      }
    }
  }
  deleted(file: TAbstractFile): void {
    for (const session of Object.values(this.sessions)) {
      if (session.document.path === file.path || session.document.path.startsWith(`${file.path}/`)) {
        session.document.deleted = true;
        if (session.candidate) session.candidate.state = 'stale';
        session.undo = undefined;
        this.files.delete(session.document.id);
      }
    }
    if (file instanceof TFile) this.ids.delete(file);
    if (this.target?.file === file) this.target = null;
  }
}
