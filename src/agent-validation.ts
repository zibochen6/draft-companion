import type { AgentActionReceipt } from './agent-types';
import type { DocumentRecord } from './types';

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}应为对象。`);
  return value as JsonObject;
}

function keys(value: JsonObject, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label}含未知字段。`);
}

function string(value: unknown, label: string, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || (nonempty && !value)) throw new Error(`${label}应为${nonempty ? '非空' : ''}文本。`);
}

function number(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label}数值无效。`);
}

interface StoredAnchor { text: string; valid: boolean }

function anchor(value: unknown, label: string): StoredAnchor {
  const data = object(value, label);
  keys(data, ['from', 'to', 'text', 'valid'], label);
  number(data.from, `${label}起点`); number(data.to, `${label}终点`); string(data.text, `${label}文本`);
  if (!Number.isInteger(data.from) || !Number.isInteger(data.to) || data.to < data.from || typeof data.valid !== 'boolean') {
    throw new Error(`${label}范围无效。`);
  }
  if (data.valid && data.to - data.from !== data.text.length) throw new Error(`${label}长度不符。`);
  return { text: data.text, valid: data.valid };
}

/** Validate persisted agent action receipts before Store can retain or re-save them. */
export function validateAgentActions(value: unknown, document: DocumentRecord): asserts value is AgentActionReceipt[] {
  if (!Array.isArray(value)) throw new Error('智能体操作记录应为列表。');
  const ids = new Set<string>();
  for (const item of value) {
    const receipt = object(item, '智能体操作记录');
    keys(receipt, [
      'id', 'requestId', 'documentId', 'path', 'at', 'kind', 'label', 'before', 'replacement', 'anchor',
      'beforeContext', 'afterContext', 'beforeHash', 'afterHash', 'state', 'invalidReason',
    ], '智能体操作记录');
    for (const key of ['id', 'requestId', 'documentId', 'path', 'label', 'before', 'replacement', 'beforeHash', 'afterHash']) {
      string(receipt[key], `智能体操作${key}`, key !== 'before' && key !== 'replacement');
    }
    number(receipt.at, '智能体操作时间');
    if (receipt.documentId !== document.id || receipt.path !== document.path || ids.has(receipt.id as string)) {
      throw new Error('智能体操作与文稿关联无效。');
    }
    ids.add(receipt.id as string);
    if (receipt.kind !== 'topic-check' && receipt.kind !== 'replace' && receipt.kind !== 'insert') throw new Error('智能体操作类型无效。');
    if (receipt.state !== 'prepared' && receipt.state !== 'applied' && receipt.state !== 'undone' && receipt.state !== 'needs-check') throw new Error('智能体操作状态无效。');
    if (receipt.invalidReason !== undefined) string(receipt.invalidReason, '智能体操作失效原因');
    const target = anchor(receipt.anchor, '智能体操作锚点');
    if (receipt.beforeContext !== undefined) anchor(receipt.beforeContext, '智能体操作前文');
    if (receipt.afterContext !== undefined) anchor(receipt.afterContext, '智能体操作后文');
    if (receipt.state === 'applied' && (!target.valid || target.text !== receipt.replacement)) throw new Error('已应用智能体操作锚点与替换文本不匹配。');
    if (receipt.state === 'undone' && (!target.valid || target.text !== receipt.before)) throw new Error('已撤回智能体操作锚点与原文本不匹配。');
  }
}
