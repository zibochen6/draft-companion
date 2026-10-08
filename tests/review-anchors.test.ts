import { describe, expect, it } from 'vitest';
import { hashText } from '../src/editing';
import { ReviewAnchors } from '../src/review-anchors';
import type { Session } from '../src/types';
import type { ApplyReceipt, Suggestion } from '../src/review-types';

const author = { id: 'role', name: '编辑', systemPrompt: '规则' };
function session(id = 'doc'): Session {
  return { id, document: { id, path: '文章.md', ctime: 1 }, brief: '', selectedRoleId: 'role', mode: 'review', messages: [], review: { verifiedHash: '', runs: [], suggestions: [], receipts: [] } };
}
function snapshot(text: string, from = 0, to = text.length) {
  return { documentId: 'doc', path: '文章.md', fullText: text, hash: hashText(text), scope: from === 0 && to === text.length ? 'body' as const : 'selection' as const, from, to, selectedText: text.slice(from, to) };
}
function input(quote: string, before = '', after = '', replacement = '改后', evidenceQuotes: string[] = []) {
  return { type: '表达', title: '改进', quote, contextBefore: before, contextAfter: after, reason: '更清楚', replacement, evidenceQuotes };
}
function suggestion(anchors: NonNullable<ReturnType<ReviewAnchors['resolve']>['anchors']>, quote = '原句'): Suggestion {
  return {
    id: 's1', documentId: 'doc', runId: 'run', number: 1, type: '表达', title: '改进', quote,
    contextBefore: anchors.before?.text ?? '', contextAfter: anchors.after?.text ?? '', author,
    versions: [{ id: 'v1', at: 1, author, reason: '更清楚', replacement: '改后', evidenceQuotes: [] }], currentVersionId: 'v1',
    anchors, state: 'pending', fingerprint: 'fp', replies: [],
  };
}

describe('ReviewAnchors', () => {
  it('disambiguates repeated quotes with adjacent context and never takes the first occurrence', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const text = '前A。相同句。后A。\n前B。相同句。后B。'; const capture = service.capture(snapshot(text));
    expect(service.resolve(capture, input('相同句。', '前B。', '后B。')).anchors?.target.from).toBe(text.lastIndexOf('相同句。'));
    expect(service.resolve(capture, input('相同句。')).reason).toContain('不唯一');
  });

  it('maps a proposal around boundary inserts but invalidates only an interior target edit', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const start = '左原句右'; const capture = service.capture(snapshot(start)); const anchors = service.resolve(capture, input('原句', '左', '右')).anchors!;
    s.review!.suggestions.push(suggestion(anchors));
    expect(service.update('doc', start, '左新增原句右', [{ from: 1, to: 1, insert: '新增' }])).toBe(true);
    expect(anchors.target).toMatchObject({ from: 3, to: 5, valid: true });
    expect(service.update('doc', '左新增原句右', '左新增原X句右', [{ from: 4, to: 4, insert: 'X' }])).toBe(true);
    expect(s.review!.suggestions[0]!.state).toBe('needs-check');
    expect(anchors.target.valid).toBe(false);
  });

  it('replays edits that happened during a request and refuses an unknown divergent version', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const old = '前 原句 后'; const capture = service.capture(snapshot(old));
    expect(service.update('doc', old, '无关 前 原句 后', [{ from: 0, to: 0, insert: '无关 ' }])).toBe(true);
    const resolved = service.resolve(capture, input('原句', '前 ', ' 后'));
    expect(resolved.anchors?.target.from).toBe(5);
    s.review!.suggestions.push(suggestion(resolved.anchors!));
    service.track('doc', '完全未知');
    expect(s.review!.suggestions[0]!.anchors?.target.valid).toBe(false);
  });

  it('keeps independent changes undoable but rejects overlap or altered critical context', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const before = '前文 原句 后文'; const receipt: ApplyReceipt = {
      id: 'r1', suggestionId: 's1', versionId: 'v1', documentId: 'doc', at: 1, before: '原句', replacement: '改后',
      anchor: { from: 3, to: 5, text: '改后', valid: true }, beforeContext: { from: 0, to: 3, text: '前文 ', valid: true }, afterContext: { from: 5, to: 8, text: ' 后文', valid: true },
      state: 'applied', beforeHash: hashText(before), afterHash: hashText('前文 改后 后文'),
    };
    s.review!.receipts.push(receipt); service.track('doc', '前文 改后 后文');
    expect(service.update('doc', '前文 改后 后文', '附注\n前文 改后 后文', [{ from: 0, to: 0, insert: '附注\n' }])).toBe(true);
    expect(service.canUndo(receipt, '附注\n前文 改后 后文')).toBe(true);
    expect(service.update('doc', '附注\n前文 改后 后文', '附注\n前文 改掉 后文', [{ from: 6, to: 8, insert: '改掉' }])).toBe(true);
    expect(service.canUndo(receipt, '附注\n前文 改掉 后文')).toBe(false);
    expect(receipt.state).toBe('needs-check');
  });

  it('protects frontmatter, CRLF, and surrogate boundaries during validation', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const text = '---\r\ntitle: x\r\n---\r\n🙂原句\r\n';
    const capture = service.capture(snapshot(text, text.indexOf('🙂'), text.length));
    const anchors = service.resolve(capture, input('原句', '🙂', '\r\n')).anchors!;
    const item = suggestion(anchors); s.review!.suggestions.push(item);
    expect(() => service.validate(item, text)).not.toThrow();
    expect(service.update('doc', text, text, [{ from: text.indexOf('🙂') + 1, to: text.indexOf('🙂') + 1, insert: 'x' }])).toBe(false);
  });

  it('reconciles proven native undo and redo without losing the inverse anchor', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const original = '前 原句 后'; const applied = '前 更好的改写 后';
    const capture = service.capture(snapshot(original)); const anchors = service.resolve(capture, input('原句', '前 ', ' 后', '更好的改写')).anchors!;
    // Simulate the original application while its suggestion was registered,
    // so supporting anchors receive the ordinary application mapping.
    const item = suggestion(anchors); item.state = 'applying'; s.review!.suggestions.push(item);
    expect(service.update('doc', original, applied, [{ from: 2, to: 4, insert: '更好的改写' }], 'apply')).toBe(true);
    item.state = 'applied';
    const receipt: ApplyReceipt = {
      id: 'r-native', suggestionId: item.id, versionId: 'v1', documentId: 'doc', at: 1, before: '原句', replacement: '更好的改写',
      anchor: { from: 2, to: 7, text: '更好的改写', valid: true }, beforeContext: { from: 0, to: 2, text: '前 ', valid: true }, afterContext: { from: 7, to: 9, text: ' 后', valid: true },
      state: 'applied', beforeHash: hashText(original), afterHash: hashText(applied),
    };
    s.review!.receipts.push(receipt);
    expect(service.update('doc', applied, original, [{ from: 2, to: 7, insert: '原句' }], 'undo')).toBe(true);
    expect(receipt.state).toBe('undone'); expect(item.state).toBe('pending'); expect(receipt.anchor).toMatchObject({ from: 2, to: 4, valid: true });
    expect(receipt.afterContext).toMatchObject({ from: 4, to: 6, valid: true });
    expect(service.update('doc', original, applied, [{ from: 2, to: 4, insert: '更好的改写' }], 'redo')).toBe(true);
    expect(receipt.state).toBe('applied'); expect(item.state).toBe('applied'); expect(receipt.anchor).toMatchObject({ from: 2, to: 7, valid: true });
  });

  it('proves CodeMirror minimal-prefix/suffix native undo and redo, without searching for another quote', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const oldPart = '共享开头--旧中间--共享结尾', replacement = '共享开头--新中间内容--共享结尾';
    const original = `前 ${oldPart} 后`, applied = `前 ${replacement} 后`, start = 2;
    const capture = service.capture(snapshot(original)); const anchors = service.resolve(capture, input(oldPart, '前 ', ' 后', replacement)).anchors!;
    expect(service.update('doc', original, applied, [{ from: start, to: start + oldPart.length, insert: replacement }], 'apply')).toBe(true);
    const item = suggestion(anchors, oldPart); item.state = 'applied'; s.review!.suggestions.push(item);
    const receipt: ApplyReceipt = { id: 'minimal', suggestionId: item.id, versionId: 'v1', documentId: 'doc', at: 1, before: oldPart, replacement,
      anchor: { from: start, to: start + replacement.length, text: replacement, valid: true }, beforeContext: { from: 0, to: start, text: '前 ', valid: true }, afterContext: { from: start + replacement.length, to: applied.length, text: ' 后', valid: true }, state: 'applied', beforeHash: hashText(original), afterHash: hashText(applied) };
    s.review!.receipts.push(receipt);
    const prefix = '共享开头--', suffix = '--共享结尾', newMiddle = '新中间内容', oldMiddle = '旧中间';
    const undoFrom = start + prefix.length, undoTo = start + replacement.length - suffix.length;
    expect(service.update('doc', applied, original, [{ from: undoFrom, to: undoTo, insert: oldMiddle }], 'undo')).toBe(true);
    expect(receipt.state).toBe('undone'); expect(item.state).toBe('pending'); expect(receipt.anchor).toMatchObject({ from: start, to: start + oldPart.length, text: oldPart, valid: true });
    const redoFrom = start + prefix.length, redoTo = start + oldPart.length - suffix.length;
    expect(service.update('doc', original, applied, [{ from: redoFrom, to: redoTo, insert: newMiddle }], 'redo')).toBe(true);
    expect(receipt.state).toBe('applied'); expect(item.state).toBe('applied'); expect(receipt.anchor).toMatchObject({ from: start, to: start + replacement.length, text: replacement, valid: true });
  });

  it('keeps the native undo fact but requires recheck when an applied target was also critical evidence', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const original = '前 原句 后', applied = '前 改后 后'; const capture = service.capture(snapshot(original));
    const anchors = service.resolve(capture, input('原句', '前 ', ' 后', '改后', ['原句'])).anchors!;
    const item = suggestion(anchors); item.state = 'applying'; s.review!.suggestions.push(item);
    expect(service.update('doc', original, applied, [{ from: 2, to: 4, insert: '改后' }], 'apply')).toBe(true);
    item.state = 'applied';
    const receipt: ApplyReceipt = { id: 'evidence', suggestionId: item.id, versionId: 'v1', documentId: 'doc', at: 1, before: '原句', replacement: '改后', anchor: { from: 2, to: 4, text: '改后', valid: true }, beforeContext: { from: 0, to: 2, text: '前 ', valid: true }, afterContext: { from: 4, to: 6, text: ' 后', valid: true }, state: 'applied', beforeHash: hashText(original), afterHash: hashText(applied) };
    s.review!.receipts.push(receipt);
    expect(service.update('doc', applied, original, [{ from: 2, to: 4, insert: '原句' }], 'undo')).toBe(true);
    expect(receipt.state).toBe('undone'); expect(item.state).toBe('needs-check');
  });

  it('does not revive a receipt for an out-of-proof native change, and marks the linked applied suggestion for recheck', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const applied = '前 改后 后', changed = '前 改X后 后'; const capture = service.capture(snapshot('前 原句 后'));
    const anchors = service.resolve(capture, input('原句', '前 ', ' 后', '改后')).anchors!;
    expect(service.update('doc', '前 原句 后', applied, [{ from: 2, to: 4, insert: '改后' }], 'apply')).toBe(true);
    const item = suggestion(anchors); item.state = 'applied'; s.review!.suggestions.push(item);
    const receipt: ApplyReceipt = { id: 'overlap', suggestionId: item.id, versionId: 'v1', documentId: 'doc', at: 1, before: '原句', replacement: '改后', anchor: { from: 2, to: 4, text: '改后', valid: true }, beforeContext: { from: 0, to: 2, text: '前 ', valid: true }, afterContext: { from: 4, to: 6, text: ' 后', valid: true }, state: 'applied', beforeHash: hashText('前 原句 后'), afterHash: hashText(applied) };
    s.review!.receipts.push(receipt);
    // This is a native-undo-labelled edit inside the receipt, but its result
    // cannot reconstruct the recorded original text, so it must not revive.
    expect(service.update('doc', applied, changed, [{ from: 3, to: 3, insert: 'X' }], 'undo')).toBe(true);
    expect(receipt.state).toBe('needs-check'); expect(item.state).toBe('needs-check');
  });

  it('does not revive a receipt from an out-of-range native change that overlaps its safety context', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const original = '前 原句 后', applied = '前 改后 后', changed = '前X改后 后'; const capture = service.capture(snapshot(original));
    const anchors = service.resolve(capture, input('原句', '前 ', ' 后', '改后')).anchors!;
    expect(service.update('doc', original, applied, [{ from: 2, to: 4, insert: '改后' }], 'apply')).toBe(true);
    const item = suggestion(anchors); item.state = 'applied'; s.review!.suggestions.push(item);
    const receipt: ApplyReceipt = { id: 'outside', suggestionId: item.id, versionId: 'v1', documentId: 'doc', at: 1, before: '原句', replacement: '改后', anchor: { from: 2, to: 4, text: '改后', valid: true }, beforeContext: { from: 0, to: 2, text: '前 ', valid: true }, afterContext: { from: 4, to: 6, text: ' 后', valid: true }, state: 'applied', beforeHash: hashText(original), afterHash: hashText(applied) };
    s.review!.receipts.push(receipt);
    expect(service.update('doc', applied, changed, [{ from: 1, to: 2, insert: 'X' }], 'undo')).toBe(true);
    expect(receipt.state).toBe('needs-check'); expect(item.state).toBe('needs-check');
  });

  it('rejects an in-flight capture after several known edits followed by an unknown gap', () => {
    const s = session(); const service = new ReviewAnchors(id => id === 'doc' ? s : undefined);
    const initial = '前 原句 后'; const capture = service.capture(snapshot(initial));
    const first = '甲 前 原句 后'; const second = '甲 前 原句 后乙';
    expect(service.update('doc', initial, first, [{ from: 0, to: 0, insert: '甲 ' }])).toBe(true);
    expect(service.update('doc', first, second, [{ from: first.length, to: first.length, insert: '乙' }])).toBe(true);
    // The next editor report cannot be derived from the tracked central text.
    expect(service.update('doc', '另一个窗格', '未知正文', [])).toBe(false);
    expect(service.resolve(capture, input('原句', '前 ', ' 后')).reason).toContain('版本链中断');
  });
});
