import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
vi.mock('obsidian', async () => {
  const { StateField } = await import('@codemirror/state');
  return { editorInfoField: StateField.define({ create: () => ({ file: { extension: 'md' } }), update: value => value }) };
});
import { editorInfoField } from 'obsidian';
import { dailyMarkerField, dailyMarkerRanges } from '../src/daily-editor';

const OPEN = '<!-- draft-companion:daily:start -->', CLOSE = '<!-- draft-companion:daily:end -->';
const DAY_START = '<!-- draft-companion:day:2026-10-08:start -->', DAY_END = '<!-- draft-companion:day:2026-10-08:end -->';
const TOPIC_START = `<!-- draft-companion:topic:${'a'.repeat(64)}:start -->`, TOPIC_END = `<!-- draft-companion:topic:${'a'.repeat(64)}:end -->`;
const NOTE = ['# 选题库 😀', '', OPEN, DAY_START, '## 2026-10-08 · 自动选题', TOPIC_START, '- [x] **知识管理** — 中文简介 😀', '  - 首推标题：让零散笔记有下一步', TOPIC_END, DAY_END, CLOSE, '', '原有内容完整保留。'].join('\n');
const MARKERS = [OPEN, DAY_START, TOPIC_START, TOPIC_END, DAY_END, CLOSE];
function hidden(state: EditorState) { const ranges: { from: number; to: number }[] = []; state.field(dailyMarkerField).between(0, state.doc.length, (from, to, decoration) => { expect(decoration.spec.block).toBe(true); ranges.push({ from, to }); }); return ranges; }
function state(text = NOTE, extra: Parameters<typeof EditorState.create>[0]['extensions'] = []) {
  return EditorState.create({ doc: text, extensions: [editorInfoField, dailyMarkerField, extra], selection: { anchor: 0 } });
}

describe('daily marker display ranges', () => {
  it('hides only exact standalone managed marker lines and includes their newline', () => {
    const ranges = dailyMarkerRanges(NOTE);
    expect(ranges.map(range => NOTE.slice(range.from, range.to))).toEqual(MARKERS.map(marker => marker + '\n'));
    expect(ranges.every(range => range.from < range.to)).toBe(true);
    expect(NOTE).toContain('中文简介 😀');
  });
  it('reveals a caret or intersecting selection while keeping the next line boundary independent', () => {
    const from = NOTE.indexOf(TOPIC_START), to = from + TOPIC_START.length + 1;
    expect(dailyMarkerRanges(NOTE, [{ from: from + 5, to: from + 5 }])).toHaveLength(5);
    expect(dailyMarkerRanges(NOTE, [{ from: from - 2, to: to + 2 }])).toHaveLength(5);
    expect(dailyMarkerRanges(NOTE, [{ from: to, to }])).toHaveLength(6);
    expect(dailyMarkerRanges(NOTE, [{ from: 0, to: NOTE.length }])).toEqual([]);
  });
  it('keeps incomplete, duplicate and fenced examples visible', () => {
    expect(dailyMarkerRanges(NOTE.replace(CLOSE, ''))).toEqual([]);
    expect(dailyMarkerRanges(NOTE + '\n' + OPEN)).toEqual([]);
    expect(dailyMarkerRanges('```markdown\n' + NOTE + '\n```')).toEqual([]);
    expect(dailyMarkerRanges('~~~~markdown\n' + NOTE + '\n~~~~')).toEqual([]);
    const fenced = NOTE.replace('- [x] **知识管理** — 中文简介 😀', `\`\`\`html\n${TOPIC_START}\n${TOPIC_END}\n\`\`\`\n- [x] 实际正文`);
    expect(dailyMarkerRanges(fenced)).toHaveLength(6);
  });
  it('ignores frontmatter, ordinary comments, malformed dates and non-standalone marker text', () => {
    const frontmatter = `---\nexample: |\n  ${OPEN}\n  ${CLOSE}\n---\n`;
    const additions = ['<!-- ordinary comment -->', '<!-- draft-companion:day:2026-02-30:start -->', '<!-- draft-companion:topic:abc:start -->', `prefix ${TOPIC_START}`, `  ${TOPIC_START}`, `${TOPIC_START} suffix`].join('\n');
    const text = frontmatter + NOTE.replace(TOPIC_START, additions + '\n' + TOPIC_START);
    expect(dailyMarkerRanges(text).map(range => text.slice(range.from, range.to).trim())).toEqual(MARKERS);
    expect(dailyMarkerRanges('---\n未闭合\n' + NOTE)).toEqual([]);
    expect(dailyMarkerRanges(`---\n${OPEN}\n${CLOSE}\n---\n普通正文`)).toEqual([]);
  });
  it('retains CRLF and emoji offsets and handles a final marker without a trailing newline', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const ranges = dailyMarkerRanges(crlf);
    expect(ranges.map(range => crlf.slice(range.from, range.to))).toEqual(MARKERS.map(marker => marker + '\r\n'));
    expect(ranges[0]?.from).toBe(crlf.indexOf(OPEN));
    expect(dailyMarkerRanges(NOTE.slice(0, NOTE.indexOf(CLOSE) + CLOSE.length)).at(-1)?.to).toBe(NOTE.indexOf(CLOSE) + CLOSE.length);
  });
});

describe('daily marker state field', () => {
  it('decorates the actual Markdown editor without changing any document characters', () => {
    const original = state(); expect(hidden(original)).toEqual(dailyMarkerRanges(NOTE)); expect(original.doc.toString()).toBe(NOTE);
    const noBinding = EditorState.create({ doc: NOTE, extensions: [dailyMarkerField] }); expect(hidden(noBinding)).toEqual([]);
    const nonMarkdown = EditorState.create({ doc: NOTE, extensions: [editorInfoField.init(() => ({ file: { extension: 'txt' } } as never)), dailyMarkerField] });
    expect(hidden(nonMarkdown)).toEqual([]);
  });
  it('responds to selection-only changes, including multiple selections, without writing or rewriting text', () => {
    const original = state(NOTE, EditorState.allowMultipleSelections.of(true));
    const selected = original.update({ selection: EditorSelection.create([EditorSelection.cursor(NOTE.indexOf(TOPIC_START) + 5), EditorSelection.cursor(NOTE.indexOf(DAY_START) + 3)]) });
    expect(selected.docChanged).toBe(false); expect(selected.newDoc.toString()).toBe(NOTE); expect(hidden(selected.state)).toHaveLength(4);
    const away = selected.state.update({ selection: { anchor: NOTE.indexOf('中文简介') } });
    expect(hidden(away.state)).toHaveLength(6); expect(away.newDoc.toString()).toBe(NOTE);
  });
  it('rebuilds after edits and native undo/redo transactions while preserving visible authored content', () => {
    const original = state(), at = NOTE.indexOf(CLOSE);
    const edited = original.update({ changes: { from: at, to: at + CLOSE.length, insert: '<!-- 作者编辑的普通注释 -->' } });
    expect(hidden(edited.state)).toEqual([]); expect(edited.newDoc.toString()).toContain('中文简介 😀');
    const undone = edited.state.update({ changes: { from: at, to: at + '<!-- 作者编辑的普通注释 -->'.length, insert: CLOSE }, annotations: Transaction.userEvent.of('undo') });
    expect(undone.newDoc.toString()).toBe(NOTE); expect(hidden(undone.state)).toHaveLength(6);
    const redone = undone.state.update({ changes: { from: at, to: at + CLOSE.length, insert: '<!-- 作者编辑的普通注释 -->' }, annotations: Transaction.userEvent.of('redo') });
    expect(hidden(redone.state)).toEqual([]); expect(redone.newDoc.toString()).toBe(edited.newDoc.toString());
  });
  it('uses CM logical coordinates for CRLF and tracks all markers independently of viewport', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n'), original = state(crlf, EditorState.lineSeparator.of('\r\n'));
    expect(original.doc.toString()).toBe(NOTE); expect(original.sliceDoc()).toBe(crlf); expect(hidden(original)).toEqual(dailyMarkerRanges(NOTE));
    const long = '# 长文\n' + '中文段落 😀\n'.repeat(10000) + NOTE;
    const full = state(long); expect(hidden(full)).toHaveLength(6); expect(hidden(full)[0]?.from).toBe(long.indexOf(OPEN));
    const noOp = full.update({ annotations: Transaction.userEvent.of('scroll') });
    expect(noOp.docChanged).toBe(false); expect(noOp.state.field(dailyMarkerField)).toBe(full.field(dailyMarkerField));
  });
});
