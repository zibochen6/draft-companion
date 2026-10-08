import { randomUUID } from 'node:crypto';
import { hashText } from './editing';
import { applyDailyChanges } from './daily-notes';
import type { DailyTopicUpdate, TopicBatchReceipt } from './daily-types';
import type { DocumentRecord } from './types';
import type { ChangeKind, TextAnchor, TextChange } from './review-types';

function boundary(text: string, at: number): boolean {
  if (!Number.isInteger(at) || at < 0 || at > text.length) return false;
  const a = text.charCodeAt(at - 1), b = text.charCodeAt(at);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) && !(a === 13 && b === 10);
}
function matches(text: string, anchor: TextAnchor): boolean {
  return anchor.valid && boundary(text, anchor.from) && boundary(text, anchor.to) && anchor.to >= anchor.from && text.slice(anchor.from, anchor.to) === anchor.text;
}
function overlap(change: TextChange, anchor: TextAnchor): boolean {
  return change.from === change.to ? change.from > anchor.from && change.from < anchor.to : change.from < anchor.to && change.to > anchor.from;
}
function mapPosition(point: number, association: -1 | 1, changes: TextChange[]): number {
  let delta = 0;
  for (const change of [...changes].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (point < change.from) break;
    if (point > change.to) { delta += change.insert.length - (change.to - change.from); continue; }
    if (point === change.from) return change.from + delta + (association > 0 ? change.insert.length : 0);
    if (point === change.to) return change.from + delta + change.insert.length;
    return change.from + delta + (association > 0 ? change.insert.length : 0);
  }
  return point + delta;
}
function invalid(receipt: TopicBatchReceipt, reason: string): void {
  receipt.state = 'needs-check'; receipt.invalidReason = reason;
  for (const block of receipt.blocks) block.anchor.valid = false;
}
export function makeTopicBatchReceipt(document: DocumentRecord, runId: string, before: string, plan: DailyTopicUpdate, date: string, at: number): TopicBatchReceipt {
  if (!plan.blocks.length || applyDailyChanges(before, plan.changes) !== plan.after || !plan.blocks.every(block => matches(plan.after, block.anchor))) throw new Error('选题批次准备记录无法校验，原文未修改。');
  return { id: randomUUID(), runId, documentId: document.id, path: document.path, date, at, state: 'prepared',
    beforeHash: hashText(before), afterHash: hashText(plan.after), blocks: structuredClone(plan.blocks) };
}
/** The caller filters to the changed document and excludes a receipt during its own explicit undo. */
export function mapTopicReceipts(receipts: TopicBatchReceipt[], before: string, after: string, changes: TextChange[], kind: ChangeKind = 'edit'): void {
  let valid = false;
  try { valid = applyDailyChanges(before, changes) === after && changes.every(change => boundary(before, change.from) && boundary(before, change.to)); } catch { /* conservative invalidation below */ }
  const beforeHash = hashText(before), afterHash = hashText(after);
  for (const receipt of receipts) {
    if (receipt.state === 'needs-check') continue;
    if (receipt.state === 'prepared') {
      // The write emits before its promise resolves. Its exact prepared after-state is safe to leave for the caller to verify.
      if (receipt.beforeHash === beforeHash && receipt.afterHash === afterHash && receipt.blocks.every(block => matches(after, block.anchor))) continue;
      invalid(receipt, '准备期间文稿发生变化，未自动重新执行。'); continue;
    }
    const expectedHash = receipt.state === 'applied' ? receipt.afterHash : receipt.beforeHash;
    if (!valid || expectedHash !== beforeHash) { invalid(receipt, '文稿版本链中断，无法安全撤回本次选题。'); continue; }
    if ((kind === 'undo' || kind === 'redo') && receipt.state === 'applied' && receipt.blocks.every(block => matches(before, block.anchor)
      && changes.some(change => change.from <= block.anchor.from && change.to >= block.anchor.to && !change.insert.includes(`draft-companion:topic:${block.id}:start`))
      && !after.includes(`draft-companion:topic:${block.id}:start`))) {
      receipt.state = 'undone'; receipt.beforeHash = afterHash; delete receipt.invalidReason;
      for (const block of receipt.blocks) { const point = mapPosition(block.anchor.from, -1, changes); block.anchor.from = point; block.anchor.to = point; block.anchor.valid = false; }
      continue;
    }
    if ((kind === 'undo' || kind === 'redo') && receipt.state === 'undone') {
      const restored = receipt.blocks.map(block => {
        const marker = `<!-- draft-companion:topic:${block.id}:start -->`;
        const locations: number[] = []; let delta = 0;
        for (const change of [...changes].sort((a, b) => a.from - b.from || a.to - b.to)) {
          if (change.from <= block.anchor.from && change.to >= block.anchor.from) {
            const at = change.insert.indexOf(marker);
            if (at >= 0 && change.insert.indexOf(marker, at + marker.length) < 0 && change.insert.slice(at, at + block.anchor.text.length) === block.anchor.text)
              locations.push(change.from + delta + at);
          }
          delta += change.insert.length - (change.to - change.from);
        }
        if (locations.length !== 1) return undefined;
        const from = locations[0]!;
        // A location comes only from the actual inverse transaction; marker searches only prove uniqueness.
        if (after.indexOf(marker) !== from || after.indexOf(marker, from + marker.length) >= 0 || after.slice(from, from + block.anchor.text.length) !== block.anchor.text) return undefined;
        return { ...block.anchor, from, to: from + block.anchor.text.length, valid: true };
      });
      if (restored.every(anchor => !!anchor)) {
        receipt.blocks.forEach((block, index) => { block.anchor = restored[index]!; }); receipt.state = 'applied'; receipt.afterHash = afterHash; delete receipt.invalidReason; continue;
      }
    }
    let conflict = false;
    for (const block of receipt.blocks) {
      const anchor = block.anchor;
      if (receipt.state === 'applied' && (!matches(before, anchor) || changes.some(change => overlap(change, anchor)))) conflict = true;
      const from = mapPosition(anchor.from, 1, changes), to = mapPosition(anchor.to, -1, changes);
      anchor.from = from; anchor.to = Math.max(from, to);
      if (receipt.state === 'applied' && !matches(after, anchor)) conflict = true;
    }
    if (conflict) invalid(receipt, '本次新增内容已被修改或删除，无法安全整批撤回。');
    else if (receipt.state === 'applied') receipt.afterHash = afterHash;
    else receipt.beforeHash = afterHash;
  }
}
/** Restart recovery requires exact tracked state; no text search moves an active receipt. */
export function reconcileTopicReceipts(receipts: TopicBatchReceipt[], document: DocumentRecord, text: string): void {
  const currentHash = hashText(text);
  for (const receipt of receipts) {
    if (receipt.documentId !== document.id) continue;
    if (document.deleted || receipt.path !== document.path) { invalid(receipt, '原选题库身份无法确认。'); continue; }
    if (receipt.state === 'needs-check') continue;
    if (receipt.state === 'prepared') {
      if (receipt.afterHash === currentHash && receipt.blocks.every(block => matches(text, block.anchor))) { receipt.state = 'applied'; delete receipt.invalidReason; }
      else invalid(receipt, '上次选题写入未能确认，未自动重发。');
    } else if (receipt.state === 'applied' && (receipt.afterHash !== currentHash || !receipt.blocks.every(block => matches(text, block.anchor)))) {
      invalid(receipt, '重启或外部修改后无法核实本次新增内容。');
    } else if (receipt.state === 'undone' && receipt.beforeHash !== currentHash) invalid(receipt, '撤回后文稿发生未知修改，需要重新检查。');
  }
}
export function planTopicBatchUndo(receipt: TopicBatchReceipt, text: string): TextChange[] {
  if (receipt.state !== 'applied' || receipt.afterHash !== hashText(text) || !receipt.blocks.every(block => matches(text, block.anchor))) throw new Error('本次新增内容或文稿版本已变化，无法安全撤回。');
  const changes = receipt.blocks.map(block => ({ from: block.anchor.from, to: block.anchor.to, insert: '' })).sort((a, b) => a.from - b.from);
  applyDailyChanges(text, changes); return changes;
}
export function canUndoTopicBatch(receipt: TopicBatchReceipt, text: string): boolean { try { planTopicBatchUndo(receipt, text); return true; } catch { return false; } }
export function finishTopicBatchUndo(receipt: TopicBatchReceipt, before: string, changes: TextChange[]): void {
  const after = applyDailyChanges(before, changes);
  receipt.state = 'undone'; receipt.beforeHash = hashText(after); delete receipt.invalidReason;
  for (const block of receipt.blocks) { const point = mapPosition(block.anchor.from, -1, changes); block.anchor.from = point; block.anchor.to = point; block.anchor.valid = false; }
}
