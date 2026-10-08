import { editorInfoField } from 'obsidian';
import { StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { bodyStart } from './editing';

export interface DailyMarkerRange { from: number; to: number }
interface MarkerLine extends DailyMarkerRange { contentTo: number; text: string }
interface SelectedRange { from: number; to: number }

const AREA_START = '<!-- draft-companion:daily:start -->';
const AREA_END = '<!-- draft-companion:daily:end -->';
const DAY_MARKER = /^<!-- draft-companion:day:(\d{4}-\d{2}-\d{2}):(start|end) -->$/;
const TOPIC_MARKER = /^<!-- draft-companion:topic:[a-f\d]{64}:(?:start|end) -->$/;

function marker(text: string): boolean {
  if (text === AREA_START || text === AREA_END || TOPIC_MARKER.test(text)) return true;
  const day = DAY_MARKER.exec(text);
  if (!day) return false;
  const date = new Date(day[1]!);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day[1];
}

/** Positions retain the supplied line endings; no document text is rewritten. */
export function dailyMarkerRanges(text: string, selections: readonly SelectedRange[] = []): DailyMarkerRange[] {
  let from: number;
  try { from = bodyStart(text); } catch { return []; }
  const lines: MarkerLine[] = [];
  let fence: { character: string; length: number } | undefined;
  while (from < text.length) {
    const newline = text.indexOf('\n', from), to = newline < 0 ? text.length : newline + 1;
    const line = text.slice(from, to).replace(/\r?\n$/, '');
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceLine) {
      const run = fenceLine[1]!;
      if (!fence && (run[0] !== '`' || !fenceLine[2]!.includes('`'))) fence = { character: run[0]!, length: run.length };
      else if (fence && run[0] === fence.character && run.length >= fence.length && !fenceLine[2]!.trim()) fence = undefined;
    } else if (!fence && marker(line)) lines.push({ from, to, contentTo: from + line.length, text: line });
    from = to;
  }
  const starts = lines.filter(line => line.text === AREA_START), ends = lines.filter(line => line.text === AREA_END);
  // An incomplete or duplicate area may be an example or damaged note. Keep it readable and editable.
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.from >= ends[0]!.from) return [];
  const start = starts[0]!.from, end = ends[0]!.from;
  return lines.filter(line => line.from >= start && line.from <= end && !selections.some(selection => {
    if (selection.from === selection.to) return selection.from >= line.from && selection.from <= line.contentTo;
    return selection.from <= line.contentTo && selection.to > line.from;
  })).map(({ from: rangeFrom, to }) => ({ from: rangeFrom, to }));
}

function decorations(state: EditorState): DecorationSet {
  if (state.field(editorInfoField, false)?.file?.extension !== 'md') return Decoration.none;
  // CM's Text has logical LF coordinates; the pure scanner also supports raw CRLF for verification.
  const ranges = dailyMarkerRanges(state.doc.toString(), state.selection.ranges);
  return Decoration.set(ranges.map(range => Decoration.replace({ block: true, inclusive: false }).range(range.from, range.to)));
}

/** State-owned block decorations cover all markers, including those beyond the viewport. */
export const dailyMarkerField = StateField.define<DecorationSet>({
  create: decorations,
  update(value, transaction) {
    const info = transaction.state.field(editorInfoField, false), previous = transaction.startState.field(editorInfoField, false);
    return transaction.docChanged || transaction.selection || transaction.reconfigured || info?.file !== previous?.file ? decorations(transaction.state) : value;
  },
  provide: field => EditorView.decorations.from(field),
});

export const dailyEditorExtension = dailyMarkerField;
