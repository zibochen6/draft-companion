import type { DailyTopicData, TopicCard } from './daily-types';

function fail(label: string): never { throw new Error(`稿伴自动选题数据损坏：${label}。原数据未覆盖。`); }
function object(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} 应为对象`);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !allowed.includes(key))) fail(`${label} 含未知字段`);
  return item;
}
function text(value: unknown, label: string, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail(`${label} 应为文本`);
}
function number(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label} 数值无效`);
}
function list(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) return fail(`${label} 应为列表`); return value; }
function strings(value: unknown, label: string): void { for (const item of list(value, label)) text(item, label); }
function state(value: unknown, allowed: string[], label: string): void { if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} 状态无效`); }
function boolean(value: unknown, label: string): void { if (typeof value !== 'boolean') fail(`${label} 应为布尔值`); }
function date(value: unknown): void {
  text(value, '日期', true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('日期无效');
}
function hash(value: unknown): void { text(value, '版本指纹', true); if (!/^[a-f\d]{64}$/.test(value)) fail('版本指纹无效'); }
function anchor(value: unknown): void {
  const a = object(value, ['from', 'to', 'text', 'valid'], '回执锚点'); number(a.from, '起点'); number(a.to, '终点'); text(a.text, '回执文字'); boolean(a.valid, '锚点状态');
  if (!Number.isInteger(a.from) || !Number.isInteger(a.to) || a.to < a.from || (a.valid && a.to - a.from !== a.text.length)) fail('回执锚点范围无效');
}
export function validateTopicCard(value: unknown): asserts value is TopicCard {
  const card = object(value, ['sourceId', 'selected', 'description', 'reason', 'gaps', 'potential', 'angle', 'primaryTitle', 'alternativeTitles', 'opening', 'outline', 'evidence'], '选题卡');
  text(card.sourceId, '来源引用', true); boolean(card.selected, '优选状态'); text(card.reason, '推荐理由', true); strings(card.gaps, '材料缺口');
  if ('description' in card) {
    text(card.description, '中文简介', true);
    if (card.description.length > 180 || !/\p{Script=Han}/u.test(card.description) || /[\u0000-\u001f\u007f\u2028\u2029]/.test(card.description)) fail('中文简介应为不超过180字的非空中文单行文本');
  }
  state(card.potential, ['high', 'medium', 'needs-materials'], '创作潜质');
  for (const key of ['angle', 'primaryTitle', 'opening']) if (card[key] !== undefined) text(card[key], '创作预设', true);
  for (const key of ['alternativeTitles', 'outline']) if (card[key] !== undefined) strings(card[key], '创作预设');
  if (card.selected) {
    for (const key of ['angle', 'primaryTitle', 'opening']) text(card[key], '优选创作预设', true);
    const titles = list(card.alternativeTitles, '备选标题');
    if (titles.length !== 4 || new Set([card.primaryTitle, ...titles]).size !== 5 || titles.some(title => typeof title !== 'string' || !title.trim())) fail('优选需要四个不同角度的备选标题');
    if (!list(card.outline, '写作提纲').length) fail('优选缺少写作提纲');
    if (card.potential === 'needs-materials') fail('材料不足的选题不能自动勾选');
  }
  if (card.evidence !== undefined) for (const value of list(card.evidence, '证据')) {
    const evidence = object(value, ['sourceId', 'quote'], '证据'); text(evidence.sourceId, '证据来源', true); text(evidence.quote, '证据引用', true);
  }
}
export function validateDailyTopicData(value: unknown): asserts value is DailyTopicData {
  const data = object(value, ['settings', 'runs', 'receipts', 'seen'], '自动选题配置');
  const settings = object(data.settings, ['time', 'timeZone', 'providerId', 'roleId', 'authorBackground', 'targetReader', 'interests', 'exclusions', 'githubFallback'], '定时设置');
  for (const key of ['time', 'timeZone', 'providerId', 'roleId', 'authorBackground', 'targetReader', 'interests', 'exclusions']) text(settings[key], '设置字段');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.time as string) || settings.timeZone !== 'Asia/Shanghai') fail('定时时间无效');
  boolean(settings.githubFallback, 'GitHub 补充设置');
  const runIds = new Set<string>(), runReceipts = new Set<string>(), runs = new Map<string, Record<string, unknown>>();
  for (const value of list(data.runs, '运行记录')) {
    const run = object(value, ['id', 'date', 'origin', 'status', 'stage', 'documentId', 'path', 'startedAt', 'completedAt', 'sources', 'cards', 'entries', 'receiptId', 'message', 'error'], '运行记录');
    text(run.id, '运行 ID', true); if (runIds.has(run.id)) fail('运行 ID 重复'); runIds.add(run.id); runs.set(run.id, run);
    date(run.date); state(run.origin, ['manual', 'scheduled'], '启动方式');
    state(run.status, ['queued', 'collecting', 'screening', 'reading', 'preparing', 'committing', 'completed', 'no-new', 'failed', 'stopped', 'interrupted'], '运行');
    text(run.stage, '运行阶段'); number(run.startedAt, '开始时间');
    for (const key of ['documentId', 'path', 'receiptId', 'message', 'error']) if (run[key] !== undefined) text(run[key], '运行字段', ['documentId', 'path', 'receiptId'].includes(key));
    if (run.completedAt !== undefined) number(run.completedAt, '结束时间');
    if (typeof run.receiptId === 'string') runReceipts.add(run.receiptId);
    for (const value of list(run.sources, '来源状态')) {
      const source = object(value, ['name', 'status', 'message', 'at'], '来源状态'); text(source.name, '来源名称', true); text(source.message, '来源说明'); number(source.at, '采集时间'); state(source.status, ['success', 'failed', 'fallback'], '来源');
    }
    const cards = list(run.cards, '选题卡'); if (cards.length > 10) fail('候选超过容量上限');
    const ids = new Set<string>(); let selected = 0;
    for (const card of cards) { validateTopicCard(card); if (ids.has(card.sourceId)) fail('候选来源重复'); ids.add(card.sourceId); if (card.selected) selected++; }
    if (selected > 5) fail('优选超过容量上限');
    if (run.entries !== undefined) {
      const entries = list(run.entries, '选题名称'); if (entries.length > 10) fail('选题名称超过容量上限');
      for (const value of entries) {
        const entry = object(value, ['sourceId', 'title', 'url', 'source'], '选题名称');
        for (const key of ['sourceId', 'title', 'url', 'source']) text(entry[key], '选题名称字段', true);
      }
    }
  }
  const receiptIds = new Set<string>();
  for (const value of list(data.receipts, '批次回执')) {
    const receipt = object(value, ['id', 'runId', 'documentId', 'path', 'date', 'at', 'state', 'beforeHash', 'afterHash', 'blocks', 'invalidReason'], '批次回执');
    for (const key of ['id', 'runId', 'documentId', 'path']) text(receipt[key], '回执字段', true);
    if (receiptIds.has(receipt.id as string)) fail('回执 ID 重复'); receiptIds.add(receipt.id as string);
    if (!runIds.has(receipt.runId as string)) fail('回执运行关联无效');
    const run = runs.get(receipt.runId as string)!;
    if ((run.receiptId !== undefined && run.receiptId !== receipt.id) || (run.documentId !== undefined && run.documentId !== receipt.documentId)
      || (run.path !== undefined && run.path !== receipt.path) || run.date !== receipt.date) fail('回执与运行目标关联无效');
    date(receipt.date); number(receipt.at, '回执时间'); hash(receipt.beforeHash); hash(receipt.afterHash);
    state(receipt.state, ['prepared', 'applied', 'undone', 'needs-check'], '回执');
    if (receipt.invalidReason !== undefined) text(receipt.invalidReason, '回执说明');
    const blocks = list(receipt.blocks, '新增内容'); if (!blocks.length || blocks.length > 10) fail('新增内容数量无效');
    const blockIds = new Set<string>();
    for (const value of blocks) {
      const block = object(value, ['id', 'canonicalId', 'anchor'], '新增内容'); text(block.id, '条目 ID', true); text(block.canonicalId, '规范来源', true); anchor(block.anchor);
      if (blockIds.has(block.id)) fail('条目 ID 重复'); blockIds.add(block.id);
    }
  }
  if ([...runReceipts].some(id => !receiptIds.has(id))) fail('运行回执关联无效');
  if (!data.seen || typeof data.seen !== 'object' || Array.isArray(data.seen)) fail('去重索引应为对象');
  for (const [key, value] of Object.entries(data.seen as Record<string, unknown>)) {
    if (!key) fail('去重来源为空');
    const seen = object(value, ['fingerprint', 'selected', 'runId', 'at'], '去重记录'); text(seen.fingerprint, '事实指纹', true); text(seen.runId, '去重运行', true); boolean(seen.selected, '去重优选状态'); number(seen.at, '去重时间');
  }
}
