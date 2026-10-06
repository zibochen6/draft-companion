import { createHash } from 'node:crypto';
import type { Candidate, ParsedEdit, UndoRecord } from './types';

export function hashText(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

/** Offset after protected YAML, including its original line endings and optional BOM. */
export function bodyStart(text: string): number {
  const bom = text.startsWith('\uFEFF') ? 1 : 0;
  const first = /^(---)[\t ]*(?:\r?\n|$)/.exec(text.slice(bom));
  if (!first) return bom;
  let offset = bom + first[0].length;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(offset, end).replace(/\r?\n$/, '');
    if (/^(---|\.\.\.)[\t ]*$/.test(line)) return end;
    offset = end;
  }
  throw new Error('frontmatter 未闭合，无法确定正文边界。请先补齐 YAML 分隔线。');
}

export function parseEdit(raw: string): ParsedEdit {
  let source = raw.trim();
  const fence = /^```(?:json)?\s*\r?\n([\s\S]*)\r?\n```$/.exec(source);
  if (fence) source = fence[1] ?? '';
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('改稿格式不完整或不是有效 JSON。原文未改动，可以查看回答后重新生成。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('改稿必须返回一个完整对象。');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['explanation', 'replacement', 'notes'].includes(k)) ||
      typeof v.explanation !== 'string' || typeof v.replacement !== 'string' ||
      !Array.isArray(v.notes) || v.notes.some(n => typeof n !== 'string')) {
    throw new Error('改稿字段不兼容，需要说明、完整替换正文和待核实事项。');
  }
  if (!v.replacement.trim()) throw new Error('候选内容为空，已阻止意外清空。需要删除时请使用“删除当前范围”。');
  return { explanation: v.explanation, replacement: v.replacement, notes: v.notes as string[] };
}

function unclosedFence(text: string): boolean {
  let active: { char: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    if (!active) active = { char: run[0]!, length: run.length };
    else if (run[0] === active.char && run.length >= active.length && !match[2]?.trim()) active = undefined;
  }
  return !!active;
}

export function replaceExact(text: string, from: number, to: number, replacement: string): string {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) throw new Error('修改范围无效。');
  return text.slice(0, from) + replacement + text.slice(to);
}

export function candidateAfter(candidate: Candidate): string {
  if (candidate.baselineHash !== hashText(candidate.baseline)) throw new Error('候选基线校验失败，请重新生成。');
  const start = bodyStart(candidate.baseline);
  if (candidate.from < start) throw new Error('修改范围与受保护的 frontmatter 相交。');
  if (!candidate.deletion && !candidate.replacement.trim()) throw new Error('空候选不能用于改稿。');
  const after = replaceExact(candidate.baseline, candidate.from, candidate.to, candidate.replacement);
  if (!unclosedFence(candidate.baseline) && unclosedFence(after)) throw new Error('候选会留下未闭合的代码围栏，请重新生成完整内容。');
  return after;
}

export function undoAfter(undo: UndoRecord): string { return replaceExact(undo.before, undo.from, undo.to, undo.replacement); }
