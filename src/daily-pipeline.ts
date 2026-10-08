import type { ChatMessage, ChatResult } from './types';
import type { SourceItem, SourceStatus, TopicCard } from './daily-types';
import { collectSources, readMaterials, normalizeSourceUrl, splitFactFingerprint, withMaterialFingerprint, DailySourceError, type SourceOptions, type SourceCollection } from './daily-sources';
import { dailyCardsMessages, dailyShortlistMessages, parseDailyCards, parseDailyShortlist, type DailyPromptContext } from './daily-protocol';

export interface DailyPipelineOptions extends DailyPromptContext {
  signal: AbortSignal; existing?: Map<string, string>; existingSelected?: Set<string>;
  onStage?: (stage: string) => void; assertActive?: () => void;
  chat: (messages: ChatMessage[], signal: AbortSignal) => Promise<ChatResult>;
  sourceOptions?: SourceOptions;
  /** Tests inject synthetic sources without changing production host settings. */
  collect?: (signal: AbortSignal, options?: SourceOptions) => Promise<SourceCollection>;
  materials?: (items: SourceItem[], signal: AbortSignal, options?: SourceOptions) => Promise<SourceItem[]>;
}
export interface DailyPipelineResult {
  items: SourceItem[]; cards: TopicCard[]; sources: SourceStatus[];
  observations: { canonicalId: string; fingerprint: string }[]; noChanges: boolean; summary: string;
}
function active(options: DailyPipelineOptions): void {
  if (options.signal.aborted) throw new DailySourceError('cancelled', '选题任务已停止。');
  options.assertActive?.();
}
export async function runDailyPipeline(options: DailyPipelineOptions): Promise<DailyPipelineResult> {
  let sources: SourceStatus[] = [];
  try { return await pipeline(options, collected => { sources = collected.sources; }); }
  catch (error) {
    if (error instanceof Error) { Object.assign(error, { sources }); throw error; }
    throw Object.assign(new Error('选题流程失败，未完成写入。'), { sources });
  }
}
async function pipeline(options: DailyPipelineOptions, onCollected: (collection: SourceCollection) => void): Promise<DailyPipelineResult> {
  active(options); options.onStage?.('采集中');
  const collected = await (options.collect ?? collectSources)(options.signal, options.sourceOptions);
  onCollected(collected);
  active(options);
  if (collected.sources.length && collected.sources.every(source => source.status === 'failed') && !collected.items.length) throw new DailySourceError('network', '全部选题来源读取失败，未写入空日刊。');
  const observed = new Map(collected.items.map(item => {
    const old = options.existing?.get(item.canonicalId);
    return [item.canonicalId, old && splitFactFingerprint(old).list === item.fingerprint ? old : item.fingerprint];
  }));
  const newInputs = collected.items.filter(item => {
    const seen = options.existing?.get(item.canonicalId) ?? options.existing?.get(`news:${normalizeSourceUrl(item.primaryUrl ?? item.url)}`);
    // '*' denotes a user-authored existing item with no verified fact baseline.
    // It cannot be reintroduced based on an unproven list description change.
    return seen !== '*' && !options.existingSelected?.has(item.canonicalId) && (!seen || splitFactFingerprint(seen).list !== item.fingerprint);
  });
  const retained = collected.items.filter(item => {
    const previous = options.existing?.get(item.canonicalId);
    return previous && splitFactFingerprint(previous).material && splitFactFingerprint(previous).list === item.fingerprint && !options.existingSelected?.has(item.canonicalId);
  }).slice(0, newInputs.length ? 3 : 10);
  const prefetched = new Map<string, SourceItem>();
  const read = options.materials ?? readMaterials;
  const materialItems = async (items: SourceItem[]): Promise<SourceItem[]> => {
    const output = await read(items, options.signal, options.sourceOptions); active(options);
    if (output.length !== items.length || output.some((entry, index) => entry.id !== items[index]!.id || entry.canonicalId !== items[index]!.canonicalId)) throw new DailySourceError('format', '原始材料读取改变了冻结的来源引用。');
    return output.map(withMaterialFingerprint);
  };
  if (retained.length) {
    options.onStage?.('读取材料');
    for (const entry of await materialItems(retained)) {
      prefetched.set(entry.id, entry);
      if ((entry.materials ?? []).some(material => material.status === 'verified')) observed.set(entry.canonicalId, entry.fingerprint);
    }
  }
  const progressed = retained.flatMap(entry => {
    const refreshed = prefetched.get(entry.id)!;
    return refreshed.fingerprint.startsWith('v1:') && refreshed.fingerprint !== options.existing?.get(entry.canonicalId) ? [refreshed] : [];
  });
  const inputs = [...newInputs, ...progressed];
  const observations = () => [...observed].map(([canonicalId, fingerprint]) => ({ canonicalId, fingerprint }));
  const unchanged = (summary: string): DailyPipelineResult => ({ items: [], cards: [], sources: collected.sources, observations: observations(), noChanges: true, summary });
  if (!inputs.length) return unchanged('没有新增选题。');
  active(options); options.onStage?.('筛选中');
  const shortlistResult = await options.chat(dailyShortlistMessages(options, inputs), options.signal);
  active(options); const shortlist = parseDailyShortlist(shortlistResult, inputs);
  if (!shortlist.shortlist.length) return unchanged(shortlist.summary || '没有适合当前偏好的新增选题。');
  const byId = new Map(inputs.map(item => [item.id, item]));
  const selected = shortlist.shortlist.map(row => prefetched.get(row.sourceId) ?? byId.get(row.sourceId)!);
  active(options); options.onStage?.('读取材料');
  const toRead = selected.filter(item => !prefetched.has(item.id)).slice(0, 10 - retained.length);
  const freshMaterials = new Map((await materialItems(toRead)).map(item => [item.id, item]));
  const withMaterials = selected.map(entry => prefetched.get(entry.id) ?? freshMaterials.get(entry.id) ?? { ...entry, materials: [{ url: entry.primaryUrl ?? entry.url, text: '', status: 'unavailable' as const, message: '本轮原始材料读取已达十条上限，保留候选待补材料。' }] });
  for (const entry of withMaterials) observed.set(entry.canonicalId, entry.fingerprint);
  options.onStage?.('筛选中');
  const cardsResult = await options.chat(dailyCardsMessages(options, withMaterials), options.signal);
  active(options); const result = parseDailyCards(cardsResult, withMaterials);
  options.onStage?.('准备写入'); active(options);
  return { items: withMaterials, cards: result.cards, sources: collected.sources, observations: observations(), noChanges: !result.cards.length, summary: result.summary };
}
