import type { DocumentReview } from './review-types';
import { hashText } from './editing';

function obj(v: unknown, fields: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('批注数据应为对象。');
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some(k => !fields.includes(k))) throw new Error('批注含未知字段。');
  return o;
}
function str(v: unknown): asserts v is string { if (typeof v !== 'string') throw new Error('批注文本损坏。'); }
function num(v: unknown): asserts v is number { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('批注数值损坏。'); }
function list(v: unknown): unknown[] { if (!Array.isArray(v)) throw new Error('批注列表损坏。'); return v; }
function state(v: unknown, states: string[]) { if (typeof v !== 'string' || !states.includes(v)) throw new Error('批注状态损坏。'); }
function author(v: unknown) { const o = obj(v, ['id','name','systemPrompt']); for (const k of ['id','name','systemPrompt']) str(o[k]); }
function anchor(v: unknown, scope = false) {
  const o = obj(v, scope ? ['from','to','valid'] : ['from','to','text','valid']);
  num(o.from); num(o.to);
  if (!Number.isInteger(o.from) || !Number.isInteger(o.to) || o.to < o.from || typeof o.valid !== 'boolean') throw new Error('批注锚点损坏。');
  if (!scope) { str(o.text); if (o.valid && o.to - o.from !== o.text.length) throw new Error('批注锚点长度不符。'); }
}
export function validateReviewData(value: unknown, documentId: string): asserts value is DocumentReview {
  try {
    const r = obj(value, ['verifiedHash','runs','suggestions','receipts','selectedId']); str(r.verifiedHash);
    if (r.selectedId !== undefined) str(r.selectedId);
    const runIds = new Set<string>();
    for (const item of list(r.runs)) {
      const o = obj(item, ['id','requestId','at','author','model','providerName','snapshotHash','scope','status','summary','overall','added','duplicates','error',
        'documentId','path','providerId','from','to','selection','snapshot','input','preferences','brief','errorKind','errorDiagnostic']);
      for (const k of ['id','requestId','model','providerName','snapshotHash','summary']) str(o[k]);
      num(o.at); num(o.added); num(o.duplicates); author(o.author);
      state(o.scope, ['body','selection']); state(o.status, ['running','completed','failed','stopped','interrupted']);
      if (o.error !== undefined) str(o.error);
      for (const field of ['documentId','path','providerId','input','preferences','brief','errorKind']) if (o[field] !== undefined) str(o[field]);
      if (o.documentId !== undefined && o.documentId !== documentId) throw new Error('审阅轮次所属文稿无效。');
      if (o.snapshot !== undefined) {
        str(o.snapshot); str(o.selection); num(o.from); num(o.to);
        if (!Number.isInteger(o.from) || !Number.isInteger(o.to) || o.to < o.from || o.to > o.snapshot.length ||
          o.snapshot.slice(o.from,o.to) !== o.selection || hashText(o.snapshot) !== o.snapshotHash)
          throw new Error('审阅快照或冻结范围损坏。');
      } else if (o.from !== undefined || o.to !== undefined || o.selection !== undefined) throw new Error('审阅快照缺失。');
      if (o.errorDiagnostic !== undefined) {
        const diagnostic=obj(o.errorDiagnostic,['category','httpStatus','code','stage']);str(diagnostic.category);
        if (diagnostic.code!==undefined) str(diagnostic.code);
        if (diagnostic.stage!==undefined) state(diagnostic.stage,['configuration','models','chat','review']);
        if (diagnostic.httpStatus!==undefined) {
          num(diagnostic.httpStatus);
          if (!Number.isInteger(diagnostic.httpStatus)||diagnostic.httpStatus<100||diagnostic.httpStatus>599) throw new Error('审阅诊断状态损坏。');
        }
      }
      for (const part of list(o.overall)) { const p = obj(part,['type','title','reason']); for (const k of ['type','title','reason']) str(p[k]); }
      if (runIds.has(o.id as string)) throw new Error('批注轮次重复。'); runIds.add(o.id as string);
    }
    const ids = new Set<string>(); const versionIds = new Map<string, Set<string>>();
    for (const item of list(r.suggestions)) {
      const o = obj(item, ['id','documentId','runId','number','type','title','quote','contextBefore','contextAfter','author','versions','currentVersionId','anchors','state','invalidReason','fingerprint','replies','handledAt']);
      for (const k of ['id','documentId','runId','type','title','quote','contextBefore','contextAfter','currentVersionId','fingerprint']) str(o[k]);
      if (o.documentId !== documentId || !runIds.has(o.runId as string) || ids.has(o.id as string)) throw new Error('批注关联无效。');
      ids.add(o.id as string); num(o.number); author(o.author);
      state(o.state, ['pending','comment','unlocated','needs-check','applying','applied','ignored']);
      if (o.invalidReason !== undefined) str(o.invalidReason); if (o.handledAt !== undefined) num(o.handledAt);
      const versions = new Set<string>();
      for (const v of list(o.versions)) {
        const ver = obj(v, ['id','at','author','reason','replacement','evidenceQuotes','supersededBy']);
        str(ver.id); str(ver.reason); num(ver.at); author(ver.author);
        if (ver.replacement !== null) { str(ver.replacement); if (!ver.replacement.trim()) throw new Error('空替换批注无效。'); }
        for (const q of list(ver.evidenceQuotes)) str(q);
        if (ver.supersededBy !== undefined) str(ver.supersededBy);
        if (versions.has(ver.id)) throw new Error('批注版本重复。'); versions.add(ver.id);
      }
      if (!versions.has(o.currentVersionId as string)) throw new Error('批注当前版本无效。'); versionIds.set(o.id as string, versions);
      if (o.anchors !== undefined) {
        const a = obj(o.anchors, ['target','before','after','evidence','scope']); anchor(a.target); anchor(a.scope,true);
        if (a.before !== undefined) anchor(a.before); if (a.after !== undefined) anchor(a.after);
        for (const e of list(a.evidence)) anchor(e);
      }
      for (const v of list(o.replies)) {
        const reply = obj(v,['id','at','author','input','content','status']); for (const k of ['id','input','content']) str(reply[k]);
        num(reply.at); author(reply.author); state(reply.status,['completed','failed','stopped','interrupted']);
      }
    }
    const receiptIds = new Set<string>();
    for (const item of list(r.receipts)) {
      const o = obj(item,['id','suggestionId','versionId','documentId','at','before','replacement','anchor','beforeContext','afterContext','state','beforeHash','afterHash']);
      for (const k of ['id','suggestionId','versionId','documentId','before','replacement','beforeHash','afterHash']) str(o[k]);
      if (o.documentId !== documentId || !versionIds.get(o.suggestionId as string)?.has(o.versionId as string) || receiptIds.has(o.id as string)) throw new Error('撤回回执关联无效。');
      receiptIds.add(o.id as string); num(o.at); anchor(o.anchor);
      if (o.beforeContext !== undefined) anchor(o.beforeContext); if (o.afterContext !== undefined) anchor(o.afterContext);
      state(o.state,['applied','undone','needs-check']);
    }
    if (r.selectedId && !ids.has(r.selectedId)) throw new Error('所选批注不存在。');
  } catch (e) { throw new Error(`稿伴数据损坏：${e instanceof Error ? e.message : '批注无效'}原数据未覆盖。`); }
}
