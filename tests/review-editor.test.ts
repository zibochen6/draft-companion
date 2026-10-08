import type { App, WorkspaceLeaf } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { cmOffsetToRawOffset, Documents, isSafeTextBoundary, rawOffsetToCmOffset } from '../src/documents';
import { textChangesFrom } from '../src/editor-review';
import { MarkdownView, TestEditor, TFile } from './obsidian-mock';

function fixture(text = '开头\n目标🙂\n结尾') {
  const file = new TFile('审阅.md');
  const editor = new TestEditor(text); const view = new MarkdownView(file, editor); const leaf = { view }; const leaves = [leaf];
  let disk = text;
  const app = {
    workspace: { getLeavesOfType: () => leaves, getMostRecentLeaf: () => leaf },
    vault: {
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
      read: async () => disk,
      process: async (_file: TFile, callback: (current: string) => string) => (disk = callback(disk)),
    },
  } as unknown as App;
  const documents = new Documents(app, {}); documents.focus(leaf as unknown as WorkspaceLeaf);
  return { documents, file, editor, view, leaves, app, document: documents.current()!, disk: () => disk, setDisk: (value: string) => { disk = value; } };
}

describe('review editor document bridge', () => {
  it('keeps a genuine single selection after side-bar focus and rejects a multi-selection', async () => {
    const f = fixture(); const from = f.editor.text.indexOf('目标'); const to = from + '目标🙂'.length;
    f.editor.selection = { anchor: f.editor.offsetToPos(from), head: f.editor.offsetToPos(to) };
    f.documents.cacheSelection(f.file, f.editor);
    expect(f.documents.selectionSummary(f.document)).toEqual({ kind: 'selection', characters: '目标🙂'.length });
    expect((await f.documents.snapshot(f.document, 'auto')).selectedText).toBe('目标🙂');
    const original = f.editor.listSelections;
    f.editor.listSelections = () => [
      { anchor: f.editor.offsetToPos(0), head: f.editor.offsetToPos(1) },
      { anchor: f.editor.offsetToPos(2), head: f.editor.offsetToPos(3) },
    ];
    expect(() => f.documents.cacheSelection(f.file, f.editor)).not.toThrow();
    await expect(f.documents.snapshot(f.document, 'selection')).rejects.toThrow('连续选区');
    f.editor.listSelections = original;
  });

  it('emits exactly one trusted local apply and ignores its later CM echo', async () => {
    const f = fixture(); const events: string[] = [];
    f.documents.onChange(change => events.push(`${change.kind}:${change.before}>${change.after}`));
    const from = f.editor.text.indexOf('目标'); const expected = f.editor.text;
    await f.documents.applyRangeValidated(f.document, expected, from, from + '目标🙂'.length, '修改', current => expect(current).toBe(expected));
    expect(events).toEqual([`apply:${expected}>开头\n修改\n结尾`]);
    f.documents.observeEditor(f.file, expected, '开头\n修改\n结尾', [{ from, to: from + '目标🙂'.length, insert: '修改' }], 'edit');
    expect(events).toHaveLength(1);
  });

  it('maps CRLF coordinates without splitting CRLF or emoji surrogate pairs', () => {
    const raw = '甲\r\n乙🙂\r\n丙';
    expect(rawOffsetToCmOffset(raw, raw.indexOf('乙'))).toBe(2);
    expect(cmOffsetToRawOffset(raw, 2)).toBe(raw.indexOf('乙'));
    expect(isSafeTextBoundary(raw, 2)).toBe(false); // between CR and LF
    const emoji = raw.indexOf('🙂');
    expect(isSafeTextBoundary(raw, emoji + 1)).toBe(false);
    expect(isSafeTextBoundary(raw, emoji)).toBe(true);
  });

  it('does not turn an unknown second-buffer edit into a writable chain', () => {
    const f = fixture(); const events = vi.fn(); f.documents.setChangeListener(events);
    f.documents.observeEditor(f.file, '某个旧缓冲', '外部改变', [], 'edit');
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ before: '开头\n目标🙂\n结尾', after: '外部改变', changes: [] }));
  });

  it('uses CodeMirror’s composed transaction coordinates rather than per-transaction offsets', () => {
    const state = EditorState.create({ doc: '甲乙丙丁' });
    const transaction = state.update({ changes: [{ from: 0, to: 1, insert: '开始' }, { from: 2, to: 3, insert: '结束' }] });
    expect(textChangesFrom(transaction.changes)).toEqual([
      { from: 0, to: 1, insert: '开始' }, { from: 2, to: 3, insert: '结束' },
    ]);
  });

  it('converts CodeMirror logical changes back to CRLF raw offsets and inserted raw text', () => {
    const state = EditorState.create({ doc: '甲\n乙\n丙', extensions: [EditorState.lineSeparator.of('\r\n')] });
    const transaction = state.update({ changes: { from: 2, to: 3, insert: '新\n行' } });
    // CM's Text stays LF even with a configured line separator. The source
    // Editor buffer supplies the raw CRLF representation to the bridge.
    expect(state.sliceDoc()).toBe('甲\n乙\n丙');
    expect(textChangesFrom(transaction.changes, '甲\r\n乙\r\n丙', '甲\r\n新\r\n行\r\n丙')).toEqual([
      { from: 3, to: 4, insert: '新\r\n行' },
    ]);
  });

  it('retains the real user selection when a locate operation sets a temporary selection', async () => {
    const f = fixture(); const originalFrom = 0, originalTo = 2;
    f.editor.selection = { anchor: f.editor.offsetToPos(originalFrom), head: f.editor.offsetToPos(originalTo) };
    f.documents.cacheSelection(f.file, f.editor);
    const programFrom = f.editor.text.indexOf('目标'), programTo = programFrom + '目标🙂'.length;
    f.documents.markProgrammaticSelection(f.document.id, programFrom, programTo);
    f.editor.selection = { anchor: f.editor.offsetToPos(programFrom), head: f.editor.offsetToPos(programTo) };
    f.documents.cacheSelection(f.file, f.editor);
    expect(f.documents.selectionSummary(f.document)).toEqual({ kind: 'selection', characters: originalTo - originalFrom });
    expect((await f.documents.snapshot(f.document, 'selection')).selectedText).toBe('开头');
  });

  it('refuses a source-editor write that Obsidian would normalize from CRLF to LF', async () => {
    const f = fixture('甲\n乙'); f.setDisk('甲\r\n乙');
    await expect(f.documents.applyRange(f.document, '甲\n乙', 2, 3, '新')).rejects.toThrow('CRLF');
    expect(f.editor.getValue()).toBe('甲\n乙');
  });

  it('uses the raw Vault CAS path for a CRLF document after source views are closed', async () => {
    const f = fixture('甲\n乙'); f.setDisk('甲\r\n乙'); f.view.mode = 'preview';
    await f.documents.applyRange(f.document, '甲\r\n乙', 3, 4, '新');
    expect(f.disk()).toBe('甲\r\n新');
  });

  it('rechecks all source panes after disk preflight before the final synchronous write', async () => {
    const f = fixture(); const other = new TestEditor(f.editor.text); f.leaves.push({ view: new MarkdownView(f.file, other) });
    f.app.vault.read = async () => { other.text = '另一个窗格在等待期间出现分叉'; return f.disk(); };
    const validate = vi.fn(); const before = f.editor.text;
    await expect(f.documents.applyRangeValidated(f.document, before, 3, 7, '新句', validate)).rejects.toThrow('缓冲不一致');
    expect(f.editor.text).toBe(before); expect(validate).not.toHaveBeenCalled();
  });

  it('does not reuse LF selection coordinates against a different raw reading-mode version', async () => {
    const f = fixture('甲\n乙'); f.editor.selection = { anchor: f.editor.offsetToPos(2), head: f.editor.offsetToPos(3) };
    f.documents.cacheSelection(f.file, f.editor); f.view.mode = 'preview'; f.setDisk('甲\r\n乙');
    await expect(f.documents.snapshot(f.document, 'auto')).rejects.toThrow('重新选择');
    await expect(f.documents.snapshot(f.document, 'auto')).rejects.toThrow('重新选择');
    expect((await f.documents.snapshot(f.document, 'body')).fullText).toBe('甲\r\n乙');
  });

  it('maps a cached user range once when the host synchronously echoes a plugin transaction', async () => {
    const f = fixture(); const before = f.editor.text; const events = vi.fn(); f.documents.onChange(events);
    f.editor.selection = { anchor: f.editor.offsetToPos(8), head: f.editor.offsetToPos(10) }; f.documents.cacheSelection(f.file, f.editor);
    const native = f.editor.transaction.bind(f.editor); const replacement = '一段更长的新句';
    f.editor.transaction = spec => {
      native(spec); const from = f.editor.text.indexOf('结尾');
      f.editor.selection = { anchor: f.editor.offsetToPos(from), head: f.editor.offsetToPos(from + 2) };
      f.documents.observeEditor(f.file, before, f.editor.text, [{ from: 3, to: 7, insert: replacement }]);
      f.documents.cacheSelection(f.file, f.editor);
    };
    await f.documents.applyRange(f.document, before, 3, 7, replacement);
    expect(events).toHaveBeenCalledTimes(1);
    expect((await f.documents.snapshot(f.document, 'selection')).selectedText).toBe('结尾');
  });
});
