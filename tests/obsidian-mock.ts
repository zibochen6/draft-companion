export class TFile {
  stat = { ctime: 1, mtime: 1, size: 0 };
  constructor(public path: string) {}
  get extension() { return this.path.split('.').pop(); }
  get basename() { return this.path.split('/').pop()?.replace(/\.md$/, ''); }
}
export class MarkdownView {
  mode = 'source';
  constructor(public file: TFile, public editor: TestEditor) {}
  getMode() { return this.mode; }
  getViewData() { return this.editor.getValue(); }
}
export class TestEditor {
  selection = { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } };
  transactions = 0;
  constructor(public text: string) {}
  getValue() { return this.text; }
  listSelections() { return [this.selection]; }
  posToOffset(pos: { line: number; ch: number }) {
    return this.text.split('\n').slice(0, pos.line).reduce((a, line) => a + line.length + 1, 0) + pos.ch;
  }
  offsetToPos(offset: number) {
    const lines = this.text.slice(0, offset).split('\n');
    return { line: lines.length - 1, ch: lines[lines.length - 1]!.length };
  }
  transaction(spec: { changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[] }) {
    this.transactions++;
    for (const change of spec.changes) {
      const from = this.posToOffset(change.from), to = this.posToOffset(change.to);
      this.text = this.text.slice(0, from) + change.text + this.text.slice(to);
    }
  }
}
export class Notice { constructor(_message: string) {} }
export class App {}
