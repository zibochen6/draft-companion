import type { RequestSnapshot } from './types';
import { buildMessages } from './prompts';
import type { ReviewResult, ReviewSuggestionInput, Suggestion } from './review-types';
import { currentVersion } from './review-types';

const REVIEW_RULES = `本轮方式：句级审阅。只返回一个完整 JSON 对象，字段为 summary、overall、suggestions，不要前后说明或代码围栏。
summary 为简短总结。overall 是整体建议数组，每项仅有 type、title、reason 字符串。
suggestions 是句级建议数组，每项仅有 type、title、quote、contextBefore、contextAfter、reason、replacement，可选 evidenceQuotes 字符串数组。
优先三至五个重要问题，确实没有问题可返回空数组。检查标题承诺、开头价值、结构论证、冗余、作者口吻、事实依据和结尾。
quote 必须逐字引用最新全文中冻结范围内的原句，不能省略、重写或改变空格和换行。contextBefore、contextAfter 默认使用空字符串；仅当 quote 在原文重复而需要消歧时，提供紧邻原句的短原始片段，包含必要的空格、标点和换行，不能引用隔着空行的上一段或下一段。不确定时保持空字符串，由插件判断唯一性。
reason 解释问题。replacement 可选，为仅替换 quote 的完整 Markdown 新句；JSON null 或省略表示仅评论，不允许空字符串或空白。建议删除、合并、移动且不能提供非空原地替换时必须用 null，仅评论交给作者处理，不能输出空字符串。evidenceQuotes 必须逐字引用最新全文。
不能虚构经历、数据、来源或声称联网核查；材料不足只能标为待核实，不能编造所谓正确数据。不得输出路径、偏移、文稿身份、编号、补丁、权限或工具调用。
这些批注尚未应用，用户明确采纳前不属于正文。`;

export class ReviewProtocolError extends Error {
  readonly kind = 'format';
  readonly diagnostics: { category: string; code: string; stage: 'review' };
  constructor(message: string, code = 'review-schema-invalid') {
    super(message); this.name = 'ReviewProtocolError';
    this.diagnostics = { category: this.kind, code, stage: 'review' };
  }
}

function object(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewProtocolError(`${label} 必须为对象。`);
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => !allowed.includes(k))) throw new ReviewProtocolError(`${label} 含不支持的字段。`);
  return obj;
}
function text(value: unknown, label: string, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || (nonempty && !value.trim()) || value.length > 250000) throw new ReviewProtocolError(`${label} 文本无效。`);
}
function parse(raw: string): unknown {
  let source = raw.trim();
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*)\r?\n```$/.exec(source);
  if (fence) source = fence[1]!;
  try { return JSON.parse(source); } catch { throw new ReviewProtocolError('审稿结果不是完整有效的 JSON，未形成可应用批注。请重试审阅。', 'review-json-invalid'); }
}
export function validateReviewInput(value: unknown): ReviewSuggestionInput {
  const v = object(value, ['type','title','quote','contextBefore','contextAfter','reason','replacement','evidenceQuotes'], '句级建议');
  for (const key of ['type','title','quote','contextBefore','contextAfter','reason']) text(v[key], key, ['title','quote','reason'].includes(key));
  if (v.replacement !== undefined && v.replacement !== null) text(v.replacement, '替换内容', true);
  if (v.evidenceQuotes !== undefined && (!Array.isArray(v.evidenceQuotes) || v.evidenceQuotes.length > 30 || v.evidenceQuotes.some(q => typeof q !== 'string' || !q.trim()))) throw new ReviewProtocolError('依据引用必须是非空字符串数组。');
  // The optional replacement can only remove write permission; missing required
  // quote/context/reason fields above are never repaired into an executable edit.
  return { ...v, replacement: v.replacement ?? null } as unknown as ReviewSuggestionInput;
}
export function parseReview(raw: string): ReviewResult {
  const v = object(parse(raw), ['summary','overall','suggestions'], '审稿结果');
  text(v.summary, '总结');
  if (!Array.isArray(v.overall) || v.overall.length > 100 || !Array.isArray(v.suggestions) || v.suggestions.length > 100) throw new ReviewProtocolError('审稿建议列表无效或过长。');
  const overall = v.overall.map(item => {
    const o = object(item, ['type','title','reason'], '整体建议');
    for (const key of ['type','title','reason']) text(o[key], key);
    return o as unknown as ReviewResult['overall'][number];
  });
  return { summary: v.summary, overall, suggestions: v.suggestions.map(validateReviewInput) };
}
export function parseSuggestionRevision(raw: string): { reason: string; replacement: string; evidenceQuotes: string[] } {
  const v = object(parse(raw), ['reason','replacement','evidenceQuotes'], '新改法');
  text(v.reason, '说明', true); text(v.replacement, '替换内容', true);
  if (!Array.isArray(v.evidenceQuotes) || v.evidenceQuotes.some(q => typeof q !== 'string' || !q.trim())) throw new ReviewProtocolError('新改法依据字段无效。');
  return v as unknown as { reason: string; replacement: string; evidenceQuotes: string[] };
}
export function reviewMessages(snapshot: RequestSnapshot, states: string) {
  const messages = buildMessages({ ...snapshot, mode: 'review' });
  messages[0]!.content += `\n\n${REVIEW_RULES}`;
  if (states) messages.at(-1)!.content += `\n【现有批注处理记录；未采纳内容仅为候选】\n${states}`;
  return messages;
}
export function suggestionMessages(snapshot: RequestSnapshot, suggestion: Suggestion, revise: boolean) {
  const messages = buildMessages({ ...snapshot, mode: revise ? 'review' : 'discuss' });
  messages[0]!.content += revise
    ? '\n本轮仅对当前批注再改一版。只返回完整 JSON 对象 {"reason":"说明","replacement":"仅替换当前原句的非空完整内容","evidenceQuotes":[]}。不得扩大原句范围，不允许空替换隐式删除。依据必须逐字引用最新全文。'
    : '\n本轮是当前批注的追问。正常 Markdown 回复；只讨论，不改变当前替换候选，不声称意见已采纳。';
  const version = currentVersion(suggestion);
  messages.at(-1)!.content += `\n【当前批注；原作者 ${suggestion.author.name}；状态 ${suggestion.state}；候选尚不等于正文】\n${JSON.stringify({ title:suggestion.title, quote:suggestion.quote, reason:version.reason, replacement:version.replacement })}\n【当前批注讨论记录】\n${suggestion.replies.map(r => `用户：${r.input}\n${r.author.name}（${r.status}）：${r.content}`).join('\n')}`;
  return messages;
}
