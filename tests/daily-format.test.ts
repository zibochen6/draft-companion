import type { App, WorkspaceLeaf } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { planDailyTopicReformat } from '../src/daily-format';
import { DailyTopicRunner, type DailyRunnerHost } from '../src/daily-runner';
import type { DailyTopicRun, TopicBatchReceipt, TopicCard } from '../src/daily-types';
import { hashText } from '../src/editing';
import { Store } from '../src/store';
import { Documents } from '../src/documents';
import { DAILY_AREA_END, DAILY_AREA_START } from '../src/daily-notes';
import { MarkdownView, TestEditor, TFile } from './obsidian-mock';

const DATE = '2026-10-08';
const OLD = '- [x] **原有作者项目** — 保留原始链接 https://example.test/original\n\n作者后记 😀。\n\n```md\n- [ ] 代码里的任务示例\n```\n';
function legacy(newline = '\n', metadata?: string) {
  const lines = (value: string) => value.replace(/\n/g, newline);
  const canonicalIds = ['repository:sample/alternative', 'repository:sample/recommended'];
  const cards: TopicCard[] = canonicalIds.map((canonicalId, index) => ({ sourceId: `source_${hashText(canonicalId).slice(0, 20)}`, selected: index === 1,
    reason: index ? '帮助创作者整理资料。正文需要演示真实操作。' : '与资料管理有关。需要补充材料。', gaps: ['补充作者实际使用记录'], potential: index ? 'high' : 'needs-materials',
    ...(index ? { angle: '从整理资料到复用工作流', primaryTitle: '收藏的资料怎样真正用起来', alternativeTitles: ['资料整理从一个动作开始', '给收藏夹安排下一步', '把重复复制减少一次', '一个可以复用的知识工作流'], opening: '资料收藏之后，下一步是什么？', outline: ['具体问题', '工作流演示', '适用限制'] } : {}) }));
  const texts = canonicalIds.map((canonicalId, index) => {
    const id = hashText(canonicalId + '\nfacts-v1');
    return { id, canonicalId, text: lines(`<!-- draft-companion:topic:${id}:start -->\n- [${index ? 'x' : ' '}] **${index ? '推荐项目' : '候选项目'}** — 旧的长段落\n  - 推荐理由：${cards[index]!.reason}\n  - 首推标题：${index ? '收藏的资料怎样真正用起来' : '尚未优选'}\n<!-- draft-companion:topic:${id}:end -->\n\n`) };
  });
  let before = lines(`---\ntitle: 我的选题库\n---\n# 选题库\n\n${DAILY_AREA_START}\n<!-- draft-companion:day:${DATE}:start -->\n## ${DATE} · 自动选题\n${metadata ?? '> 首次采集：2026-10-08 09:00:00 +08:00｜最近更新：2026-10-08 09:00:00 +08:00\n> 来源：AIHOT：成功；Git Stars：失败｜候选：2｜优选：1'}\n\n`);
  const blocks = texts.map(row => { const from = before.length; before += row.text; return { id: row.id, canonicalId: row.canonicalId, anchor: { from, to: before.length, text: row.text, valid: true } }; });
  before += lines(`<!-- draft-companion:day:${DATE}:end -->\n${DAILY_AREA_END}\n\n${OLD}`);
  const run: DailyTopicRun = { id: 'run-complete', date: DATE, origin: 'manual', status: 'completed', stage: '已完成', documentId: 'doc', path: 'Projects/选题库.md', startedAt: 1, completedAt: 2, sources: [], cards,
    entries: cards.map((card, index) => ({ sourceId: card.sourceId, title: index ? '推荐项目' : '候选项目', url: `https://github.com/sample/${index ? 'recommended' : 'alternative'}`, source: '合成公开来源' })), receiptId: 'receipt' };
  const receipt: TopicBatchReceipt = { id: 'receipt', runId: run.id, documentId: 'doc', path: run.path!, date: DATE, at: 2, state: 'applied', beforeHash: hashText(lines(OLD)), afterHash: hashText(before), blocks };
  return { before, run, receipt };
}

function fixture(options: { save?: (call: number, data: unknown) => void; backupReadFail?: boolean; newline?: string } = {}) {
  const value = legacy(options.newline), file = new TFile(value.run.path!), editor = new TestEditor(value.before), view = new MarkdownView(file, editor), leaves = [{ view }];
  const adapterData = new Map<string, string>(), dir = '.obsidian/plugins/draft-companion', snapshots: { state: string; transactions: number }[] = [];
  const adapter = { mkdir: vi.fn(async () => {}), write: vi.fn(async (path: string, text: string) => { adapterData.set(path, text); }),
    read: vi.fn(async (path: string) => { if (options.backupReadFail && path.endsWith('/document-before.md')) return 'invalid backup'; const text = adapterData.get(path); if (text === undefined) throw new Error('Missing test data'); return text; }) };
  const app = { workspace: { getLeavesOfType: () => leaves, getMostRecentLeaf: () => leaves[0] }, vault: { configDir: '.obsidian', adapter,
    getAbstractFileByPath: (path: string) => path === file.path ? file : undefined, read: async () => value.before,
    process: vi.fn(async (_file: TFile, transform: (text: string) => string) => transform(value.before)),
  } } as unknown as App;
  let call = 0;
  const store = new Store(null, async data => {
    options.save?.(++call, data); snapshots.push({ state: data.dailyTopics!.receipts[0]!.state, transactions: editor.transactions });
    adapterData.set(dir + '/data.json', JSON.stringify(data, null, 2));
  });
  const documents = new Documents(app, store.data.sessions); documents.focus(leaves[0] as unknown as WorkspaceLeaf);
  const document = documents.current()!; store.data.topicLibrary = document; const session = store.sessionFor(document);
  value.run.documentId = value.receipt.documentId = document.id;
  store.data.dailyTopics!.runs = [value.run]; store.data.dailyTopics!.receipts = [value.receipt];
  const host: DailyRunnerHost = { app, store, documents, data: store.data, running: undefined, editing: new Set(), changed: vi.fn(), key: vi.fn(() => { throw new Error('No credential use allowed'); }) };
  const runner = new DailyTopicRunner(host); runner.dependencies.pipeline = vi.fn(async () => { throw new Error('No model or sources allowed'); });
  documents.onChange(change => runner.map(change.documentId, change.before, change.after, change.changes, change.kind));
  return { value, file, editor, view, leaves, adapter, adapterData, dir, snapshots, store, documents, session, host, runner };
}

describe('proven daily batch formatting', () => {
  it.each(['\n', '\r\n'])('moves recommendations first and preserves all original text outside the batch with %j', newline => {
    const f = legacy(newline), frozen = structuredClone(f), plan = planDailyTopicReformat(f.before, f.run, f.receipt);
    expect(plan.after.indexOf('**推荐项目**')).toBeLessThan(plan.after.indexOf('**候选项目**'));
    expect(plan.after).toContain(`### 收藏的资料怎样真正用起来${newline}`);
    expect(plan.after).toContain('帮助创作者整理资料。'); expect(plan.after).toContain('> [!example]- 写作预设');
    expect(plan.after).toContain(`## ${DATE} · 选题日报`); expect(plan.after).toContain('> 推荐：1｜备选：1 · 勾选表示推荐创作');
    expect(plan.after).not.toContain('首次采集'); expect(plan.after.endsWith(OLD.replace(/\n/g, newline))).toBe(true);
    expect(plan.after.slice(0, f.before.indexOf(DAILY_AREA_START))).toBe(f.before.slice(0, f.before.indexOf(DAILY_AREA_START)));
    expect(new Set(plan.blocks.map(block => block.id))).toEqual(new Set(f.receipt.blocks.map(block => block.id)));
    for (const block of plan.blocks) expect(plan.after.slice(block.anchor.from, block.anchor.to)).toBe(block.anchor.text);
    expect(f).toEqual(frozen);
    if (newline === '\r\n') expect(plan.after.replace(/\r\n/g, '')).not.toContain('\n');
  });
  it('keeps hand-written metadata unchanged', () => {
    const metadata = '> 我的计划：先试用，再写正文\n> 来源：我手写的内容｜候选：2｜优选：1', f = legacy('\n', metadata);
    expect(planDailyTopicReformat(f.before, f.run, f.receipt).after).toContain(metadata);
  });
  it('does not rewrite old-looking metadata when the date heading was edited', () => {
    const f = legacy(); f.before = f.before.replace(`## ${DATE} · 自动选题`, `## ${DATE} · 我自己的安排`); f.receipt.afterHash = hashText(f.before);
    // Keep the actual card coordinates in sync with this known prefix edit.
    const delta = '我自己的安排'.length - '自动选题'.length;
    f.receipt.blocks.forEach(block => { block.anchor.from += delta; block.anchor.to += delta; });
    expect(planDailyTopicReformat(f.before, f.run, f.receipt).after).toContain('> 首次采集：');
  });
  it('is a no-op after a successful format', () => {
    const f = legacy(), plan = planDailyTopicReformat(f.before, f.run, f.receipt);
    const receipt = { ...f.receipt, afterHash: hashText(plan.after), blocks: plan.blocks };
    expect(planDailyTopicReformat(plan.after, f.run, receipt).changes).toEqual([]);
  });
  it.each(['edited-text', 'broken-version', 'invalid-anchor', 'unknown-source', 'duplicate-source', 'nonadjacent', 'frontmatter'])('refuses unsafe %s without changing stored data', problem => {
    const f = legacy();
    if (problem === 'edited-text') f.before = f.before.replace('旧的长段落', '作者自己改过的内容');
    if (problem === 'broken-version') f.receipt.afterHash = hashText('unknown version');
    if (problem === 'invalid-anchor') f.receipt.blocks[0]!.anchor.valid = false;
    if (problem === 'unknown-source') f.run.entries![0]!.sourceId = 'unknown';
    if (problem === 'duplicate-source') f.run.entries![0]!.sourceId = f.run.entries![1]!.sourceId;
    if (problem === 'nonadjacent') { const at = f.receipt.blocks[1]!.anchor.from; f.before = f.before.slice(0, at) + '作者补充\n' + f.before.slice(at); f.receipt.blocks[1]!.anchor.from += 5; f.receipt.blocks[1]!.anchor.to += 5; f.receipt.afterHash = hashText(f.before); }
    if (problem === 'frontmatter') { const at = f.before.indexOf('\n---\n') + 1; f.before = f.before.slice(0, at) + f.before.slice(at + 4); f.receipt.afterHash = hashText(f.before); }
    const snapshot = structuredClone(f); expect(() => planDailyTopicReformat(f.before, f.run, f.receipt)).toThrow(); expect(f).toEqual(snapshot);
  });
});

describe('durable formatting through the actual document service', () => {
  it('backs up, persists prepared before one transaction and keeps conversation/configuration untouched', async () => {
    const f = fixture(); f.session.messages.push({ id: 'keep-chat', role: 'user', content: '保留聊天记录', at: 1 });
    f.store.data.providers = [{ id: 'configured', name: '原服务', baseUrl: 'https://example.test/v1', secretRef: 'official-reference', model: 'model', stream: true, timeoutMs: 60000 }];
    const beforeSettings = structuredClone(f.runner.data.settings), beforeMessages = structuredClone(f.session.messages), beforeProviders = structuredClone(f.store.data.providers);
    const outcome = await f.runner.reformatLatest();
    expect(outcome.status).toBe('formatted'); expect(outcome.changed).toBe(true); expect(f.editor.transactions).toBe(1);
    expect(f.snapshots.some(snapshot => snapshot.state === 'prepared' && snapshot.transactions === 0)).toBe(true);
    expect(f.adapterData.get(outcome.backup + '/document-before.md')).toBe(f.value.before);
    expect(JSON.parse(f.adapterData.get(outcome.backup + '/data-before.json')!).dailyTopics.receipts[0].state).toBe('applied');
    expect(f.runner.data.receipts[0]!.state).toBe('applied'); expect(f.runner.data.receipts[0]!.beforeHash).toBe(hashText(f.value.before));
    expect(f.runner.data.receipts[0]!.afterHash).toBe(hashText(f.editor.text)); expect(f.session.messages).toEqual(beforeMessages);
    expect(f.store.data.providers).toEqual(beforeProviders); expect(f.runner.data.settings).toEqual(beforeSettings); expect(f.runner.data.runs).toHaveLength(1);
    expect(f.runner.dependencies.pipeline).not.toHaveBeenCalled(); expect(f.host.key).not.toHaveBeenCalled(); expect(f.host.editing.size).toBe(0);
  });
  it('ordinary batch undo removes formatted cards and preserves old content and later unrelated writing', async () => {
    const f = fixture(); await f.runner.reformatLatest(); const before = f.editor.text;
    f.editor.text += '\n作者另外补充的一段话。';
    f.documents.observeEditor(f.file as never, before, f.editor.text, [{ from: before.length, to: before.length, insert: '\n作者另外补充的一段话。' }]);
    expect(f.runner.canUndo(f.value.receipt.id)).toBe(true); await f.runner.undo(f.value.receipt.id);
    expect(f.editor.text).toContain(OLD); expect(f.editor.text).toContain('作者另外补充的一段话。');
    expect(f.editor.text).not.toContain('**推荐项目**'); expect(f.editor.text).not.toContain('**候选项目**'); expect(f.editor.text).toContain('推荐：0｜备选：0');
  });
  it('diagnostics do not save, back up or write; a repeated format is a no-op', async () => {
    const f = fixture(); const info = await f.runner.reformatLatestDiagnostics();
    expect(info.canReformat).toBe(true); expect(info.candidates).toBe(2); expect(f.snapshots).toHaveLength(0); expect(f.adapter.mkdir).not.toHaveBeenCalled(); expect(f.editor.transactions).toBe(0);
    await f.runner.reformatLatest(); const backups = f.adapter.mkdir.mock.calls.length;
    const second = await f.runner.reformatLatest(); expect(second.status).toBe('unchanged'); expect(f.editor.transactions).toBe(1); expect(f.adapter.mkdir.mock.calls).toHaveLength(backups);
  });
  it('backup readback failure and prepared-save failure both prevent writing', async () => {
    const badBackup = fixture({ backupReadFail: true }); const original = structuredClone(badBackup.value.receipt);
    await expect(badBackup.runner.reformatLatest()).rejects.toThrow('备份回读'); expect(badBackup.editor.transactions).toBe(0); expect(badBackup.runner.data.receipts[0]).toEqual(original);
    const badSave = fixture({ save: call => { if (call === 2) throw new Error('准备保存失败'); } }); const snapshot = structuredClone(badSave.value.receipt);
    await expect(badSave.runner.reformatLatest()).rejects.toThrow('准备保存失败'); expect(badSave.editor.text).toBe(badSave.value.before); expect(badSave.runner.data.receipts[0]).toEqual(snapshot);
  });
  it('preserves a real write and reports records needing inspection after final save failure', async () => {
    const f = fixture({ save: call => { if (call >= 3) throw new Error('最终保存失败'); } });
    const outcome = await f.runner.reformatLatest(); expect(outcome.status).toBe('needs-check'); expect(outcome.changed).toBe(true); expect(outcome.message).toContain('已整理');
    expect(f.editor.transactions).toBe(1); expect(f.runner.data.receipts[0]!.state).toBe('needs-check');
    await expect(f.runner.reformatLatest()).rejects.toThrow(); expect(f.editor.transactions).toBe(1);
  });
  it('confirms formatting only after a transient duplicate editor catches up exactly', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), duplicate = new TestEditor(f.value.before);
      f.leaves.push({ view: new MarkdownView(f.file, duplicate) });
      let committed!: () => void;
      const written = new Promise<void>(resolve => { committed = resolve; }), apply = f.editor.transaction.bind(f.editor);
      vi.spyOn(f.editor, 'transaction').mockImplementation(spec => {
        apply(spec); setTimeout(() => { duplicate.text = f.editor.text; }, 100); committed();
      });
      const job = f.runner.reformatLatest(); await written;
      expect(f.runner.data.receipts[0]!.state).toBe('prepared');
      await vi.advanceTimersByTimeAsync(99); expect(f.runner.data.receipts[0]!.state).toBe('prepared');
      await vi.advanceTimersByTimeAsync(1); const outcome = await job;
      expect(outcome.status).toBe('formatted'); expect(f.runner.data.receipts[0]!.state).toBe('applied');
      expect(f.runner.data.receipts[0]!.afterHash).toBe(hashText(f.editor.text)); expect(duplicate.text).toBe(f.editor.text);
      expect(f.editor.transactions).toBe(1); expect(f.adapter.mkdir).toHaveBeenCalledOnce(); expect(f.runner.canUndo(f.value.receipt.id)).toBe(true);
      expect(f.runner.dependencies.pipeline).not.toHaveBeenCalled(); expect(f.host.key).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('leaves formatting needing inspection after a permanent pane conflict without resubmitting', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), duplicate = new TestEditor(f.value.before), startedAt = Date.now();
      f.leaves.push({ view: new MarkdownView(f.file, duplicate) });
      const job = f.runner.reformatLatest(); await vi.runAllTimersAsync(); const outcome = await job;
      expect(Date.now() - startedAt).toBe(1000); expect(outcome.status).toBe('needs-check'); expect(outcome.changed).toBe(true);
      expect(f.runner.data.receipts[0]!.state).toBe('needs-check'); expect(f.editor.transactions).toBe(1);
      expect(duplicate.text).toBe(f.value.before); expect(f.editor.text).toContain('选题日报'); expect(f.editor.text).toContain(OLD);
      expect(f.adapter.mkdir).toHaveBeenCalledOnce(); expect(f.runner.canUndo(f.value.receipt.id)).toBe(false);
      expect(f.runner.dependencies.pipeline).not.toHaveBeenCalled(); expect(f.host.editing.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('does not treat a real edit after formatting as a delayed synchronization echo', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), duplicate = new TestEditor(f.value.before), startedAt = Date.now();
      f.leaves.push({ view: new MarkdownView(f.file, duplicate) });
      const apply = f.editor.transaction.bind(f.editor);
      vi.spyOn(f.editor, 'transaction').mockImplementation(spec => {
        apply(spec);
        setTimeout(() => { f.editor.text += '\n作者整理之后写入的内容。'; duplicate.text = f.editor.text; }, 100);
      });
      const job = f.runner.reformatLatest(); await vi.runAllTimersAsync(); const outcome = await job;
      expect(Date.now() - startedAt).toBe(100); expect(outcome.status).toBe('needs-check'); expect(outcome.changed).toBe(true);
      expect(f.runner.data.receipts[0]!.state).toBe('needs-check'); expect(f.editor.text).toContain('作者整理之后写入的内容。');
      expect(f.editor.text).toContain(OLD); expect(f.editor.transactions).toBe(1); expect(vi.getTimerCount()).toBe(0);
      expect(f.runner.dependencies.pipeline).not.toHaveBeenCalled(); expect(f.host.key).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('rejects a changed version during preparation and keeps the author edit', async () => {
    let f!: ReturnType<typeof fixture>;
    f = fixture({ save: call => { if (call === 2) { const before = f.editor.text; f.editor.text += '\n作者在准备过程中写入。'; f.documents.observeEditor(f.file as never, before, f.editor.text, [{ from: before.length, to: before.length, insert: '\n作者在准备过程中写入。' }]); } } });
    await expect(f.runner.reformatLatest()).rejects.toThrow(); expect(f.editor.transactions).toBe(0); expect(f.editor.text).toContain('作者在准备过程中写入。');
    expect(f.runner.data.receipts[0]!.state).toBe('needs-check');
  });
  it('retains CRLF source-buffer refusal and restores the original receipt', async () => {
    const f = fixture({ newline: '\r\n' }), snapshot = structuredClone(f.value.receipt);
    await expect(f.runner.reformatLatest()).rejects.toThrow('CRLF'); expect(f.editor.transactions).toBe(0); expect(f.runner.data.receipts[0]).toEqual(snapshot);
  });
  it('does not fall back to an older receipt when the latest completed batch is invalid', async () => {
    const f = fixture(); f.runner.data.runs.push({ ...structuredClone(f.value.run), id: 'later', receiptId: 'missing' });
    await expect(f.runner.reformatLatest()).rejects.toThrow('最新完成批次'); expect(f.editor.transactions).toBe(0);
  });
});
