import { describe, expect, it, vi } from 'vitest';
import { bodyStart, hashText, replaceExact } from '../src/editing';
import { Reviews } from '../src/reviews';
import { Store } from '../src/store';
import type { Documents } from '../src/documents';
import type { ReviewRun } from '../src/review-types';

function fixture(text: string, quote: string, replacement: string) {
  let current = text;
  const store = new Store(null, async () => {});
  const role = store.data.roles[0]!;
  const document = { id: 'synthetic', path: 'synthetic.md', ctime: 1 };
  const session = store.data.sessions.synthetic = { id: document.id, document, selectedRoleId: role.id, brief: '', mode: 'review' as const, messages: [] };
  let reviews: Reviews;
  const write = vi.fn(async (_document, expected: string, from: number, to: number, insert: string, validate: (text: string) => void) => {
    expect(current).toBe(expected); validate(current);
    const before=current; current=replaceExact(current,from,to,insert);
    reviews.anchors.update(document.id,before,current,[{from,to,insert}],'apply');
  });
  const documents = { resolve: () => ({ path: document.path }), read: async () => current, bufferText: () => current, applyRangeValidated: write } as unknown as Documents;
  reviews = new Reviews(store, documents, () => {}, () => {}, new Set());
  const snapshot = { documentId: document.id, path: document.path, fullText: text, hash: hashText(text), scope: 'body' as const, from: bodyStart(text), to: text.length, selectedText: text.slice(bodyStart(text)) };
  const capture = reviews.anchors.capture(snapshot);
  const run: ReviewRun = { id: 'run', requestId: 'request', at: 1, author: { id: role.id, name: role.name, systemPrompt: role.systemPrompt }, model: 'fixture', providerName: 'test-only', snapshotHash: snapshot.hash, scope: 'body', status: 'running', summary: '', overall: [], added: 0, duplicates: 0 };
  reviews.addResult(session, run, capture, { summary: '合成验证', overall: [], suggestions: [{ type: '表达', title: '改写', quote, contextBefore: '', contextAfter: '', reason: '检查正文保护', replacement }] }, role);
  return { reviews, write, suggestion: store.data.sessions.synthetic!.review!.suggestions[0]!, removePrefix(length: number) {
    const before=current;current=current.slice(length);reviews.anchors.update(document.id,before,current,[{from:0,to:length,insert:''}]);
  } };
}

describe('sentence review frontmatter protection', () => {
  it.each(['---\ntitle: model\n---\n新正文', '---\ntitle: unfinished'])('blocks a first-sentence replacement that introduces YAML: %s', async replacement => {
    const f = fixture('原句。\n下一句。', '原句。', replacement);
    const p = await f.reviews.preview('synthetic', f.suggestion.id);
    expect(p.valid).toBe(false);
    await expect(f.reviews.accept('synthetic', f.suggestion.id)).rejects.toThrow('frontmatter');
    expect(f.write).not.toHaveBeenCalled();
  });

  it('allows a body edit after unchanged YAML', async () => {
    const text = '---\ntitle: 作者\n---\n原句。\n下一句。';
    const f = fixture(text, '原句。', '更清楚的句子。');
    const p = await f.reviews.preview('synthetic', f.suggestion.id);
    expect(p.valid).toBe(true);
    expect(p.after).toBe(text.replace('原句。', '更清楚的句子。'));
    expect(f.write).not.toHaveBeenCalled();
  });

  it('blocks undo that would turn an old body passage into YAML after a manual prefix removal', async () => {
    const quote='---\ntitle: body\n---\n';
    const f=fixture(`前言。\n${quote}后文。`,quote,'普通正文。\n');
    await f.reviews.accept('synthetic',f.suggestion.id);
    expect(f.reviews.canUndo('synthetic',f.suggestion.id)).toBe(true);
    f.removePrefix('前言。\n'.length);
    expect(f.reviews.canUndo('synthetic',f.suggestion.id)).toBe(false);
    await expect(f.reviews.undo('synthetic',f.suggestion.id)).rejects.toThrow('frontmatter');
    expect(f.write).toHaveBeenCalledOnce();
  });
});
