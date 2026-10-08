import type { App, WorkspaceLeaf } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DailyTopicRunner, type DailyRunnerHost } from '../src/daily-runner';
import { runDailyPipeline, type DailyPipelineResult } from '../src/daily-pipeline';
import { fetchSource, SourceResponseCache, type PublicTransport, type SourceOptions } from '../src/daily-sources';
import * as providerApi from '../src/provider';
import type { SourceItem, TopicCard } from '../src/daily-types';
import { Store } from '../src/store';
import { Documents } from '../src/documents';
import { MarkdownView, TestEditor, TFile } from './obsidian-mock';

const ORIGINAL = '# 选题库\n\n- [ ] **旧项目** — 原始内容必须保留\n';
function result(id = 'repo-1'): DailyPipelineResult {
  const item: SourceItem = { id, canonicalId: `repository:owner/${id}`, kind: 'repository', title: id, summary: '资料归档工作流', source: 'GitHub 补充', url: `https://github.com/owner/${id}`, fingerprint: 'facts-1', materials: [{ url: `https://github.com/owner/${id}`, text: '支持资料归档。', status: 'verified' }] };
  const card: TopicCard = { sourceId: id, selected: true, reason: '具体读者问题', angle: '演示一个工作流', primaryTitle: '让收藏资料有下一步', alternativeTitles: ['资料归档从哪开始', '收藏太多怎么办', '把复制减少一次', '一个容易复用的归档动作'], opening: '收藏完资料，如何真正用起来？', outline: ['问题', '操作', '限制'], gaps: ['补充实际操作'], potential: 'high', evidence: [{ sourceId: id, quote: '支持资料归档。' }] };
  return { items: [item], cards: [card], sources: [{ name: 'GitHub 补充', status: 'fallback', message: '模拟来源', at: 1 }], observations: [{ canonicalId: item.canonicalId, fingerprint: item.fingerprint }], noChanges: false, summary: '一个合格选题' };
}
function fixture(persist: (data: unknown) => Promise<void> = async () => {}) {
  const a = new TFile('Projects/选题库.md'), b = new TFile('B.md'), aEditor = new TestEditor(ORIGINAL), bEditor = new TestEditor('B 的正文');
  const aView = new MarkdownView(a, aEditor), bView = new MarkdownView(b, bEditor), leaves = [{ view: aView }, { view: bView }];
  const files = new Map([[a.path, a], [b.path, b]]), disk = new Map([[a.path, ORIGINAL], [b.path, bEditor.text]]);
  const app = { workspace: { getLeavesOfType: () => leaves, getMostRecentLeaf: () => leaves[0] }, vault: {
    getAbstractFileByPath: (path: string) => files.get(path), read: async (file: TFile) => disk.get(file.path)!,
    process: vi.fn(async (file: TFile, transform: (text: string) => string) => { disk.set(file.path, transform(disk.get(file.path)!)); }),
  }, secretStorage: { getSecret: () => undefined } } as unknown as App;
  const store = new Store(null, persist), documents = new Documents(app, store.data.sessions); documents.focus(leaves[0] as unknown as WorkspaceLeaf);
  store.data.topicLibrary = documents.current()!;
  store.data.providers = [{ id: 'provider', name: '模拟模型服务', baseUrl: 'https://example.test/v1', secretRef: '', model: 'model', stream: true, timeoutMs: 60000 }]; store.data.activeProviderId = 'provider';
  const host: DailyRunnerHost = { app, store, documents, data: store.data, running: undefined, editing: new Set(), changed: vi.fn(), key: () => undefined };
  const runner = new DailyTopicRunner(host), pipeline = vi.fn(async () => result()); runner.dependencies.pipeline = pipeline;
  documents.onChange(change => runner.map(change.documentId, change.before, change.after, change.changes, change.kind));
  return { store, documents, runner, host, pipeline, a, b, aEditor, bEditor, aView, bView, leaves, files, disk };
}

describe('fixed-target daily runner with real atomic document service', () => {
  it.each([true, false])('preserves the frozen stream=%s choice in production and no-write preview', async stream => {
    const f = fixture(); f.store.data.providers[0]!.stream = stream;
    const request = vi.spyOn(providerApi, 'chat').mockResolvedValue({ text: '{"summary":"合成材料暂不优选。","shortlist":[]}', finishReason: 'stop' });
    try {
      f.runner.dependencies.pipeline = async options => {
        f.store.data.providers[0]!.stream = !stream;
        await options.chat([{ role: 'user', content: '合成采集材料' }], options.signal);
        return { items: [], cards: [], sources: [], observations: [], noChanges: true, summary: '合成零结果' };
      };
      await f.runner.start('manual', '2026-10-08');
      expect(request.mock.calls[0]?.[0].stream).toBe(stream);
      f.store.data.providers[0]!.stream = stream;
      f.runner.dependencies.sourceOptions = { request: async options => ({ status: 200, url: options.url, text: options.url.startsWith('https://git-stars.org/') ? '<a href="https://github.com/synthetic/knowledge-tool">合成知识工具</a><p>合成资料归档工作流。</p>' : options.url.includes('api.github.com') ? '{"items":[]}' : '{"schemaVersion":1,"items":[]}' }) };
      const before = f.aEditor.text;
      await f.runner.preview();
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[0].stream).toBe(stream);
      expect(f.aEditor.text).toBe(before); expect(f.aEditor.transactions).toBe(0);
    } finally { request.mockRestore(); }
  });
  it('shares its bounded public ETag cache between production runs and no-write preview', async () => {
    const f = fixture(), listUrl = 'https://aihot.news/api/v1/items?mode=selected&window=24h&limit=50';
    let productionOptions: SourceOptions | undefined; const sentEtags: (string | undefined)[] = [];
    const request: PublicTransport = async options => {
      expect(options).not.toHaveProperty('key');
      if (options.url === listUrl) {
        sentEtags.push(options.etag);
        if (options.etag === 'synthetic-list-v1') return { status: 304, text: '', url: options.url };
        return { status: 200, text: '{"schemaVersion":1,"items":[]}', url: options.url, etag: 'synthetic-list-v1' };
      }
      if (options.url.startsWith('https://git-stars.org/')) return { status: 403, text: '', url: options.url };
      return { status: 200, text: options.url.includes('api.github.com') ? '{"items":[]}' : '{"schemaVersion":1,"items":[]}', url: options.url };
    };
    f.runner.dependencies.sourceOptions = { request };
    f.runner.dependencies.pipeline = async options => {
      productionOptions = options.sourceOptions;
      await fetchSource(listUrl, options.signal, options.sourceOptions);
      return { items: [], cards: [], sources: [], observations: [], noChanges: true, summary: '合成缓存验证' };
    };
    await f.runner.start('manual', '2026-10-08');
    expect(productionOptions?.cache).toBeInstanceOf(SourceResponseCache);
    expect((productionOptions?.cache as SourceResponseCache).maxEntries).toBe(128);
    const before = f.aEditor.text, runs = f.runner.data.runs.length;
    const preview = await f.runner.preview();
    expect(preview.noChanges).toBe(true); expect(sentEtags).toEqual([undefined, 'synthetic-list-v1']);
    expect(f.aEditor.text).toBe(before); expect(f.runner.data.runs).toHaveLength(runs);
  });
  it('preserves an explicitly injected public cache for controlled tests', async () => {
    const f = fixture(), cache = new Map(); f.runner.dependencies.sourceOptions = { cache };
    f.runner.dependencies.pipeline = async options => {
      expect(options.sourceOptions?.cache).toBe(cache);
      return { items: [], cards: [], sources: [], observations: [], noChanges: true, summary: '合成空结果' };
    };
    await f.runner.start('manual', '2026-10-08');
  });
  it('does not pump a queued job before its initial record save resolves', async () => {
    let release!: () => void; let began!: () => void; let calls = 0;
    const started = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async () => { if (++calls === 1) { began(); await gate; } });
    f.host.changed = () => { queueMicrotask(() => { void f.runner.pump(); }); };
    const pending = f.runner.start('manual', '2026-10-08'); await started;
    f.host.changed(); await f.runner.pump(); await Promise.resolve();
    expect(f.pipeline).not.toHaveBeenCalled(); expect(f.aEditor.transactions).toBe(0); expect(f.runner.status()?.status).toBe('queued');
    release(); await pending; expect(f.pipeline).toHaveBeenCalledOnce(); expect(f.aEditor.text).toContain('repo\\-1');
  });
  it('initial queue persistence failure prevents all model and document activity', async () => {
    let reject!: (reason: Error) => void; let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>((_resolve, fail) => { reject = fail; });
    const f = fixture(async () => { began(); await gate; });
    const pending = f.runner.start('manual', '2026-10-08'), checked = expect(pending).rejects.toThrow('初始记录保存失败');
    await started; await f.runner.pump(); expect(f.pipeline).not.toHaveBeenCalled(); reject(new Error('初始记录保存失败')); await checked;
    expect(f.aEditor.text).toBe(ORIGINAL); expect(f.aEditor.transactions).toBe(0); expect(f.runner.data.receipts).toHaveLength(0); expect(f.runner.status()?.status).toBe('failed');
  });
  it('stop during the initial save keeps a later save completion inert', async () => {
    let release!: () => void; let began!: () => void; let calls = 0;
    const started = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async () => { if (++calls === 1) { began(); await gate; } });
    const pending = f.runner.start('manual', '2026-10-08'); await started; f.runner.stop(); await f.runner.pump(); release(); await pending; await f.store.save();
    expect(f.pipeline).not.toHaveBeenCalled(); expect(f.aEditor.text).toBe(ORIGINAL); expect(f.aEditor.transactions).toBe(0); expect(f.runner.status()?.status).toBe('stopped');
  });
  it('writes a real checked card and saves the prepared receipt before the editor transaction', async () => {
    const saved: { states: string[]; transactions: number }[] = []; let f!: ReturnType<typeof fixture>;
    f = fixture(async data => { const current = data as typeof f.store.data; saved.push({ states: current.dailyTopics!.receipts.map(receipt => receipt.state), transactions: f.aEditor.transactions }); });
    await f.runner.start('manual', '2026-10-08');
    expect(f.pipeline).toHaveBeenCalledOnce(); expect(f.aEditor.text).toContain('- [x] **repo\\-1**'); expect(f.aEditor.text).toContain('**旧项目**');
    expect(f.aEditor.transactions).toBe(1); expect(saved.some(snapshot => snapshot.states.includes('prepared') && snapshot.transactions === 0)).toBe(true);
    expect(f.runner.data.receipts[0]!.state).toBe('applied'); expect(f.runner.status()?.status).toBe('completed'); expect(f.host.running).toBeUndefined();
    expect(f.runner.data.seen['repository:owner/repo-1']?.selected).toBe(true);
  });
  it('queues behind chat once and freezes the target, role, provider and profile', async () => {
    const f = fixture(); f.host.running = { id: 'chat', documentId: f.documents.current()!.id, path: f.a.path, sessionId: 'chat-session', roleName: '伙伴', text: '', mode: 'discuss', stop: () => {} };
    f.store.data.dailyTopics!.settings.authorBackground = '冻结背景'; const oldRule = f.store.data.roles[0]!.systemPrompt;
    await f.runner.start('manual', '2026-10-08'); await f.runner.start('manual', '2026-10-08'); expect(f.runner.data.runs).toHaveLength(1); expect(f.pipeline).not.toHaveBeenCalled();
    f.documents.focus(f.leaves[1] as unknown as WorkspaceLeaf); f.store.data.dailyTopics!.settings.authorBackground = '后来的背景'; f.store.data.roles[0]!.systemPrompt = '后来的规则';
    f.pipeline.mockImplementation(async options => { expect(options.profile).toContain('冻结背景'); expect(options.profile).not.toContain('后来的背景'); expect(options.roleRules).toBe(oldRule); return result(); });
    f.host.running = undefined; await f.runner.pump(); expect(f.aEditor.text).toContain('repo\\-1'); expect(f.bEditor.text).toBe('B 的正文');
  });
  it('can cancel a queued job without model calls or writes', async () => {
    const f = fixture(); f.host.running = { id: 'chat', documentId: f.documents.current()!.id, path: f.a.path, sessionId: 'chat-session', roleName: '伙伴', text: '', mode: 'discuss', stop: () => {} };
    await f.runner.start('manual', '2026-10-08'); f.runner.stop(); f.host.running = undefined; await f.runner.pump();
    expect(f.pipeline).not.toHaveBeenCalled(); expect(f.aEditor.text).toBe(ORIGINAL); expect(f.runner.status()?.status).toBe('stopped');
  });
  it('a queued target follows rename of the same TFile without retargeting', async () => {
    const f = fixture(); const document = f.store.data.topicLibrary!;
    f.host.running = { id: 'chat', documentId: document.id, path: f.a.path, sessionId: 'chat-session', roleName: '伙伴', text: '', mode: 'discuss', stop: () => {} };
    await f.runner.start('manual', '2026-10-08');
    const old = f.a.path, next = '改名后/选题库.md', disk = f.disk.get(old)!;
    f.files.delete(old); f.disk.delete(old); f.a.path = next; f.files.set(next, f.a); f.disk.set(next, disk);
    f.documents.renamed(f.a as never, old); document.path = next; f.runner.renamed(old, next);
    f.host.running = undefined; await f.runner.pump();
    expect(f.aEditor.text).toContain('repo\\-1'); expect(f.runner.status()?.path).toBe(next); expect(f.runner.data.receipts[0]!.path).toBe(next);
    expect(f.runner.data.receipts[0]!.documentId).toBe(document.id); expect(() => new Store(f.store.data, async () => {})).not.toThrow();
  });
  it('ignores a late pipeline result after stop', async () => {
    const f = fixture(); let finish!: (value: DailyPipelineResult) => void; let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; }); f.pipeline.mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = f.runner.start('manual', '2026-10-08'); await begun; f.runner.stop(); finish(result()); await pending;
    expect(f.aEditor.text).toBe(ORIGINAL); expect(f.aEditor.transactions).toBe(0); expect(f.runner.data.receipts).toHaveLength(0); expect(f.runner.status()?.status).toBe('stopped');
  });
  it('reads the latest unsaved buffer after collection without sending that note to the model', async () => {
    const f = fixture(); f.pipeline.mockImplementation(async options => { expect(options.profile).not.toContain('旧项目'); expect(options.preferences).not.toContain('旧项目'); f.aEditor.text += '请求期间手写\n'; return result(); });
    await f.runner.start('manual', '2026-10-08'); expect(f.aEditor.text).toContain('请求期间手写'); expect(f.aEditor.text).toContain('repo\\-1');
  });
  it('prevents duplicate cards on same-day reruns and preserves manual changes', async () => {
    const f = fixture(); await f.runner.start('manual', '2026-10-08');
    f.aEditor.text = f.aEditor.text.replace('- [x] **repo\\-1**', '- [ ] **我手写的项目名**');
    await f.runner.start('manual', '2026-10-08'); expect(f.aEditor.text.match(/draft-companion:topic:.*:start/g)).toHaveLength(1);
    expect(f.aEditor.text).toContain('- [ ] **我手写的项目名**'); expect(f.runner.status()?.status).toBe('no-new'); expect(f.runner.data.receipts).toHaveLength(1);
  });
  it('deduplicates an authored mixed-case GitHub URL using the frozen canonical repository key', async () => {
    const f = fixture(); f.aEditor.text += '- [ ] **我的仓库** — https://github.com/OWNER/Repo-1?tab=readme-ov-file#intro\n';
    const text = f.aEditor.text, batch = result(), chat = vi.fn(async () => { throw new Error('既有手写仓库不应再次请求模型'); });
    f.runner.dependencies.chat = chat;
    f.runner.dependencies.pipeline = async options => {
      expect(options.existing?.get('repository:owner/repo-1')).toBe('*');
      return runDailyPipeline({ ...options, collect: async () => ({ items: batch.items, sources: batch.sources }) });
    };
    await f.runner.start('manual', '2026-10-08');
    expect(f.aEditor.text).toBe(text); expect(f.aEditor.transactions).toBe(0); expect(chat).not.toHaveBeenCalled(); expect(f.runner.status()?.status).toBe('no-new'); expect(f.runner.data.receipts).toHaveLength(0);
  });
  it.each(['edited', 'undone'] as const)('does not revive an %s unselected candidate when fresh source facts arrive', async treatment => {
    const f = fixture(), candidate = result(); candidate.cards[0]!.selected = false;
    f.pipeline.mockResolvedValueOnce(candidate); await f.runner.start('manual', '2026-10-08');
    expect(f.runner.data.seen['repository:owner/repo-1']?.selected).toBe(false);
    const receipt = f.runner.data.receipts[0]!;
    if (treatment === 'undone') await f.runner.undo(receipt.id);
    else {
      const before = f.aEditor.text, from = before.indexOf('- [ ] **repo\\-1**'), original = '- [ ] **repo\\-1**', insert = '- [ ] **用户自己的选题标题**';
      f.aEditor.text = before.slice(0, from) + insert + before.slice(from + original.length);
      f.documents.observeEditor(f.a, before, f.aEditor.text, [{ from, to: from + original.length, insert }]);
    }
    const text = f.aEditor.text, renewed = result(); renewed.items[0]!.fingerprint = 'new-facts-2'; renewed.observations[0]!.fingerprint = 'new-facts-2';
    const chat = vi.fn(async () => { throw new Error('用户编辑或撤回的候选不应自动重新选择'); }); f.runner.dependencies.chat = chat;
    f.runner.dependencies.pipeline = async options => {
      expect(options.existingSelected?.has('repository:owner/repo-1')).toBe(true);
      return runDailyPipeline({ ...options, collect: async () => ({ items: renewed.items, sources: renewed.sources }) });
    };
    await f.runner.start('manual', '2026-10-09');
    expect(f.aEditor.text).toBe(text); expect(chat).not.toHaveBeenCalled(); expect(f.runner.status()?.status).toBe('no-new');
    expect(f.runner.data.receipts).toHaveLength(1); expect(f.runner.data.seen['repository:owner/repo-1']?.selected).toBe(false);
  });
  it('preserves unrelated later edits when undoing a completed batch', async () => {
    const f = fixture(); await f.runner.start('manual', '2026-10-08'); const receipt = f.runner.data.receipts[0]!;
    const before = f.aEditor.text, insert = '后续手写\n'; f.aEditor.text += insert;
    f.documents.observeEditor(f.a, before, f.aEditor.text, [{ from: before.length, to: before.length, insert }]);
    expect(f.runner.canUndo(receipt.id)).toBe(true); await f.runner.undo(receipt.id);
    expect(f.aEditor.text).not.toContain('repo\\-1'); expect(f.aEditor.text).toContain('后续手写'); expect(f.aEditor.text).toContain('**旧项目**'); expect(receipt.state).toBe('undone');
    await expect(f.runner.undo(receipt.id)).rejects.toThrow('无法安全撤回');
  });
  it('requires configuration and never writes to a deleted or replaced target', async () => {
    const f = fixture(); const target = f.store.data.topicLibrary!; delete f.store.data.topicLibrary;
    await expect(f.runner.start()).rejects.toThrow('绑定选题库'); f.store.data.topicLibrary = target;
    f.store.data.providers[0]!.model = ''; await expect(f.runner.start()).rejects.toThrow('服务、模型'); f.store.data.providers[0]!.model = 'model';
    f.pipeline.mockImplementation(async () => { f.documents.deleted(f.a as never); const replacement = new TFile(f.a.path); f.files.set(f.a.path, replacement); return result(); });
    await f.runner.start('manual', '2026-10-08'); expect(f.runner.status()?.status).toBe('failed'); expect(f.aEditor.text).toBe(ORIGINAL);
  });
  it('keeps successful writes and warns if the final receipt save fails', async () => {
    let calls = 0; const f = fixture(async () => { if (++calls >= 3) throw new Error('存储失败'); });
    await f.runner.start('manual', '2026-10-08'); expect(f.aEditor.text).toContain('repo\\-1'); expect(f.aEditor.transactions).toBe(1); expect(f.runner.status()?.message).toContain('已写入');
    expect(f.runner.data.receipts[0]!.state).toBe('applied'); expect(f.host.running).toBeUndefined();
  });
  it('waits for a transient second-pane echo before confirming the committed batch', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), duplicate = new TestEditor(ORIGINAL);
      f.leaves.push({ view: new MarkdownView(f.a, duplicate) });
      let committed!: () => void;
      const written = new Promise<void>(resolve => { committed = resolve; }), apply = f.aEditor.transaction.bind(f.aEditor);
      vi.spyOn(f.aEditor, 'transaction').mockImplementation(spec => {
        apply(spec); setTimeout(() => { duplicate.text = f.aEditor.text; }, 100); committed();
      });
      const job = f.runner.start('manual', '2026-10-08'); await written;
      expect(f.runner.data.receipts[0]!.state).toBe('prepared');
      await vi.advanceTimersByTimeAsync(99); expect(f.runner.data.receipts[0]!.state).toBe('prepared');
      await vi.advanceTimersByTimeAsync(1); await job;
      expect(f.runner.data.receipts[0]!.state).toBe('applied'); expect(f.runner.status()?.stage).toBe('已完成');
      expect(await f.documents.read(f.store.data.topicLibrary!)).toBe(f.aEditor.text);
      expect(f.aEditor.transactions).toBe(1); expect(duplicate.transactions).toBe(0); expect(f.pipeline).toHaveBeenCalledOnce();
      expect(f.runner.canUndo(f.runner.data.receipts[0]!.id)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('stops read-only settling after one second when same-file buffers stay forked', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), duplicate = new TestEditor(ORIGINAL), startedAt = Date.now();
      f.leaves.push({ view: new MarkdownView(f.a, duplicate) });
      const job = f.runner.start('manual', '2026-10-08'); await vi.runAllTimersAsync(); await job;
      expect(Date.now() - startedAt).toBe(1000);
      expect(f.runner.data.receipts[0]!.state).toBe('needs-check'); expect(f.runner.status()?.message).toContain('已写入');
      expect(f.aEditor.text).toContain('repo\\-1'); expect(duplicate.text).toBe(ORIGINAL);
      expect(f.aEditor.transactions).toBe(1); expect(duplicate.transactions).toBe(0); expect(f.pipeline).toHaveBeenCalledOnce();
      expect(f.runner.canUndo(f.runner.data.receipts[0]!.id)).toBe(false); expect(f.host.editing.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('rejects a genuine postwrite edit as soon as the two buffers become readable', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), duplicate = new TestEditor(ORIGINAL), startedAt = Date.now();
      f.leaves.push({ view: new MarkdownView(f.a, duplicate) });
      const apply = f.aEditor.transaction.bind(f.aEditor);
      vi.spyOn(f.aEditor, 'transaction').mockImplementation(spec => {
        apply(spec);
        setTimeout(() => { f.aEditor.text += '\n作者的后续编辑。'; duplicate.text = f.aEditor.text; }, 100);
      });
      const job = f.runner.start('manual', '2026-10-08'); await vi.runAllTimersAsync(); await job;
      expect(Date.now() - startedAt).toBe(100); expect(f.runner.data.receipts[0]!.state).toBe('needs-check');
      expect(f.aEditor.text).toContain('作者的后续编辑。'); expect(duplicate.text).toBe(f.aEditor.text);
      expect(f.aEditor.transactions).toBe(1); expect(f.pipeline).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('does not write an empty day when source collection fails', async () => {
    const f = fixture(); f.pipeline.mockRejectedValue(new Error('全部来源失败'));
    await f.runner.start('manual', '2026-10-08'); expect(f.aEditor.text).toBe(ORIGINAL); expect(f.aEditor.transactions).toBe(0); expect(f.runner.status()?.status).toBe('failed'); expect(f.runner.data.receipts).toHaveLength(0);
  });
  it('clearing chat preserves daily configuration, run records, receipts and written cards', async () => {
    const f = fixture(); f.runner.data.settings.authorBackground = '保留背景'; await f.runner.start('manual', '2026-10-08');
    const session = f.store.data.sessions[f.store.data.topicLibrary!.id]!, daily = structuredClone(f.runner.data), text = f.aEditor.text;
    session.messages.push({ id: 'chat', role: 'user', content: '聊天', at: 1 }); f.store.clear(session); await f.store.save();
    expect(session.messages).toEqual([]); expect(f.runner.data).toEqual(daily); expect(f.aEditor.text).toBe(text); expect(f.runner.canUndo(daily.receipts[0]!.id)).toBe(true);
  });
});
