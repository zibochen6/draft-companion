import type { App, WorkspaceLeaf } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DATA_VERSION, Store } from '../src/store';
import { Documents } from '../src/documents';
import { applyDailyChanges, DAILY_AREA_END, DAILY_AREA_START, planDailyTopicRecount, planDailyTopicUpdate } from '../src/daily-notes';
import { canUndoTopicBatch, finishTopicBatchUndo, makeTopicBatchReceipt, mapTopicReceipts, planTopicBatchUndo, reconcileTopicReceipts } from '../src/daily-receipts';
import { validateDailyTopicData, validateTopicCard } from '../src/daily-validation';
import { defaultDailyTopicData, type DailyTopicEntry, type SourceStatus } from '../src/daily-types';
import { hashText } from '../src/editing';
import { MarkdownView, TestEditor, TFile } from './obsidian-mock';

const AT = Date.parse('2026-10-08T01:00:00Z');
const DOC = { id: 'doc', path: 'Projects/选题库.md', ctime: 1 };
const SOURCES: SourceStatus[] = [{ name: 'AIHOT', status: 'success', message: '成功', at: AT }, { name: 'Git Stars', status: 'failed', message: '403', at: AT }];
function entry(id = 'repo-1', selected = true): DailyTopicEntry {
  return { item: { id, canonicalId: `github:owner/${id}`, kind: 'repository', title: id, summary: '解决知识管理问题 😀', url: `https://github.com/owner/${id}`, source: 'GitHub 补充', fingerprint: `facts-${id}` },
    card: { sourceId: id, selected, reason: '具体而可演示的读者问题', gaps: ['需补自己的操作结果'], potential: selected ? 'high' : 'needs-materials',
      ...(selected ? { angle: '从实际流程切入', primaryTitle: '把资料整理变成一个动作', alternativeTitles: ['资料太多时从哪开始', '给收藏夹一个出口', '少一步复制的工作流', '知识管理先解决这个问题'], opening: '收藏完资料，下一步该做什么？', outline: ['明确问题', '演示步骤', '说明限制'] } : {}) } };
}
const ORIGINAL = '---\ntitle: 选题库\n---\n# 选题库\n\n> 原来来源，保留\n\n- [x] **原选题** — 旧内容 [链接](https://example.test/a)\n';

describe('daily topic note transactions', () => {
  it('puts a managed date after H1 and preserves all original characters outside insertion', () => {
    const plan = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry(), entry('repo-2', false)], 'run-1');
    expect(plan.changes).toHaveLength(1);
    const change = plan.changes[0]!;
    expect(plan.after).toBe(ORIGINAL.slice(0, change.from) + change.insert + ORIGINAL.slice(change.to));
    expect(change.from).toBe(ORIGINAL.indexOf('# 选题库') + '# 选题库\n'.length);
    expect(plan.after).toContain('## 2026-10-08 · 选题日报');
    expect(plan.after).toContain('推荐：1｜备选：1');
    expect(plan.after).not.toContain('首次采集'); expect(plan.after).not.toContain('Git Stars：失败');
    expect(plan.after).toContain('- [x] **repo\\-1**'); expect(plan.after).toContain('- [ ] **repo\\-2**');
    expect(plan.blocks).toHaveLength(2); expect(plan.countSelected).toBe(1);
    plan.blocks.forEach(block => expect(plan.after.slice(block.anchor.from, block.anchor.to)).toBe(block.anchor.text));
  });
  it('puts dates newest first, including an explicit historical run', () => {
    const first = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    const newer = planDailyTopicUpdate(first.after, '2026-10-09', AT, SOURCES, [entry('repo-2')], 'run-2');
    const older = planDailyTopicUpdate(newer.after, '2026-10-07', AT, SOURCES, [entry('repo-3')], 'run-3');
    expect(older.after.indexOf('## 2026-10-09')).toBeLessThan(older.after.indexOf('## 2026-10-08'));
    expect(older.after.indexOf('## 2026-10-08')).toBeLessThan(older.after.indexOf('## 2026-10-07'));
    expect(older.after.endsWith(ORIGINAL.slice(first.changes[0]!.from))).toBe(true);
  });
  it('same-day updates only metadata and appends, keeping edited titles and checkbox states', () => {
    const first = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    const edited = first.after.replace('- [x] **repo\\-1**', '- [ ] **我的项目名**').replace('把资料整理变成一个动作', '我自己的标题');
    const next = planDailyTopicUpdate(edited, '2026-10-08', AT + 60000, SOURCES, [entry('repo-2')], 'run-2');
    expect(next.changes).toHaveLength(2); expect(next.blocks).toHaveLength(1);
    expect(next.after).toContain('- [ ] **我的项目名**'); expect(next.after).toContain('我自己的标题');
    expect(next.after).toContain('推荐：1｜备选：1');
    expect(next.after.match(/## 2026-10-08/g)).toHaveLength(1);
  });
  it('preserves replaced user metadata while appending new cards', () => {
    const first = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    const edited = first.after.replace(/^> 推荐：.*$/m, '> 我的手写说明');
    const next = planDailyTopicUpdate(edited, '2026-10-08', AT + 60000, SOURCES, [entry('repo-2')], 'run-2');
    expect(next.changes).toHaveLength(1); expect(next.after).toContain('> 我的手写说明');
  });
  it('puts usable titles and Chinese descriptions first, with writing drafts folded and diagnostics absent', () => {
    const selected = entry(), candidate = entry('backup', false);
    selected.item.summary = 'A VERY LONG ENGLISH PROJECT SELF DESCRIPTION';
    selected.card.description = '把资料整理变成可复用的中文工作流。';
    const plan = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [candidate, selected], 'run-readability');
    expect(plan.after.indexOf('### 把资料整理变成一个动作')).toBeLessThan(plan.after.indexOf('- [x]'));
    expect(plan.after.indexOf('### 把资料整理变成一个动作')).toBeLessThan(plan.after.indexOf('- [ ] **backup**'));
    expect(plan.after).toContain('把资料整理变成可复用的中文工作流');
    expect(plan.after).toContain('> [!example]- 写作预设');
    expect(plan.after).toContain('> [!warning]- 动笔前补充');
    // Obsidian auto-renumbers consecutive quoted ordered lists on transaction.
    // Bullets keep the exact generated text stable for receipts and safe undo.
    expect(plan.after).toContain('> - 明确问题');
    expect(plan.after).toContain('> - 资料太多时从哪开始');
    expect(plan.after).not.toMatch(/^> \d+\. /m);
    expect(plan.after).not.toContain(selected.item.summary); expect(plan.after).not.toContain('GitHub 补充');
    expect(plan.after).not.toContain('首次采集'); expect(plan.after).not.toContain('失败');
    expect(plan.blocks[0]!.canonicalId).toBe(selected.item.canonicalId);
  });
  it('keeps new preferred cards before older backup cards without rewriting their text', () => {
    const initial = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry('backup', false)], 'run-before');
    const originalBlock = initial.blocks[0]!.anchor.text;
    const next = planDailyTopicUpdate(initial.after, '2026-10-08', AT + 60000, SOURCES, [entry()], 'run-after');
    expect(next.after.indexOf('### 把资料整理变成一个动作')).toBeLessThan(next.after.indexOf('- [ ] **backup**'));
    expect(next.after).toContain(originalBlock); expect(next.after.endsWith(ORIGINAL.slice(initial.changes[0]!.from))).toBe(true);
  });
  it('compacts legacy generated status lines but preserves manually replaced status prose', () => {
    const initial = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-before');
    const legacy = initial.after.replace(/^> 推荐：.*$/m, '> 首次采集：2026-10-08 09:00:00 +08:00｜最近更新：2026-10-08 09:00:00 +08:00\n> 来源：AIHOT：成功；Git Stars：失败｜候选：1｜优选：1');
    const next = planDailyTopicUpdate(legacy, '2026-10-08', AT + 60000, SOURCES, [], 'run-after');
    expect(next.after).toContain('推荐：1｜备选：0'); expect(next.after).not.toContain('首次采集');
    expect(next.after).toContain(initial.blocks[0]!.anchor.text);
  });
  it('identical source facts do not add a second card, but new facts can be a new entry', () => {
    const first = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    const same = planDailyTopicUpdate(first.after, '2026-10-08', AT + 60000, SOURCES, [entry()], 'run-2');
    expect(same.blocks).toHaveLength(0); expect(same.after.match(/^- \[x\]/gm)).toHaveLength(2);
    const newFacts = entry(); newFacts.item.fingerprint = 'new-release';
    expect(planDailyTopicUpdate(first.after, '2026-10-09', AT, SOURCES, [newFacts], 'run-3').blocks).toHaveLength(1);
  });
  it('does not touch an unchanged day or create an empty day without new candidates', () => {
    expect(planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [], 'run-1').after).toBe(ORIGINAL);
    const first = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    const refresh = planDailyTopicUpdate(first.after, '2026-10-08', AT + 60000, SOURCES, [], 'run-2');
    expect(refresh.changes).toHaveLength(0); expect(refresh.blocks).toHaveLength(0);
    expect(refresh.after).toBe(first.after);
    expect(planDailyTopicUpdate(first.after, '2026-10-09', AT, SOURCES, [], 'run-3').changes).toEqual([]);
  });
  it('preserves CRLF, Markdown links and emoji in untouched original text', () => {
    const original = ORIGINAL.replace(/\n/g, '\r\n');
    const plan = planDailyTopicUpdate(original, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    expect(plan.after.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(plan.after.endsWith(original.slice(plan.changes[0]!.from))).toBe(true);
  });
  it('does not mistake a fenced H1 for the document title', () => {
    const original = '```md\n# 示例标题\n```\n# 真标题\n正文';
    const plan = planDailyTopicUpdate(original, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    expect(plan.changes[0]!.from).toBe(original.indexOf('正文'));
    const setext = '真标题\n=====\n正文';
    expect(planDailyTopicUpdate(setext, '2026-10-08', AT, SOURCES, [entry()], 'run-1').changes[0]!.from).toBe(setext.indexOf('正文'));
  });
  it('escapes content and refuses dangerous links or malformed management markers', () => {
    const topic = entry(); topic.item.title = '恶意 <img>\n- [x] 假条目'; topic.card.opening = '![](https://tracking.test/img)';
    const plan = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [topic], 'run-1');
    expect(plan.after).not.toContain('<img>'); expect(plan.after.match(/^- \[x\]/gm)).toHaveLength(2);
    topic.item.url = 'javascript:alert(1)';
    expect(() => planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [topic], 'run-1')).toThrow('链接');
    expect(() => planDailyTopicUpdate(ORIGINAL + '\n' + DAILY_AREA_START, '2026-10-08', AT, SOURCES, [entry()], 'run-1')).toThrow('管理区域');
    expect(() => planDailyTopicUpdate(ORIGINAL + '\n' + DAILY_AREA_START + '\n' + DAILY_AREA_START + '\n' + DAILY_AREA_END, '2026-10-08', AT, SOURCES, [entry()], 'run-1')).toThrow('重复');
    expect(() => planDailyTopicUpdate('---\n未闭合', '2026-10-08', AT, SOURCES, [entry()], 'run-1')).toThrow('frontmatter');
  });
});

describe('daily local receipts and recovery', () => {
  function fixture() {
    const plan = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry(), entry('repo-2', false)], 'run-1');
    const receipt = makeTopicBatchReceipt(DOC, 'run-1', ORIGINAL, plan, '2026-10-08', AT);
    return { plan, receipt };
  }
  it('prepares before a write, recovers an exact committed after-state and refuses an uncommitted one', () => {
    const { plan, receipt } = fixture(); expect(receipt.state).toBe('prepared');
    mapTopicReceipts([receipt], ORIGINAL, plan.after, plan.changes, 'apply'); expect(receipt.state).toBe('prepared');
    reconcileTopicReceipts([receipt], DOC, plan.after); expect(receipt.state).toBe('applied');
    const another = fixture().receipt; reconcileTopicReceipts([another], DOC, ORIGINAL); expect(another.state).toBe('needs-check');
  });
  it('maps unrelated prefix/suffix edits and undoes only inserted cards', () => {
    const { plan, receipt } = fixture(); receipt.state = 'applied';
    const changes = [{ from: 0, to: 0, insert: '说明\n' }, { from: plan.after.length, to: plan.after.length, insert: '后续手写\n' }];
    const edited = applyDailyChanges(plan.after, changes); mapTopicReceipts([receipt], plan.after, edited, changes);
    expect(canUndoTopicBatch(receipt, edited)).toBe(true);
    const undo = planTopicBatchUndo(receipt, edited), after = applyDailyChanges(edited, undo);
    expect(after).toContain('说明\n'); expect(after).toContain('后续手写\n'); expect(after).toContain('**原选题**');
    expect(after).not.toContain('repo\\-1'); expect(after).toContain('## 2026-10-08');
    finishTopicBatchUndo(receipt, edited, undo); expect(receipt.state).toBe('undone');
    const recounted = applyDailyChanges(after, planDailyTopicRecount(after, '2026-10-08')); expect(recounted).toContain('推荐：0｜备选：0');
  });
  it('excludes newly inserted text exactly at the card boundaries', () => {
    const { plan, receipt } = fixture(); receipt.state = 'applied';
    const first = receipt.blocks[0]!.anchor;
    const changes = [{ from: first.from, to: first.from, insert: '用户前注\n' }, { from: first.to, to: first.to, insert: '用户后注\n' }];
    const edited = applyDailyChanges(plan.after, changes); mapTopicReceipts([receipt], plan.after, edited, changes);
    expect(canUndoTopicBatch(receipt, edited)).toBe(true);
    const after = applyDailyChanges(edited, planTopicBatchUndo(receipt, edited)); expect(after).toContain('用户前注'); expect(after).toContain('用户后注');
  });
  it('invalidates overlap, unknown version chains and mismatched identities', () => {
    const { plan, receipt } = fixture(); receipt.state = 'applied';
    const at = receipt.blocks[0]!.anchor.from + 10, changes = [{ from: at, to: at + 1, insert: '改' }];
    mapTopicReceipts([receipt], plan.after, applyDailyChanges(plan.after, changes), changes); expect(receipt.state).toBe('needs-check');
    const other = fixture(); other.receipt.state = 'applied'; mapTopicReceipts([other.receipt], '未知外部正文', '未知外部正文新', [{ from: 6, to: 6, insert: '新' }]); expect(other.receipt.state).toBe('needs-check');
    const changedPath = fixture(); changedPath.receipt.state = 'applied'; reconcileTopicReceipts([changedPath.receipt], { ...DOC, path: '新选题库.md' }, changedPath.plan.after); expect(changedPath.receipt.state).toBe('needs-check');
    expect(() => planTopicBatchUndo(receipt, plan.after)).toThrow('无法安全撤回');
  });
  it('reconciles provable native undo/redo without replaying an operation', () => {
    const { plan, receipt } = fixture(); receipt.state = 'applied';
    const insertion = plan.changes[0]!, inverse = [{ from: insertion.from, to: insertion.from + insertion.insert.length, insert: '' }];
    mapTopicReceipts([receipt], plan.after, ORIGINAL, inverse, 'undo'); expect(receipt.state).toBe('undone');
    mapTopicReceipts([receipt], ORIGINAL, plan.after, plan.changes, 'redo'); expect(receipt.state).toBe('applied');
    expect(canUndoTopicBatch(receipt, plan.after)).toBe(true);
  });
  it('native undo of a plugin batch undo restores the receipt, and native redo removes it again', () => {
    const { plan, receipt } = fixture(); receipt.state = 'applied';
    const removals = planTopicBatchUndo(receipt, plan.after), removed = applyDailyChanges(plan.after, removals);
    const first = receipt.blocks[0]!.anchor.from, last = receipt.blocks.at(-1)!.anchor.to, originalBlocks = plan.after.slice(first, last);
    finishTopicBatchUndo(receipt, plan.after, removals); expect(receipt.state).toBe('undone');
    const restore = [{ from: first, to: first, insert: originalBlocks }];
    expect(applyDailyChanges(removed, restore)).toBe(plan.after);
    mapTopicReceipts([receipt], removed, plan.after, restore, 'undo');
    expect(receipt.state).toBe('applied'); expect(canUndoTopicBatch(receipt, plan.after)).toBe(true);
    mapTopicReceipts([receipt], plan.after, removed, [{ from: first, to: last, insert: '' }], 'redo');
    expect(receipt.state).toBe('undone');
  });
  it('does not restore an undone receipt by moving identical card text elsewhere', () => {
    const { plan, receipt } = fixture(); receipt.state = 'applied';
    const removals = planTopicBatchUndo(receipt, plan.after), removed = applyDailyChanges(plan.after, removals);
    const blocks = receipt.blocks.map(block => block.anchor.text).join(''); finishTopicBatchUndo(receipt, plan.after, removals);
    const unrelated = [{ from: removed.length, to: removed.length, insert: blocks }], after = applyDailyChanges(removed, unrelated);
    mapTopicReceipts([receipt], removed, after, unrelated, 'undo'); expect(receipt.state).toBe('undone'); expect(canUndoTopicBatch(receipt, after)).toBe(false);
  });
  it('keeps later independent batches when undoing an earlier batch', () => {
    const initial = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    const first = makeTopicBatchReceipt(DOC, 'run-1', ORIGINAL, initial, '2026-10-08', AT); first.state = 'applied';
    const next = planDailyTopicUpdate(initial.after, '2026-10-08', AT + 60000, SOURCES, [entry('repo-2')], 'run-2');
    const second = makeTopicBatchReceipt(DOC, 'run-2', initial.after, next, '2026-10-08', AT + 60000);
    mapTopicReceipts([first, second], initial.after, next.after, next.changes, 'apply'); second.state = 'applied';
    const undo = planTopicBatchUndo(first, next.after), after = applyDailyChanges(next.after, undo);
    mapTopicReceipts([second], next.after, after, undo, 'apply'); finishTopicBatchUndo(first, next.after, undo);
    expect(after).toContain('repo\\-2'); expect(after).not.toContain('repo\\-1'); expect(canUndoTopicBatch(second, after)).toBe(true);
  });
});

describe('schema 4 preservation and validation', () => {
  it('strictly validates schema 3 before backup and retains all prior data', async () => {
    const old = new Store(null, async () => {}).data; old.version = 3; delete old.dailyTopics;
    old.preferences = '用户偏好'; old.roles[0]!.systemPrompt = '用户规则'; old.topicLibrary = DOC;
    const before = JSON.stringify(old), backup = vi.fn(async () => {});
    const migrated = await Store.migrate(old, backup) as typeof old;
    expect(backup).toHaveBeenCalledOnce(); expect(JSON.stringify(old)).toBe(before); expect(migrated.version).toBe(DATA_VERSION);
    expect(migrated.preferences).toBe('用户偏好'); expect(migrated.roles[0]!.systemPrompt).toBe('用户规则'); expect(migrated.topicLibrary).toEqual(DOC);
    expect(migrated.dailyTopics?.settings.time).toBe('09:00');
    await expect(Store.migrate({ ...old, dailyTopics: defaultDailyTopicData() }, backup)).rejects.toThrow('未知字段');
    await expect(Store.migrate(old, async () => { throw new Error('备份失败'); })).rejects.toThrow('备份失败');
  });
  it('interrupts incomplete jobs and retains prepared receipts for exact text recovery', () => {
    const store = new Store(null, async () => {}), data = store.data.dailyTopics!;
    const plan = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    const receipt = makeTopicBatchReceipt(DOC, 'run-1', ORIGINAL, plan, '2026-10-08', AT);
    data.runs.push({ id: 'run-1', date: '2026-10-08', origin: 'manual', status: 'committing', stage: '准备写入', documentId: DOC.id, path: DOC.path, startedAt: AT, sources: SOURCES, cards: [entry().card], receiptId: receipt.id }); data.receipts.push(receipt);
    const restored = new Store(store.data, async () => {}).data.dailyTopics!;
    expect(restored.runs[0]!.status).toBe('interrupted'); expect(restored.receipts[0]!.state).toBe('prepared'); expect(data.runs[0]!.status).toBe('committing');
  });
  it('rejects malformed schedules, incomplete selected cards, linked receipts and unknown fields', () => {
    const data = defaultDailyTopicData(); expect(() => validateDailyTopicData(data)).not.toThrow();
    data.settings.time = '25:00'; expect(() => validateDailyTopicData(data)).toThrow('定时时间');
    const card = entry().card; card.alternativeTitles = ['一个']; expect(() => validateTopicCard(card)).toThrow('四个');
    const bad = { ...defaultDailyTopicData(), apiKey: 'forbidden' }; expect(() => validateDailyTopicData(bad)).toThrow('未知字段');
    const store = new Store(null, async () => {}); const receipt = makeTopicBatchReceipt(DOC, 'missing-run', ORIGINAL, planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'missing-run'), '2026-10-08', AT);
    store.data.dailyTopics!.receipts.push(receipt); expect(() => new Store(store.data, async () => {})).toThrow('运行关联');
  });
});

describe('atomic multi-range document edits', () => {
  function fixture(text = ORIGINAL) {
    const file = new TFile(DOC.path), editor = new TestEditor(text), view = new MarkdownView(file, editor), leaf = { view }, leaves = [leaf]; let disk = text;
    const app = { workspace: { getLeavesOfType: () => leaves, getMostRecentLeaf: () => leaf }, vault: {
      getAbstractFileByPath: (path: string) => path === file.path ? file : null, read: async () => disk,
      process: vi.fn(async (_file: TFile, transform: (content: string) => string) => { disk = transform(disk); }),
    } } as unknown as App;
    const documents = new Documents(app, {}); documents.focus(leaf as unknown as WorkspaceLeaf);
    return { app, documents, file, editor, view, leaves, document: documents.current()!, disk: () => disk, setDisk: (next: string) => { disk = next; } };
  }
  it('commits metadata and card insertion as a single editor transaction from unsaved text', async () => {
    const f = fixture(), initial = planDailyTopicUpdate(ORIGINAL, '2026-10-08', AT, SOURCES, [entry()], 'run-1'); f.editor.text = initial.after;
    const plan = planDailyTopicUpdate(initial.after, '2026-10-08', AT + 60000, SOURCES, [entry('repo-2')], 'run-2'); const event = vi.fn(); f.documents.onChange(event);
    await f.documents.applyChangesValidated(f.document, initial.after, plan.changes, current => { expect(current).toBe(initial.after); });
    expect(f.editor.text).toBe(plan.after); expect(f.editor.transactions).toBe(1); expect(event).toHaveBeenCalledOnce(); expect(event.mock.calls[0]![0].changes).toHaveLength(2);
  });
  it('uses a single synchronous Vault.process compare for CRLF with no source buffer', async () => {
    const original = ORIGINAL.replace(/\n/g, '\r\n'), f = fixture(original); f.view.mode = 'preview';
    const plan = planDailyTopicUpdate(original, '2026-10-08', AT, SOURCES, [entry()], 'run-1');
    await f.documents.applyChangesValidated(f.document, original, plan.changes); expect(f.disk()).toBe(plan.after); expect(f.app.vault.process).toHaveBeenCalledOnce();
    expect(f.disk().replace(/\r\n/g, '').includes('\n')).toBe(false); expect(f.editor.transactions).toBe(0);
  });
  it('blocks buffer forks, stale versions, overlapping ranges, frontmatter and unsafe boundaries', async () => {
    const f = fixture(), from = ORIGINAL.indexOf('旧内容');
    await expect(f.documents.applyChangesValidated(f.document, ORIGINAL, [{ from: 0, to: 0, insert: '错' }])).rejects.toThrow('frontmatter');
    await expect(f.documents.applyChangesValidated(f.document, ORIGINAL, [{ from, to: from + 2, insert: '甲' }, { from: from + 1, to: from + 3, insert: '乙' }])).rejects.toThrow('重叠');
    f.editor.text += '新'; await expect(f.documents.applyChangesValidated(f.document, ORIGINAL, [{ from, to: from + 2, insert: '改' }])).rejects.toThrow('已变化'); f.editor.text = ORIGINAL;
    f.leaves.push({ view: new MarkdownView(f.file, new TestEditor(ORIGINAL + '分叉')) }); await expect(f.documents.applyChangesValidated(f.document, ORIGINAL, [{ from, to: from + 2, insert: '改' }])).rejects.toThrow('缓冲不一致');
    expect(f.editor.transactions).toBe(0);
    const emoji = fixture('正文😀结束'); await expect(emoji.documents.applyChangesValidated(emoji.document, emoji.editor.text, [{ from: 3, to: 3, insert: '错' }])).rejects.toThrow('范围无效');
  });
  it('refuses source-buffer CRLF normalization and respects final synchronous cancellation', async () => {
    const crlf = fixture(ORIGINAL.replace(/\n/g, '\r\n')); await expect(crlf.documents.applyChangesValidated(crlf.document, crlf.editor.text, [{ from: crlf.editor.text.length, to: crlf.editor.text.length, insert: '新' }])).rejects.toThrow('CRLF');
    const f = fixture(); await expect(f.documents.applyChangesValidated(f.document, ORIGINAL, [{ from: ORIGINAL.length, to: ORIGINAL.length, insert: '新' }], () => { throw new Error('已停止'); })).rejects.toThrow('已停止');
    expect(f.editor.transactions).toBe(0); expect(hashText(f.editor.text)).toBe(hashText(ORIGINAL));
  });
});
