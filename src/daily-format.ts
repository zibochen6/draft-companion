import { bodyStart, hashText } from './editing';
import { applyDailyChanges, DAILY_AREA_END, DAILY_AREA_START, renderDailyTopicEntry } from './daily-notes';
import type { DailyTopicEntry, DailyTopicRun, DailyTopicUpdate, TopicBatchReceipt } from './daily-types';
import type { TextChange } from './review-types';

export interface DailyTopicReformatResult {
  status: 'formatted' | 'unchanged' | 'needs-check'; changed: boolean; message: string;
  documentId: string; path: string; receiptId: string; candidates: number; selected: number; backup?: string;
}
export interface DailyTopicReformatDiagnostics {
  canReformat: boolean; reason?: string; path?: string; receiptId?: string;
  candidates?: number; selected?: number; changeRanges?: number;
}

function safeBoundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
  const a = text.charCodeAt(offset - 1), b = text.charCodeAt(offset);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) && !(a === 13 && b === 10);
}

function only(text: string, marker: string): number {
  const at = text.indexOf(marker);
  if (at < 0 || text.indexOf(marker, at + marker.length) >= 0
    || (at > 0 && text[at - 1] !== '\n') || !['\r', '\n', undefined].includes(text[at + marker.length]))
    throw new Error('本次选题管理标记缺失、重复或位置异常，不能安全整理。');
  return at;
}

/** Reformat only a proven, contiguous batch. Never locate an edited card again. */
export function planDailyTopicReformat(before: string, run: DailyTopicRun, receipt: TopicBatchReceipt): DailyTopicUpdate {
  const protectedStart = bodyStart(before);
  if (run.status !== 'completed' || receipt.state !== 'applied' || run.receiptId !== receipt.id
    || run.id !== receipt.runId || run.documentId !== receipt.documentId || run.path !== receipt.path || run.date !== receipt.date
    || receipt.afterHash !== hashText(before)) throw new Error('本次选题回执或文稿版本无法确认，不能安全整理。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(run.date) || !receipt.blocks.length || receipt.blocks.length > 10
    || !run.entries || run.entries.length !== receipt.blocks.length || run.cards.length !== receipt.blocks.length)
    throw new Error('本次选题与保存的来源记录不完整，不能安全整理。');
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const areaFrom = only(before, DAILY_AREA_START), areaTo = only(before, DAILY_AREA_END);
  const dayOpen = `<!-- draft-companion:day:${run.date}:start -->`, dayClose = `<!-- draft-companion:day:${run.date}:end -->`;
  const dayFrom = only(before, dayOpen), dayTo = only(before, dayClose);
  if (areaFrom < protectedStart || dayFrom <= areaFrom || dayTo <= dayFrom || dayTo >= areaTo)
    throw new Error('本次选题不在受保护正文之后的对应日报中，不能安全整理。');
  const entries = new Map(run.entries.map(entry => [entry.sourceId, entry]));
  const cards = new Map(run.cards.map(card => [card.sourceId, card]));
  const ids = new Set<string>(), canonicalIds = new Set<string>(), sourceIds = new Set<string>();
  if (entries.size !== run.entries.length || cards.size !== run.cards.length) throw new Error('本次选题来源引用重复，不能安全整理。');
  const blocks = [...receipt.blocks].sort((a, b) => a.anchor.from - b.anchor.from);
  const rows = blocks.map((block, index) => {
    const a = block.anchor, open = `<!-- draft-companion:topic:${block.id}:start -->`, close = `<!-- draft-companion:topic:${block.id}:end -->`;
    if (!/^[a-f\d]{64}$/.test(block.id) || !block.canonicalId || ids.has(block.id) || canonicalIds.has(block.canonicalId)
      || !a.valid || !safeBoundary(before, a.from) || !safeBoundary(before, a.to) || a.to <= a.from
      || a.from < protectedStart || a.from <= dayFrom || a.to > dayTo || before.slice(a.from, a.to) !== a.text
      || only(before, open) !== a.from || only(before, close) >= a.to || !a.text.startsWith(open + newline)
      || !new RegExp(`^${newline === '\r\n' ? '(?:\\r\\n)' : '\\n'}{1,2}$`).test(a.text.slice(a.text.indexOf(close) + close.length)))
      throw new Error('本次选题卡片已变化或锚点无法确认，不能安全整理。');
    if (index && blocks[index - 1]!.anchor.to !== a.from) throw new Error('本批选题卡片不相邻，不能跨过其他内容重排。');
    ids.add(block.id); canonicalIds.add(block.canonicalId);
    const sourceId = `source_${hashText(block.canonicalId).slice(0, 20)}`, entry = entries.get(sourceId), card = cards.get(sourceId);
    if (!entry || !card || sourceIds.has(sourceId)) throw new Error('本次选题含未知或重复的来源引用，不能安全整理。');
    sourceIds.add(sourceId);
    const description = card.description || card.reason.split(/(?<=[。！？])/u)[0] || card.reason;
    if (!/\p{Script=Han}/u.test(description)) throw new Error('已存材料缺少可靠的中文简述，不能自动编造整理内容。');
    const value: DailyTopicEntry = { card, item: { id: sourceId, canonicalId: block.canonicalId,
      kind: block.canonicalId.startsWith('repository:') ? 'repository' : 'news', title: entry.title,
      url: entry.url, source: entry.source, summary: description, fingerprint: 'stored-card' } };
    return { block, value, text: renderDailyTopicEntry(value, block.id, newline) };
  });
  if ([...entries.keys(), ...cards.keys()].some(id => !sourceIds.has(id))) throw new Error('本次选题保存了无法关联的来源，不能安全整理。');
  const ordered = rows.sort((a, b) => Number(b.value.card.selected) - Number(a.value.card.selected));
  const first = blocks[0]!.anchor.from, last = blocks.at(-1)!.anchor.to;
  const changes: TextChange[] = [{ from: first, to: last, insert: ordered.map(row => row.text).join('') }];
  const headingAt = dayFrom + dayOpen.length + newline.length, oldHeading = `## ${run.date} · 自动选题${newline}`;
  if (before.slice(headingAt, headingAt + oldHeading.length) === oldHeading)
    changes.push({ from: headingAt, to: headingAt + oldHeading.length, insert: `## ${run.date} · 选题日报${newline}` });
  const day = before.slice(dayFrom, dayTo);
  const tasks = day.match(/^- \[[ xX]\] /gm) ?? [], selected = tasks.filter(task => /\[[xX]\]/.test(task)).length;
  // Recognize the original machine-written pair only, directly below its heading.
  // Hand-written metadata and newer summaries are left byte-for-byte unchanged.
  const newHeading = `## ${run.date} · 选题日报${newline}`;
  const knownHeading = before.startsWith(oldHeading, headingAt) || before.startsWith(newHeading, headingAt);
  const metaAt = headingAt + (before.startsWith(oldHeading, headingAt) ? oldHeading.length : newHeading.length);
  const time = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} \\+08:00';
  const legacy = new RegExp(`^> 首次采集：${time}｜最近更新：${time}\\r?\\n> 来源：[^\\r\\n]+｜候选：(\\d+)｜优选：(\\d+)(?:\\r?\\n|$)`).exec(before.slice(metaAt, first));
  if (knownHeading && legacy && Number(legacy[1]) === tasks.length && Number(legacy[2]) === selected)
    changes.push({ from: metaAt, to: metaAt + legacy[0].length, insert: `> 推荐：${selected}｜备选：${tasks.length - selected} · 勾选表示推荐创作${newline}` });
  changes.sort((a, b) => a.from - b.from);
  const effective = changes.filter(change => before.slice(change.from, change.to) !== change.insert);
  const after = applyDailyChanges(before, effective);
  const prefixDelta = effective.filter(change => change.to <= first).reduce((sum, change) => sum + change.insert.length - (change.to - change.from), 0);
  let cursor = first + prefixDelta;
  const nextBlocks = ordered.map(row => {
    const from = cursor; cursor += row.text.length;
    return { id: row.block.id, canonicalId: row.block.canonicalId, anchor: { from, to: cursor, text: row.text, valid: true } };
  });
  if (!nextBlocks.every(block => after.slice(block.anchor.from, block.anchor.to) === block.anchor.text)) throw new Error('整理后的锚点无法核实，原文未修改。');
  return { changes: effective, after, blocks: nextBlocks, countCandidates: rows.length, countSelected: rows.filter(row => row.value.card.selected).length };
}
