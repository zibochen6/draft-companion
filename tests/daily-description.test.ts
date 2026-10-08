import { describe, expect, it } from 'vitest';
import { defaultDailyTopicData, type TopicCard } from '../src/daily-types';
import { validateDailyTopicData, validateTopicCard } from '../src/daily-validation';
import { Store } from '../src/store';

function legacyCard(): TopicCard {
  return { sourceId: 'legacy-source', selected: false, reason: '具体的读者问题，还需作者补充演示。', gaps: ['作者需要准备操作截图。'], potential: 'needs-materials' };
}

describe('Chinese topic descriptions with existing schema 4 data', () => {
  it('loads old cards without a description and round-trips new descriptions in the same schema', () => {
    const store = new Store(null, async () => {});
    const data = defaultDailyTopicData();
    data.runs.push({ id: 'legacy-run', date: '2026-10-08', origin: 'manual', status: 'completed', stage: '已完成', startedAt: 1, completedAt: 2, sources: [], cards: [legacyCard()] });
    store.data.dailyTopics = data;
    const oldSnapshot = JSON.stringify(store.data);
    const restored = new Store(JSON.parse(oldSnapshot), async () => {});
    expect(restored.data.version).toBe(4);
    expect(restored.data.dailyTopics?.runs[0]?.cards[0]).toEqual(legacyCard());
    expect(JSON.stringify(store.data)).toBe(oldSnapshot);
    const description = 'Agent 工具将零散 Markdown 笔记整理为可复用的知识工作流。';
    restored.data.dailyTopics!.runs[0]!.cards[0]!.description = description;
    expect(() => validateDailyTopicData(restored.data.dailyTopics)).not.toThrow();
    const newSnapshot = JSON.stringify(restored.data);
    expect(new Store(JSON.parse(newSnapshot), async () => {}).data.dailyTopics?.runs[0]?.cards[0]?.description).toBe(description);
    expect(restored.data.version).toBe(4);
  });

  it.each([undefined, null, 1, '', '  ', 'An English repository description.', '中文\n简介', '中文\r简介', '中文\t简介', '中文\u2028简介', '中文\u2029简介', '中文\u0000简介', '中'.repeat(181)])('rejects a present invalid stored description: %s', description => {
    expect(() => validateTopicCard({ ...legacyCard(), description })).toThrow(/中文简介/);
  });

  it('accepts Chinese descriptions with English proper names and still rejects unknown fields', () => {
    expect(() => validateTopicCard({ ...legacyCard(), description: '帮助作者整理 Markdown 笔记的 Agent 工具。' })).not.toThrow();
    expect(() => validateTopicCard({ ...legacyCard(), description: '中'.repeat(180) })).not.toThrow();
    expect(() => validateTopicCard({ ...legacyCard(), description: '中文简介。', writeFile: '伪命令' })).toThrow(/未知字段/);
  });
});
