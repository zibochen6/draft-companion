import { editorInfoField, type TFile } from 'obsidian';
import { RangeSetBuilder, StateEffect, type ChangeSet, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { hashText } from './editing';
import { cmOffsetToRawOffset, rawOffsetToCmOffset } from './documents';
import type { Documents } from './documents';
import type { ChangeKind, DocumentReview, Suggestion, TextChange } from './review-types';

interface ViewRegistration { view: EditorView; file: TFile; documentId: string; raw: string }
interface Press { x: number; y: number; documentId: string; ids: string[] }

function eligible(review: DocumentReview | undefined, text: string): Suggestion[] {
  // A CRLF vault snapshot and CodeMirror's LF logical text must never be mixed.
  // If the hash differs, the review engine will re-check anchors before drawing.
  if (!review || review.verifiedHash !== hashText(text)) return [];
  return review.suggestions.filter(suggestion => {
    const target = suggestion.anchors?.target;
    return (suggestion.state === 'pending' || suggestion.state === 'comment') && !!target && target.valid
      && target.from >= 0 && target.to > target.from && target.to <= text.length
      && text.slice(target.from, target.to) === target.text;
  });
}

interface PositionedSuggestion { suggestion: Suggestion; from: number; to: number }
function merged(suggestions: PositionedSuggestion[]): { from: number; to: number; ids: string[] }[] {
  const sorted = suggestions.map(item => ({ from: item.from, to: item.to, id: item.suggestion.id }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const output: { from: number; to: number; ids: string[] }[] = [];
  for (const item of sorted) {
    const previous = output[output.length - 1];
    if (previous && item.from <= previous.to) { previous.to = Math.max(previous.to, item.to); previous.ids.push(item.id); }
    else output.push({ from: item.from, to: item.to, ids: [item.id] });
  }
  return output;
}

class NumberMarker extends GutterMarker {
  constructor(private readonly label: string, private readonly title: string) { super(); }
  eq(other: NumberMarker): boolean { return this.label === other.label && this.title === other.title; }
  toDOM(): HTMLElement { const element = document.createElement('span'); element.className = 'dc-review-gutter-number'; element.textContent = this.label; element.title = this.title; return element; }
}

function kindFor(update: ViewUpdate): ChangeKind {
  for (const transaction of update.transactions) {
    if (transaction.isUserEvent('undo')) return 'undo';
    if (transaction.isUserEvent('redo')) return 'redo';
  }
  return 'edit';
}

/** Converts the composed ViewUpdate change set, whose positions are all in the pre-update document. */
export function textChangesFrom(changes: ChangeSet, beforeRaw?: string, afterRaw?: string): TextChange[] {
  const output: TextChange[] = [];
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (beforeRaw !== undefined && afterRaw !== undefined) {
      output.push({
        from: cmOffsetToRawOffset(beforeRaw, fromA), to: cmOffsetToRawOffset(beforeRaw, toA),
        insert: afterRaw.slice(cmOffsetToRawOffset(afterRaw, fromB), cmOffsetToRawOffset(afterRaw, toB)),
      });
    } else output.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return output;
}

export class ReviewEditorBridge {
  readonly extension: Extension;
  private readonly implementation: { refresh(): void; destroy(): void };
  constructor(
    documents: Documents,
    getReview: (documentId: string) => DocumentReview | undefined,
    changed: (documentId: string) => void,
    select: (documentId: string, suggestionIds: string[]) => void,
  ) {
    const result = build(documents, getReview, changed, select);
    this.extension = result.extension; this.implementation = result;
  }
  refresh(): void { this.implementation.refresh(); }
  destroy(): void { this.implementation.destroy(); }
}

function build(
  documents: Documents,
  getReview: (documentId: string) => DocumentReview | undefined,
  changed: (documentId: string) => void,
  select: (documentId: string, suggestionIds: string[]) => void,
): { extension: Extension; refresh(): void; destroy(): void } {
  const refreshEffect = StateEffect.define<null>();
  const registrations = new Map<EditorView, ViewRegistration>();
  let queued = false, destroyed = false;
  // `EditorState.sliceDoc()` still yields LF in CM 6.  Obsidian's public Editor
  // is the authority for the file/buffer representation, including a CRLF
  // document; fall back to sliceDoc only when this is not a Markdown editor.
  const rawFor = (view: EditorView): string => view.state.field(editorInfoField, false)?.editor?.getValue() ?? view.state.sliceDoc();
  const infoFor = (view: EditorView): Omit<ViewRegistration, 'view' | 'raw'> | undefined => {
    const info = view.state.field(editorInfoField, false); const file = info?.file;
    if (!file) return undefined;
    try { return { file, documentId: documents.recordFor(file).id }; } catch { return undefined; }
  };
  const suggestionsFor = (view: EditorView): { raw: string; documentId: string; suggestions: PositionedSuggestion[] } | undefined => {
    const info = infoFor(view); if (!info) return undefined;
    const raw = rawFor(view);
    const suggestions = eligible(getReview(info.documentId), raw).map(suggestion => ({ suggestion,
      from: rawOffsetToCmOffset(raw, suggestion.anchors!.target.from), to: rawOffsetToCmOffset(raw, suggestion.anchors!.target.to) }));
    return { raw, documentId: info.documentId, suggestions };
  };
  const makeDecorations = (view: EditorView): DecorationSet => {
    const source = suggestionsFor(view); if (!source) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    for (const segment of merged(source.suggestions)) builder.add(segment.from, segment.to,
      Decoration.mark({ class: 'dc-review-highlight', attributes: { 'data-dc-review': segment.ids.join(',') } }));
    return builder.finish();
  };
  const markers = (view: EditorView) => {
    const source = suggestionsFor(view), builder = new RangeSetBuilder<GutterMarker>();
    if (!source) return builder.finish();
    const byId = new Map(source.suggestions.map(item => [item.suggestion.id, item.suggestion]));
    for (const segment of merged(source.suggestions)) {
      const numbers = segment.ids.map(id => byId.get(id)?.number).filter(number => number !== undefined);
      const label = `${numbers[0] ?? ''}${numbers.length > 1 ? '+' : ''}`;
      builder.add(view.state.doc.lineAt(segment.from).from, view.state.doc.lineAt(segment.from).from, new NumberMarker(label, `批注 ${numbers.map(number => `#${number}`).join('、')}`));
    }
    return builder.finish();
  };

  const tracker = ViewPlugin.fromClass(class {
    registration: ViewRegistration | undefined;
    press: Press | undefined;
    constructor(readonly view: EditorView) { this.attach(); }
    private attach(): void {
      const next = infoFor(this.view);
      if (!next) return;
      this.registration = { view: this.view, ...next, raw: rawFor(this.view) }; registrations.set(this.view, this.registration);
    }
    update(update: ViewUpdate): void {
      const current = infoFor(update.view);
      if (!current) { registrations.delete(update.view); this.registration = undefined; return; }
      if (!this.registration || this.registration.file !== current.file || this.registration.documentId !== current.documentId) {
        registrations.delete(update.view); this.registration = { view: update.view, ...current, raw: rawFor(update.view) }; registrations.set(update.view, this.registration);
      }
      if (update.docChanged) {
        const before = this.registration?.raw ?? update.startState.sliceDoc();
        const after = rawFor(update.view);
        documents.observeEditor(current.file, before, after, textChangesFrom(update.changes, before, after), kindFor(update));
        if (this.registration) this.registration.raw = after;
      }
      // Map the previously cached range before recording a genuine selection
      // from the post-change state. Reversing these steps maps it twice.
      if (update.selectionSet) {
        const editor = update.state.field(editorInfoField, false)?.editor;
        if (editor) documents.cacheSelection(current.file, editor, true);
      }
      if (update.docChanged || update.selectionSet) changed(current.documentId);
    }
    destroy(): void { registrations.delete(this.view); this.press = undefined; }
  }, {
    eventObservers: {
      mousedown(event, view) {
        const instance = view.plugin(tracker);
        if (!instance || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || view.composing || !view.state.selection.main.empty) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }), source = suggestionsFor(view);
        if (pos === null || !source) return false;
        const ids = source.suggestions.filter(item => pos >= item.from && pos <= item.to).map(item => item.suggestion.id);
        instance.press = ids.length ? { x: event.clientX, y: event.clientY, documentId: source.documentId, ids } : undefined;
        return false;
      },
      mouseup(event, view) {
        const instance = view.plugin(tracker), press = instance?.press; if (instance) instance.press = undefined;
        if (!press || event.button !== 0 || view.composing || !view.state.selection.main.empty || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return false;
        select(press.documentId, press.ids); return false;
      },
      mouseleave(_event, view) { const instance = view.plugin(tracker); if (instance) instance.press = undefined; return false; },
    },
  });
  const marks = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(readonly view: EditorView) { this.decorations = makeDecorations(view); }
    update(update: ViewUpdate): void { if (update.docChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshEffect)))) this.decorations = makeDecorations(update.view); }
  }, { decorations: value => value.decorations });

  return {
    extension: [tracker, marks, gutter({ class: 'dc-review-gutter', markers })],
    refresh() {
      if (destroyed || queued) return; queued = true;
      queueMicrotask(() => {
        queued = false; if (destroyed) return;
        for (const registration of registrations.values()) if (registration.view.dom.isConnected) registration.view.dispatch({ effects: refreshEffect.of(null) });
      });
    },
    destroy() { destroyed = true; registrations.clear(); },
  };
}

export function createReviewExtension(
  documents: Documents,
  getReview: (documentId: string) => DocumentReview | undefined,
  changed: (documentId: string) => void,
  select: (documentId: string, suggestionIds: string[]) => void,
): Extension { return new ReviewEditorBridge(documents, getReview, changed, select).extension; }
