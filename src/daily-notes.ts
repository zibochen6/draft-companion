import { bodyStart, hashText } from './editing';
import type { DailyTopicEntry, DailyTopicUpdate, SourceStatus, TopicBatchBlock } from './daily-types';
import type { TextChange } from './review-types';
import { validateTopicCard } from './daily-validation';

export const DAILY_AREA_START = '<!-- draft-companion:daily:start -->';
export const DAILY_AREA_END = '<!-- draft-companion:daily:end -->';
const dayStart = (date: string): string => `<!-- draft-companion:day:${date}:start -->`;
const dayEnd = (date: string): string => `<!-- draft-companion:day:${date}:end -->`;
const clean = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const markdown = (value: string): string => clean(value).replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, '\\$&');
function link(url: string): string {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('选题来源链接无效，未写入。');
  return parsed.href.replace(/[()<>]/g, char => encodeURIComponent(char));
}
function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('选题日期无效。');
}
function only(text: string, marker: string): number {
  const at = text.indexOf(marker);
  if (at >= 0 && text.indexOf(marker, at + marker.length) >= 0) throw new Error('选题管理标记重复，请检查选题库；原文未覆盖。');
  if (at >= 0 && ((at > 0 && text[at - 1] !== '\n') || !['\r', '\n', undefined].includes(text[at + marker.length]))) throw new Error('选题管理标记位置异常，原文未覆盖。');
  return at;
}
function afterLine(text: string, from: number): number { const end = text.indexOf('\n', from); return end < 0 ? text.length : end + 1; }
function h1End(text: string): number {
  let offset = bodyStart(text), fence: string | undefined, previous = '';
  while (offset < text.length) {
    const end = afterLine(text, offset), line = text.slice(offset, end).replace(/\r?\n$/, '');
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (run) {
      if (!fence) fence = run[1];
      else if (run[1]![0] === fence[0] && run[1]!.length >= fence.length && !run[2]!.trim()) fence = undefined;
    } else if (!fence && (/^ {0,3}#\s+\S/.test(line) || (previous.trim() && /^ {0,3}=+\s*$/.test(line)))) return end;
    previous = fence || run ? '' : line;
    offset = end;
  }
  return bodyStart(text);
}
export function applyDailyChanges(before: string, changes: TextChange[]): string {
  let cursor = 0, result = '';
  for (const change of [...changes].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < cursor || change.to < change.from || change.to > before.length) throw new Error('选题修改范围重叠或越界。');
    result += before.slice(cursor, change.from) + change.insert; cursor = change.to;
  }
  return result + before.slice(cursor);
}
export function renderDailyTopicEntry(entry: DailyTopicEntry, id: string, newline: string): string {
  const { card, item } = entry;
  validateTopicCard(card);
  if (card.sourceId !== item.id) throw new Error('选题卡与来源关联不一致。');
  const lines = [`<!-- draft-companion:topic:${id}:start -->`];
  if (card.selected) lines.push(`### ${markdown(card.primaryTitle!)}`, '');
  lines.push(`- [${card.selected ? 'x' : ' '}] **${markdown(item.title)}** · [来源](${link(item.url)})`, '');
  const description = card.description || card.reason.split(/(?<=[。！？])/u)[0] || card.reason;
  lines.push(markdown(description), '');
  if (card.selected) {
    if (description !== card.reason) lines.push(`**推荐理由**：${markdown(card.reason)}`, '');
    lines.push(`**切入角度**：${markdown(card.angle!)}`, '', '> [!example]- 写作预设', `> **开头草稿**`, `> ${markdown(card.opening!)}`, '>', '> **写作提纲**');
    card.outline!.forEach(part => lines.push(`> - ${markdown(part)}`));
    lines.push('>', '> **四个备选标题**');
    card.alternativeTitles!.forEach(title => lines.push(`> - ${markdown(title)}`));
    lines.push('>', `> 创作潜质：${card.potential === 'high' ? '高' : '中'}`, '');
  } else if (description !== card.reason) lines.push(`**保留理由**：${markdown(card.reason)}`, '');
  if (card.gaps.length) {
    lines.push('> [!warning]- 动笔前补充');
    card.gaps.forEach(gap => lines.push(`> - ${markdown(gap)}`));
    lines.push('');
  }
  lines.push(`<!-- draft-companion:topic:${id}:end -->`, '');
  return lines.join(newline) + newline;
}
const summaryLine = (candidates: number, selected: number): string => `> 推荐：${selected}｜备选：${candidates - selected} · 勾选表示推荐创作`;
function markerCounts(text: string): { candidates: number; selected: number } {
  const tasks = text.match(/^- \[[ xX]\] /gm) ?? [];
  return { candidates: tasks.length, selected: tasks.filter(task => task.includes('[x]') || task.includes('[X]')).length };
}
/** Generated changes never replace the user's article or an existing topic card. */
export function planDailyTopicUpdate(before: string, date: string, at: number, sources: SourceStatus[], entries: DailyTopicEntry[], runId: string): DailyTopicUpdate {
  assertDate(date); bodyStart(before);
  if (!Number.isFinite(at) || at < 0) throw new Error('选题采集时间无效。');
  if (!/^[\w-]+$/.test(runId) || entries.length > 10) throw new Error('选题运行 ID 或条目数量无效。');
  if (entries.filter(entry => entry.card.selected).length > 5) throw new Error('优选条目超过容量上限。');
  if (new Set(entries.map(entry => entry.item.canonicalId)).size !== entries.length) throw new Error('同批选题来源重复。');
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const additions = entries.map(entry => ({ entry, id: hashText(`${entry.item.canonicalId}\n${entry.item.fingerprint}`) }))
    .filter(({ id }) => !before.includes(`<!-- draft-companion:topic:${id}:start -->`))
    .sort((a, b) => Number(b.entry.card.selected) - Number(a.entry.card.selected));
  const start = only(before, DAILY_AREA_START), end = only(before, DAILY_AREA_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && (end <= start || start < bodyStart(before)))) throw new Error('选题管理区域不完整，请检查标记；原文未覆盖。');
  const rendered = additions.map(({ entry, id }) => renderDailyTopicEntry(entry, id, newline)).join('');
  const candidates = additions.length, selected = additions.filter(({ entry }) => entry.card.selected).length;
  const createDay = (): string => [dayStart(date), `## ${date} · 选题日报`, summaryLine(candidates, selected), '', rendered.trimEnd(), dayEnd(date), '', ''].join(newline);
  const changes: TextChange[] = [];
  if (start < 0) {
    if (!additions.length) return { changes: [], after: before, blocks: [], countCandidates: 0, countSelected: 0 };
    const point = h1End(before);
    const prefix = point > 0 && before[point - 1] !== '\n' ? newline : '';
    changes.push({ from: point, to: point, insert: `${prefix}${newline}${DAILY_AREA_START}${newline}${createDay()}${DAILY_AREA_END}${newline}${newline}` });
  } else {
    const dayFrom = only(before, dayStart(date)), dayTo = only(before, dayEnd(date));
    if ((dayFrom >= 0) !== (dayTo >= 0) || (dayFrom >= 0 && (dayTo <= dayFrom || dayFrom <= start || dayTo >= end))) throw new Error('当天选题管理区域异常，原文未覆盖。');
    if (dayFrom < 0) {
      if (!additions.length) return { changes: [], after: before, blocks: [], countCandidates: 0, countSelected: 0 };
      // Keep dates descending even when a caller explicitly prepares an older date.
      const contentStart = afterLine(before, start);
      let point = end;
      const dates = [...before.slice(contentStart, end).matchAll(/<!-- draft-companion:day:(\d{4}-\d{2}-\d{2}):start -->/g)];
      for (const existing of dates) if (existing[1]! < date) { point = contentStart + existing.index!; break; }
      changes.push({ from: point, to: point, insert: createDay() });
    } else {
      const day = before.slice(dayFrom, dayTo);
      const metadata = /^> 推荐：\d+｜备选：\d+ · 勾选表示推荐创作(?:\r?\n|$)/m.exec(day)
        ?? /^> 首次采集：([^\r\n]+?)｜最近更新：[^\r\n]*\r?\n> 来源：[^\r\n]*(?:\r?\n|$)/m.exec(day);
      if (metadata && day.match(/^> (?:推荐：|首次采集：)/gm)?.length === 1) {
        const counts = markerCounts(day), point = dayFrom + metadata.index;
        const insert = summaryLine(counts.candidates + candidates, counts.selected + selected) + newline;
        if (insert !== metadata[0]) changes.push({ from: point, to: point + metadata[0].length, insert });
      }
      const preferred = additions.filter(row => row.entry.card.selected).map(({ entry, id }) => renderDailyTopicEntry(entry, id, newline)).join('');
      const alternatives = additions.filter(row => !row.entry.card.selected).map(({ entry, id }) => renderDailyTopicEntry(entry, id, newline)).join('');
      if (preferred) {
        const firstCard = /^<!-- draft-companion:topic:[a-f\d]{64}:start -->/m.exec(day);
        const point = firstCard ? dayFrom + firstCard.index : dayTo;
        changes.push({ from: point, to: point, insert: preferred });
      }
      if (alternatives) {
        const existingInsertion = changes.find(change => change.from === dayTo && change.to === dayTo);
        if (existingInsertion) existingInsertion.insert += alternatives;
        else changes.push({ from: dayTo, to: dayTo, insert: alternatives });
      }
    }
  }
  const after = applyDailyChanges(before, changes);
  const blocks: TopicBatchBlock[] = additions.map(({ entry, id }) => {
    const open = `<!-- draft-companion:topic:${id}:start -->`, close = `<!-- draft-companion:topic:${id}:end -->`;
    const from = only(after, open), closeAt = only(after, close);
    const lineEnd = afterLine(after, closeAt), to = after.slice(lineEnd, lineEnd + newline.length) === newline ? lineEnd + newline.length : lineEnd;
    return { id, canonicalId: entry.item.canonicalId, anchor: { from, to, text: after.slice(from, to), valid: true } };
  });
  return { changes, after, blocks, countCandidates: candidates, countSelected: selected };
}

/** Recount after an undo without replacing user-edited metadata or any card. */
export function planDailyTopicRecount(before: string, date: string): TextChange[] {
  assertDate(date);
  const from = only(before, dayStart(date)), to = only(before, dayEnd(date));
  if (from < 0 || to < from) return [];
  const day = before.slice(from, to), match = /^> 推荐：\d+｜备选：\d+ · 勾选表示推荐创作\r?$/m.exec(day)
    ?? /^> 来源：[^\r\n]*｜候选：\d+｜优选：\d+\r?$/m.exec(day);
  if (!match) return [];
  const counts = markerCounts(day), insert = match[0].startsWith('> 推荐：')
    ? summaryLine(counts.candidates, counts.selected) + (match[0].endsWith('\r') ? '\r' : '')
    : match[0].replace(/｜候选：\d+｜优选：\d+/, `｜候选：${counts.candidates}｜优选：${counts.selected}`);
  return insert === match[0] ? [] : [{ from: from + match.index, to: from + match.index + match[0].length, insert }];
}
