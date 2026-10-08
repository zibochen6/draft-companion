import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, MarkdownView, TestEditor } from './obsidian-mock';
import { Documents } from '../src/documents';
import { Controller } from '../src/controller';
import { Store } from '../src/store';
import { ReviewAnchors } from '../src/review-anchors';
import type { App, WorkspaceLeaf } from 'obsidian';
import type { ChatMessage, Provider } from '../src/types';

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('../src/provider', () => ({ chat: chatMock, listModels: vi.fn() }));

const ARTICLE = '---\ntitle: 审阅样例\n---\n第一句需要修改。' + '甲'.repeat(80) + '第二句需要修改。\n';
function result(items: unknown[]) { return JSON.stringify({ summary: '有两处需要改进。', overall: [], suggestions: items }); }
function item(quote: string, before: string, after: string, replacement: string | null) {
  return { type: '表达', title: quote.slice(0, 3), quote, contextBefore: before, contextAfter: after, reason: '让读者更容易理解。', replacement, evidenceQuotes: [] };
}
function fixture(persist: (value: unknown) => Promise<void> = async () => {}) {
  const a = new TFile('A.md'), b = new TFile('B.md');
  const aEditor = new TestEditor(ARTICLE), bEditor = new TestEditor('B 文稿');
  const aView = new MarkdownView(a, aEditor), bView = new MarkdownView(b, bEditor);
  const leaves = [{ view: aView }, { view: bView }]; let recent = leaves[0]!;
  const files = new Map([[a.path, a], [b.path, b]]); const disk = new Map([[a.path, ARTICLE], [b.path, bEditor.text]]);
  const app = {
    workspace: { getLeavesOfType: () => leaves, getMostRecentLeaf: () => recent, getLeaf: () => undefined, revealLeaf: async () => undefined },
    vault: { getAbstractFileByPath: (path: string) => files.get(path), read: async (file: TFile) => disk.get(file.path)!, process: async (file: TFile, callback: (current: string) => string) => { disk.set(file.path, callback(disk.get(file.path)!)); } },
    secretStorage: { getSecret: () => undefined },
  } as unknown as App;
  const store = new Store(null, persist as never); const docs = new Documents(app, store.data.sessions);
  docs.focus(recent as unknown as WorkspaceLeaf); const controller = new Controller(app, store, docs, () => {});
  store.data.providers = [{ id: 'p', name: '模拟服务', baseUrl: 'http://test/v1', secretRef: '', model: 'mock', stream: false, timeoutMs: 1000 }]; store.data.activeProviderId = 'p';
  return { app, store, docs, controller, a, b, aEditor, bEditor, setRecent(index: number) { recent = leaves[index]!; docs.focus(recent as unknown as WorkspaceLeaf); } };
}
async function reviewTwo(f: ReturnType<typeof fixture>) {
  chatMock.mockResolvedValueOnce({ text: result([
    item('第一句需要修改。', '\n', '甲', '第一句已经改好。'),
    item('第二句需要修改。', '甲'.repeat(80), '\n', '第二句已经改好。'),
  ]), finishReason: 'stop' });
  await f.controller.review('审阅');
  return f.controller.currentSession()!.review!;
}

beforeEach(() => chatMock.mockReset());

describe('0.2 review workflow', () => {
  it('applies a large first suggestion then an independent second one, and per-item undo preserves manual text', async () => {
    const f = fixture(); const review = await reviewTwo(f); const [first, second] = review.suggestions;
    expect(first?.state).toBe('pending'); expect(second?.state).toBe('pending');
    await f.controller.acceptSuggestion(first!.documentId, first!.id);
    expect(f.aEditor.text).toContain('第一句已经改好。'); expect(second!.state).toBe('pending');
    await f.controller.acceptSuggestion(second!.documentId, second!.id);
    expect(f.aEditor.text).toContain('第二句已经改好。');
    const beforeManual = f.aEditor.text; f.aEditor.text += '作者后记。';
    f.docs.observeEditor(f.a, beforeManual, f.aEditor.text, [{ from: beforeManual.length, to: beforeManual.length, insert: '作者后记。' }]);
    expect(f.controller.canUndoSuggestion(first!.documentId, first!.id)).toBe(true);
    await f.controller.undoSuggestion(first!.documentId, first!.id);
    expect(f.aEditor.text).toContain('第一句需要修改。'); expect(f.aEditor.text).toContain('第二句已经改好。'); expect(f.aEditor.text).toContain('作者后记。');
  });

  it('does not allow an old whole-document candidate to overwrite a local accepted sentence edit', async () => {
    const f = fixture();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ explanation: '整篇候选', replacement: '整篇新稿', notes: [] }), finishReason: 'stop' });
    await f.controller.send('整篇改写', 'edit', 'body'); const old = f.controller.currentSession()!.candidate!;
    const review = await reviewTwo(f); await f.controller.acceptSuggestion(review.suggestions[0]!.documentId, review.suggestions[0]!.id);
    expect(old.state).toBe('stale'); await expect(f.controller.apply(old)).rejects.toThrow();
    expect(f.aEditor.text).toContain('第一句已经改好。');
  });

  it('deduplicates reordered same-role JSON without reviving ignored feedback, while retaining an identical other-role review', async () => {
    const f = fixture(); const first = await reviewTwo(f); const suggestion = first.suggestions[0]!;
    await f.controller.ignoreSuggestion(suggestion.documentId, suggestion.id);
    // Same logical result, but the provider emitted its object keys in a
    // different order.  Fingerprints must follow fields, never JSON order.
    const reordered = { evidenceQuotes: [], replacement: '第一句已经改好。', reason: '让读者更容易理解。', contextAfter: '甲', quote: '第一句需要修改。', title: '第一句', type: '表达', contextBefore: '\n' };
    chatMock.mockResolvedValueOnce({ text: result([reordered]), finishReason: 'stop' });
    await f.controller.review('再审阅');
    expect(first.runs.at(-1)?.duplicates).toBe(1); expect(first.suggestions.filter(s => s.quote === '第一句需要修改。')).toHaveLength(1); expect(suggestion.state).toBe('ignored');
    f.controller.currentSession()!.selectedRoleId = f.store.data.roles[1]!.id;
    chatMock.mockResolvedValueOnce({ text: result([reordered]), finishReason: 'stop' });
    await f.controller.review('换角色审阅');
    expect(first.suggestions.filter(s => s.quote === '第一句需要修改。')).toHaveLength(2);
    expect(first.suggestions.at(-1)?.author.id).toBe(f.store.data.roles[1]!.id);
  });

  it('keeps author and scope immutable across a revision, and preview has no model request or write', async () => {
    const f = fixture(); const review = await reviewTwo(f); const target = review.suggestions[0]!; const originalAuthor = target.author;
    const beforePreview = f.aEditor.text; const calls = chatMock.mock.calls.length;
    const preview = await f.controller.previewSuggestion(target.documentId, target.id);
    expect(preview.valid).toBe(true); expect(preview.after).toContain('第一句已经改好。'); expect(chatMock).toHaveBeenCalledTimes(calls); expect(f.aEditor.text).toBe(beforePreview);
    f.controller.currentSession()!.selectedRoleId = f.store.data.roles[0]!.id;
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ reason: '换一种更自然的表达。', replacement: '第一句新版。', evidenceQuotes: [] }), finishReason: 'stop' });
    await f.controller.askSuggestion(target.documentId, target.id, '再改一版', true);
    expect(target.author).toEqual(originalAuthor); expect(target.versions).toHaveLength(2); expect(target.versions[0]!.supersededBy).toBe(target.versions[1]!.id);
    expect(target.versions[1]!.author.id).toBe(f.store.data.roles[0]!.id); expect(target.anchors?.scope.from).toBeGreaterThanOrEqual(0);
  });

  it('freezes document A, and stopping a late review never creates comments in A or B', async () => {
    const f = fixture();
    chatMock.mockImplementation(() => new Promise<{ text: string; finishReason: string }>(resolve => { setTimeout(() => resolve({ text: result([item('第一句需要修改。', '\n', '甲', '迟到')]), finishReason: 'stop' }), 1); }));
    const pending = f.controller.review('审阅 A');
    for (let index = 0; index < 200 && chatMock.mock.calls.length === 0; index++) await Promise.resolve();
    expect(f.controller.running?.documentId).toBe(f.controller.currentSession()!.document.id);
    expect(chatMock).toHaveBeenCalledOnce();
    const messages = chatMock.mock.calls[0]![2] as ChatMessage[]; expect(messages.map(message => message.content).join('\n')).toContain('第一句需要修改。');
    f.setRecent(1); f.controller.stop(); await pending;
    const sessions = Object.values(f.store.data.sessions);
    expect(sessions.find(s => s.document.path === 'A.md')?.review?.suggestions).toHaveLength(0);
    expect(sessions.find(s => s.document.path === 'B.md')?.review?.suggestions ?? []).toHaveLength(0);
  });

  it('does not write text when the pre-write persistence claim fails', async () => {
    const f = fixture();
    const review = await reviewTwo(f); const s = review.suggestions[0]!; const before = f.aEditor.text;
    vi.spyOn(f.store, 'save').mockRejectedValueOnce(new Error('磁盘满'));
    await expect(f.controller.acceptSuggestion(s.documentId, s.id)).rejects.toThrow('磁盘满');
    expect(f.aEditor.text).toBe(before); expect(s.state).toBe('needs-check');
  });

  it('keeps the in-memory receipt after a post-write save failure and is conservative after restart', async () => {
    let saveCount = 0; let failAt = Number.POSITIVE_INFINITY; const written: unknown[] = [];
    const f = fixture(async data => { saveCount++; if (saveCount === failAt) throw new Error('后续保存失败'); written.push(structuredClone(data)); });
    const review = await reviewTwo(f); const s = review.suggestions[0]!;
    failAt = saveCount + 2; // intent persists, write succeeds, receipt persistence fails
    await expect(f.controller.acceptSuggestion(s.documentId, s.id)).rejects.toThrow('本条已写入');
    expect(f.aEditor.text).toContain('第一句已经改好。'); expect(review.receipts).toHaveLength(1); expect(review.receipts[0]!.state).toBe('applied');
    failAt = Number.POSITIVE_INFINITY; await f.store.save();
    const persisted = written.at(-1)!;
    const restored = new Store(persisted, async () => {}); const restoredSession = restored.data.sessions[s.documentId]!;
    const matching = new ReviewAnchors(id => restored.data.sessions[id]); matching.track(s.documentId, f.aEditor.text);
    expect(restoredSession.review!.receipts[0]!.state).toBe('applied');
    const changed = new Store(persisted, async () => {}); const conservative = new ReviewAnchors(id => changed.data.sessions[id]);
    conservative.track(s.documentId, `${f.aEditor.text}外部修改`);
    expect(changed.data.sessions[s.documentId]!.review!.receipts[0]!.state).toBe('needs-check');
  });

  it('does not create a new revision when its frozen target changes while the request is running', async () => {
    const f = fixture(); const review = await reviewTwo(f); const s = review.suggestions[0]!; const versions = s.versions.length;
    const priorCalls = chatMock.mock.calls.length;
    chatMock.mockImplementation(() => new Promise<{ text: string; finishReason: string }>(resolve => setTimeout(() => resolve({ text: JSON.stringify({ reason: '迟到版本', replacement: '第一句不应写入。', evidenceQuotes: [] }), finishReason: 'stop' }), 1)));
    const pending = f.controller.askSuggestion(s.documentId, s.id, '再改一版', true);
    for (let index = 0; index < 200 && chatMock.mock.calls.length === priorCalls; index++) await Promise.resolve();
    const before = f.aEditor.text; const at = before.indexOf('第一句需要修改。');
    f.aEditor.text = before.slice(0, at) + '第一句已被作者修改。' + before.slice(at + '第一句需要修改。'.length);
    f.docs.observeEditor(f.a, before, f.aEditor.text, [{ from: at, to: at + '第一句需要修改。'.length, insert: '第一句已被作者修改。' }]);
    await expect(pending).rejects.toThrow('重新审阅');
    expect(s.versions).toHaveLength(versions); expect(s.state).toBe('needs-check');
  });

  it('allows a revision when only a known insertion before its frozen target occurs during the request', async () => {
    const f = fixture(); const review = await reviewTwo(f); const s = review.suggestions[0]!; const versions = s.versions.length;
    const priorCalls = chatMock.mock.calls.length;
    chatMock.mockImplementation(() => new Promise<{ text: string; finishReason: string }>(resolve => { setTimeout(() => resolve({ text: JSON.stringify({ reason: '保留原授权范围的新版本。', replacement: '第一句连续新版。', evidenceQuotes: [] }), finishReason: 'stop' }), 10); }));
    const pending = f.controller.askSuggestion(s.documentId, s.id, '再改一版', true);
    for (let index = 0; index < 200 && chatMock.mock.calls.length === priorCalls; index++) await Promise.resolve();
    const before = f.aEditor.text; const at = before.indexOf('第一句需要修改。'); const prefix = '作者前言。';
    f.aEditor.text = before.slice(0, at) + prefix + before.slice(at);
    f.docs.observeEditor(f.a, before, f.aEditor.text, [{ from: at, to: at, insert: prefix }]);
    await pending;
    expect(s.versions).toHaveLength(versions + 1); expect(s.versions.at(-1)?.replacement).toBe('第一句连续新版。');
    expect(s.anchors?.target.from).toBe(at + prefix.length); expect(s.state).toBe('pending');
  });

  it('rolls back an ignored state when persistence fails, keeping selection and body unchanged', async () => {
    const f = fixture(); const review = await reviewTwo(f); const s = review.suggestions[0]!; review.selectedId = s.id; const before = f.aEditor.text;
    vi.spyOn(f.store, 'save').mockRejectedValueOnce(new Error('无法保存忽略状态'));
    await expect(f.controller.ignoreSuggestion(s.documentId, s.id)).rejects.toThrow('无法保存忽略状态');
    expect(s.state).toBe('pending'); expect(review.selectedId).toBe(s.id); expect(f.aEditor.text).toBe(before);
  });
});

describe('real-review integration contract', () => {
  it('sends and persists the unsaved source buffer, selection, rules and selected connection without a key', async () => {
    const f=fixture();const unsaved='未保存的重复句。';f.aEditor.text=ARTICLE+unsaved;
    const from=ARTICLE.length,to=from+unsaved.length;
    f.aEditor.selection={anchor:f.aEditor.offsetToPos(from),head:f.aEditor.offsetToPos(to)};
    f.store.data.preferences='保留作者口吻';const session=f.controller.currentSession()!;session.brief='给第一次读文章的人';
    const provider=f.store.data.providers[0]!;provider.secretRef='TEST_SECRET_REFERENCE_NOT_IN_REVIEW';
    (f.app.secretStorage as unknown as {getSecret:()=>string}).getSecret=()=> 'synthetic-private-key';
    chatMock.mockResolvedValueOnce({text:result([item(unsaved,'','','未保存的新句。')]),finishReason:'stop'});
    await f.controller.review('检查选区','selection');
    const messages=chatMock.mock.calls[0]![2] as ChatMessage[];
    expect(messages.map(message=>message.content).join('\n')).toContain(unsaved);
    const run=session.review!.runs[0]!;
    expect(run).toMatchObject({documentId:session.document.id,path:'A.md',providerId:'p',model:'mock',input:'检查选区',preferences:'保留作者口吻',brief:'给第一次读文章的人',scope:'selection',from,to,selection:unsaved,snapshot:f.aEditor.text,status:'completed'});
    expect(run.author.systemPrompt).toBe(f.store.data.roles[0]!.systemPrompt);
    expect(JSON.stringify(run)).not.toContain('synthetic-private-key');expect(JSON.stringify(run)).not.toContain('TEST_SECRET_REFERENCE_NOT_IN_REVIEW');
    expect(new Store(f.store.data,async()=>{}).data.sessions[session.document.id]!.review!.runs[0]!.snapshot).toBe(f.aEditor.text);
    const before=f.aEditor.text;const suggestion=session.review!.suggestions[0]!;
    const preview=await f.controller.previewSuggestion(suggestion.documentId,suggestion.id);
    expect(f.aEditor.text).toBe(before);expect(chatMock).toHaveBeenCalledOnce();
    await f.controller.acceptSuggestion(suggestion.documentId,suggestion.id);
    expect(f.aEditor.text).toBe(preview.after);expect(f.aEditor.text.slice(0,from)).toBe(ARTICLE);
  });

  it.each(['', '---\ntitle: only metadata\n---\n\n  '])('rejects an empty body before any model call: %j', async text=> {
    const f=fixture();f.aEditor.text=text;
    await expect(f.controller.review('审阅','body')).rejects.toThrow('正文为空');
    expect(chatMock).not.toHaveBeenCalled();const review=f.controller.currentSession()!.review!;
    expect(review.runs.at(-1)).toMatchObject({status:'failed',errorKind:'empty-document'});expect(review.suggestions).toHaveLength(0);
  });

  it('a valid empty suggestion array is a completed review, distinct from failure', async()=> {
    const f=fixture();chatMock.mockResolvedValueOnce({text:JSON.stringify({summary:'本轮没有具体修改。',overall:[],suggestions:[]}),finishReason:'stop'});
    await f.controller.review('审阅');const review=f.controller.currentSession()!.review!;
    expect(review.runs[0]).toMatchObject({status:'completed',summary:'本轮没有具体修改。',added:0});expect(review.runs[0]!.error).toBeUndefined();expect(review.suggestions).toHaveLength(0);
  });

  it.each([
    {text:'  ',finishReason:'stop',kind:'empty-output'},
    {text:'{"summary":"unfinished',finishReason:'stop',kind:'format'},
    {text:result([item('第一句需要修改。','','','新句。')]),finishReason:'length',kind:'truncated'},
    {text:'不能完成这个请求。',finishReason:'content_filter',kind:'refusal'},
    {text:result([item('第一句需要修改。','','','新句。')]),finishReason:'',kind:'truncated'},
  ])('does not produce applicable comments for $kind', async response=> {
    const f=fixture();chatMock.mockResolvedValueOnce(response);const before=f.aEditor.text;
    await expect(f.controller.review('审阅')).rejects.toThrow();const review=f.controller.currentSession()!.review!;
    expect(review.runs.at(-1)).toMatchObject({status:'failed',errorKind:response.kind,errorDiagnostic:{category:response.kind,stage:'review'}});
    expect(review.suggestions).toHaveLength(0);expect(f.aEditor.text).toBe(before);
  });

  it('schema failure rejects the complete batch instead of salvaging the first valid edit', async()=> {
    const f=fixture();const invalid={...item('第二句需要修改。','','','新句。')} as Record<string,unknown>;delete invalid.reason;
    chatMock.mockResolvedValueOnce({text:result([item('第一句需要修改。','','','新句。'),invalid]),finishReason:'stop'});
    await expect(f.controller.review('审阅')).rejects.toThrow('reason');expect(f.controller.currentSession()!.review!.suggestions).toHaveLength(0);
  });

  it('retains missing replacements as readable comments and forbids accepting them', async()=> {
    const f=fixture();const {replacement:_replacement,...comment}=item('第一句需要修改。','','',null);
    chatMock.mockResolvedValueOnce({text:result([comment]),finishReason:'stop'});await f.controller.review('审阅');
    const review=f.controller.currentSession()!.review!,suggestion=review.suggestions[0]!;
    expect(suggestion.state).toBe('comment');expect(suggestion.versions[0]!.replacement).toBeNull();expect(review.selectedId).toBe(suggestion.id);
    await expect(f.controller.acceptSuggestion(suggestion.documentId,suggestion.id)).rejects.toThrow('没有可采纳');expect(f.aEditor.text).toBe(ARTICLE);
  });

  it('selects readable unlocated comments rather than hiding them when every quote is ambiguous', async()=> {
    const f=fixture();f.aEditor.text+='第一句需要修改。';
    chatMock.mockResolvedValueOnce({text:result([item('第一句需要修改。','','','新句。')]),finishReason:'stop'});await f.controller.review('审阅');
    const review=f.controller.currentSession()!.review!,suggestion=review.suggestions[0]!;
    expect(suggestion.state).toBe('unlocated');expect(suggestion.invalidReason).toContain('不唯一');expect(review.selectedId).toBe(suggestion.id);
    await expect(f.controller.acceptSuggestion(suggestion.documentId,suggestion.id)).rejects.toThrow();expect(f.aEditor.text).toBe(ARTICLE+'第一句需要修改。');
  });

  it('keeps a completed response assigned to its original document and original model after switching', async()=> {
    const f=fixture();let complete!:(value:{text:string;finishReason:string})=>void;
    chatMock.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const originalSession=f.controller.currentSession()!,originalRole={...f.store.data.roles[0]!};const pending=f.controller.review('审阅 A');
    for(let i=0;i<200 && !complete;i++)await Promise.resolve();expect(complete).toBeDefined();
    f.setRecent(1);f.store.data.providers[0]!.model='different-model';f.store.data.roles[0]!.systemPrompt='changed role';
    complete({text:result([item('第一句需要修改。','','','新句。')]),finishReason:'stop'});await pending;
    expect(originalSession.review!.suggestions).toHaveLength(1);expect(originalSession.review!.runs[0]).toMatchObject({model:'mock',author:{systemPrompt:originalRole.systemPrompt}});
    expect(f.controller.currentSession()!.document.path).toBe('B.md');expect(f.controller.currentSession()!.review?.suggestions ?? []).toHaveLength(0);
  });

  it('retries only the original selection in the original document, never a newly selected range', async()=> {
    const f=fixture(),quote='第二句需要修改。',from=ARTICLE.indexOf(quote),to=from+quote.length;
    f.aEditor.selection={anchor:f.aEditor.offsetToPos(from),head:f.aEditor.offsetToPos(to)};
    chatMock.mockRejectedValueOnce(new Error('合成连接失败'));await expect(f.controller.review('仅审阅第二句','selection')).rejects.toThrow();
    const session=f.controller.currentSession()!,run=session.review!.runs[0]!;
    f.aEditor.selection={anchor:f.aEditor.offsetToPos(ARTICLE.indexOf('第一句')),head:f.aEditor.offsetToPos(ARTICLE.indexOf('第一句')+8)};
    f.setRecent(1);chatMock.mockResolvedValueOnce({text:result([item(quote,'','','第二句更清楚。')]),finishReason:'stop'});
    await f.controller.retryReview(session.document.id,run.id);
    expect(session.review!.runs.at(-1)).toMatchObject({documentId:session.document.id,scope:'selection',from,to,selection:quote,input:'仅审阅第二句'});
    expect(f.controller.currentSession()!.document.path).toBe('B.md');expect(session.review!.suggestions[0]?.anchors?.target.from).toBe(from);
  });

  it('refuses a retry after the source changed without making another request', async()=> {
    const f=fixture();chatMock.mockRejectedValueOnce(new Error('合成连接失败'));await expect(f.controller.review('审阅')).rejects.toThrow();
    const session=f.controller.currentSession()!,run=session.review!.runs[0]!;f.aEditor.text+='作者新写的一句。';
    await expect(f.controller.retryReview(session.document.id,run.id)).rejects.toThrow('文稿已变化');expect(chatMock).toHaveBeenCalledOnce();
    expect(session.review!.runs.at(-1)).toMatchObject({status:'failed',errorKind:'stale'});expect(session.review!.suggestions).toHaveLength(0);
  });

  it('stores safe provider diagnostics without raw response details', async()=> {
    const f=fixture();const error=Object.assign(new Error('服务额度不足。'),{kind:'quota',diagnostics:{category:'quota',httpStatus:429,code:'insufficient_quota',stage:'chat'}});
    chatMock.mockRejectedValueOnce(error);await expect(f.controller.review('审阅')).rejects.toThrow('额度');
    const run=f.controller.currentSession()!.review!.runs[0]!;
    expect(run).toMatchObject({errorKind:'quota',errorDiagnostic:{category:'quota',httpStatus:429,code:'insufficient_quota',stage:'chat'}});
    expect(new Store(f.store.data,async()=>{}).data.sessions[run.documentId!]!.review!.runs[0]!.errorDiagnostic).toEqual(run.errorDiagnostic);
  });

  it('rejects corrupt persisted review ownership, scope and snapshot instead of restoring unsafe retry data', async()=> {
    const f=fixture();await reviewTwo(f);const documentId=f.controller.currentSession()!.document.id;
    for (const damage of ['owner','scope','snapshot','selection','diagnostic'] as const) {
      const saved=structuredClone(f.store.data),run=saved.sessions[documentId]!.review!.runs[0]!;
      if(damage==='owner')run.documentId='another-document';
      if(damage==='scope')run.to=run.snapshot!.length+1;
      if(damage==='snapshot')run.snapshot+='tampered';
      if(damage==='selection')run.selection='not the original selection';
      if(damage==='diagnostic')run.errorDiagnostic={category:'quota',httpStatus:999,stage:'chat'};
      expect(()=>new Store(saved,async()=>{})).toThrow('数据损坏');
    }
  });

  it('makes a stopped late result inert even after a newer review completes', async()=> {
    const f=fixture();let late!:(value:{text:string;finishReason:string})=>void;
    chatMock.mockImplementationOnce(()=>new Promise(resolve=>{late=resolve;}));const first=f.controller.review('第一轮');
    for(let i=0;i<200 && !late;i++)await Promise.resolve();f.controller.stop();
    const review=f.controller.currentSession()!.review!;expect(review.runs[0]!.status).toBe('stopped');
    chatMock.mockResolvedValueOnce({text:result([item('第二句需要修改。','','','第二轮新句。')]),finishReason:'stop'});await f.controller.review('第二轮');
    late({text:result([item('第一句需要修改。','','','迟到新句。')]),finishReason:'stop'});await first;
    expect(review.suggestions).toHaveLength(1);expect(review.suggestions[0]!.quote).toBe('第二句需要修改。');expect(review.runs[0]!.status).toBe('stopped');
  });

  it('closing the plugin marks the original review interrupted and rejects late results', async()=> {
    const f=fixture();let late!:(value:{text:string;finishReason:string})=>void;
    chatMock.mockImplementationOnce(()=>new Promise(resolve=>{late=resolve;}));const pending=f.controller.review('审阅');
    for(let i=0;i<200 && !late;i++)await Promise.resolve();const review=f.controller.currentSession()!.review!;
    f.controller.close();late({text:result([item('第一句需要修改。','','','迟到')]),finishReason:'stop'});await pending;
    expect(review.runs[0]!.status).toBe('interrupted');expect(review.suggestions).toHaveLength(0);expect(f.aEditor.text).toBe(ARTICLE);
  });
});
