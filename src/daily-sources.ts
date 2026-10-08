import * as http from 'node:http';
import * as https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import type { SourceItem, SourceMaterial, SourceStatus } from './daily-types';

export interface PublicRequest {
  url: string; signal: AbortSignal; timeoutMs?: number; maxBytes?: number;
  accept?: string; etag?: string;
}
export interface PublicResponse { status: number; text: string; url: string; etag?: string; contentType?: string }
export type PublicTransport = (request: PublicRequest) => Promise<PublicResponse>;
/** Public response bodies only. Never stores Provider settings or headers. */
export class SourceResponseCache extends Map<string, PublicResponse> {
  private bytes = 0;
  constructor(readonly maxEntries = 128, readonly maxBytes = 16 * 1024 * 1024) {
    super();
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 200 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Public source cache capacity is invalid.');
  }
  override get(raw: string): PublicResponse | undefined {
    const key = publicUrl(raw).toString(), value = super.get(key);
    if (value) { super.delete(key); super.set(key, value); }
    return value;
  }
  override set(raw: string, response: PublicResponse): this {
    const key = publicUrl(raw).toString(), url = publicUrl(response.url).toString();
    this.delete(key);
    const bytes = Buffer.byteLength(response.text, 'utf8');
    if (response.status < 200 || response.status >= 300 || bytes > this.maxBytes) return this;
    // Copy only the public-response shape; extra injected fields cannot retain
    // credentials or a model-service object in this cache.
    const value: PublicResponse = { status: response.status, text: response.text, url, ...(response.etag ? { etag: response.etag } : {}), ...(response.contentType ? { contentType: response.contentType } : {}) };
    super.set(key, value); this.bytes += bytes;
    while (this.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.keys().next().value!);
    return this;
  }
  override delete(raw: string): boolean {
    const key = publicUrl(raw).toString(), value = super.get(key);
    if (value) this.bytes -= Buffer.byteLength(value.text, 'utf8');
    return super.delete(key);
  }
  override clear(): void { super.clear(); this.bytes = 0; }
}
export interface SourceOptions {
  githubFallback?: boolean; request?: PublicTransport; now?: () => number;
  cache?: Map<string, PublicResponse>; timeoutMs?: number;
}
export interface SourceCollection { items: SourceItem[]; sources: SourceStatus[] }
export class DailySourceError extends Error {
  constructor(public kind: 'network' | 'timeout' | 'cancelled' | 'format' | 'blocked' | 'http', message: string, public status?: number) {
    super(message); this.name = 'DailySourceError';
  }
}
function active(signal: AbortSignal): void {
  if (signal.aborted) throw new DailySourceError('cancelled', '选题任务已停止。');
}

export function isPublicAddress(address: string): boolean {
  let value = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) === 6) value = new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, '');
  if (isIP(value) === 4) {
    const [a = 0, b = 0, c = 0] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(value) === 6) {
    // Public IPv6 unicast is 2000::/3. Reject mapped IPv4 and all local,
    // multicast, documentation and transition address ranges conservatively.
    return /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:') && !value.startsWith('2002:') && !value.startsWith('2001:0:') && !value.startsWith('2001:2:');
  }
  return false;
}
export function isProxyFakeAddress(address: string): boolean {
  let value = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) === 6) value = new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, '');
  if (isIP(value) === 4) { const [a, b] = value.split('.').map(Number); return a === 198 && (b === 18 || b === 19); }
  return isIP(value) === 6 && /^(?:2001:2:|2001:0002:)/.test(value);
}
export function isAllowedSourceAddress(address: string, hostname: string, protocol: string): boolean {
  // TUN clients use the reserved benchmarking range as synthetic DNS answers.
  // It is allowed only for a public hostname over TLS; certificate validation
  // remains enabled and an IP literal can never opt into this compatibility.
  const publicName = /^[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z\d-]{2,63}$/i.test(hostname) && !hostname.endsWith('.local') && !hostname.endsWith('.localhost') && !hostname.endsWith('.internal');
  return isPublicAddress(address) || (protocol === 'https:' && publicName && !isIP(hostname) && isProxyFakeAddress(address));
}
export function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new DailySourceError('blocked', '来源地址无效。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
      !host.includes('.') && !isIP(host) || isIP(host) && !isPublicAddress(host)) {
    throw new DailySourceError('blocked', '选题采集仅允许公开 HTTP/HTTPS 来源。');
  }
  url.hash = ''; return url;
}

/** Separate public transport: it never accepts or forwards a Provider key. */
export const requestPublic: PublicTransport = async options => {
  active(options.signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    let url = publicUrl(options.url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      active(options.signal);
      if (controller.signal.aborted) throw new DailySourceError('timeout', '公开来源读取超时。');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let addresses: { address: string; family: number }[];
      try {
        addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise((resolve, reject) => {
          const interrupted = () => reject(new DailySourceError(options.signal.aborted ? 'cancelled' : 'timeout', options.signal.aborted ? '选题任务已停止。' : '公开来源读取超时。'));
          controller.signal.addEventListener('abort', interrupted, { once: true });
          if (controller.signal.aborted) { interrupted(); return; }
          void lookup(host, { all: true }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', interrupted));
        });
      }
      catch (error) { if (error instanceof DailySourceError) throw error; throw new DailySourceError('network', '公开来源域名解析失败。'); }
      active(options.signal);
      if (controller.signal.aborted) throw new DailySourceError('timeout', '公开来源读取超时。');
      if (!addresses.length || addresses.some(entry => !isAllowedSourceAddress(entry.address, host, url.protocol))) throw new DailySourceError('blocked', '来源解析到非公开地址，已阻止访问。');
      const address = addresses[0]!;
      const result = await new Promise<PublicResponse & { location?: string }>((resolve, reject) => {
        let settled = false, stream: Readable | undefined, response: http.IncomingMessage | undefined;
        const cleanup = () => controller.signal.removeEventListener('abort', interrupted);
        const finish = (error?: Error, result?: PublicResponse & { location?: string }) => {
          if (settled) return; settled = true; cleanup();
          if (error) { reject(error); stream?.destroy(); response?.destroy(); req.destroy(); }
          else resolve(result!);
        };
        const interrupted = () => finish(new DailySourceError(options.signal.aborted ? 'cancelled' : 'timeout', options.signal.aborted ? '选题任务已停止。' : '公开来源读取超时。'));
        const headers: Record<string, string> = { Accept: options.accept ?? 'application/json, text/html;q=0.9, text/plain;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'Draft-Companion/0.4.0 (+https://github.com/zibochen6/draft-companion)' };
        if (options.etag) headers['If-None-Match'] = options.etag;
        const req = (url.protocol === 'https:' ? https : http).request(url, {
          method: 'GET', headers,
          // Pin the validated address; do not perform a second DNS lookup.
          family: address.family,
          lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        }, res => {
          response = res;
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            res.resume(); finish(undefined, { status, text: '', url: url.toString(), location: res.headers.location }); return;
          }
          const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
          if (encoding === 'gzip') stream = res.pipe(createGunzip());
          else if (encoding === 'deflate') stream = res.pipe(createInflate());
          else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
          else if (!encoding || encoding === 'identity') stream = res;
          else { finish(new DailySourceError('format', '公开来源使用了不支持的内容编码。')); return; }
          const decoder = new StringDecoder('utf8'); let text = '', bytes = 0;
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) { finish(new DailySourceError('format', '公开来源内容过大，已停止读取。')); return; }
            text += decoder.write(chunk);
          });
          stream.on('end', () => finish(undefined, { status, text: text + decoder.end(), url: url.toString(), etag: res.headers.etag, contentType: res.headers['content-type'] }));
          stream.on('error', () => finish(new DailySourceError('network', '公开来源连接中断。')));
          res.on('aborted', () => finish(new DailySourceError('network', '公开来源连接提前关闭。')));
        });
        req.on('error', () => finish(new DailySourceError('network', '无法连接公开来源。')));
        controller.signal.addEventListener('abort', interrupted, { once: true });
        if (controller.signal.aborted) { interrupted(); return; }
        req.end();
      });
      active(options.signal);
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.location || redirects === 3) throw new DailySourceError('http', '公开来源重定向次数过多或地址缺失。', result.status);
        url = publicUrl(new URL(result.location, url).toString()); continue;
      }
      return result;
    }
    throw new DailySourceError('http', '公开来源重定向未完成。');
  } finally { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); }
};

export async function fetchSource(url: string, signal: AbortSignal, options: SourceOptions = {}, accept?: string): Promise<PublicResponse> {
  const safe = publicUrl(url).toString();
  const cached = options.cache?.get(safe);
  for (let attempt = 0; attempt < 2; attempt++) {
    active(signal);
    try {
      const response = await (options.request ?? requestPublic)({ url: safe, signal, timeoutMs: options.timeoutMs, accept, etag: cached?.etag });
      active(signal);
      publicUrl(response.url); // An injected adapter must also report a public final URL.
      if (response.status === 304 && cached) return cached;
      if (response.status < 200 || response.status >= 300) throw new DailySourceError('http', `来源返回 HTTP ${response.status}。`, response.status);
      options.cache?.set(safe, response); return response;
    } catch (error) {
      active(signal);
      const retry = error instanceof DailySourceError && (error.kind === 'network' || error.kind === 'timeout' || (error.status !== undefined && error.status >= 500));
      if (attempt || !retry) throw error;
    }
  }
  throw new DailySourceError('network', '公开来源读取失败。');
}

function obj(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function excerpt(value: string, limit: number): string {
  let end = Math.min(value.length, limit);
  const last = value.charCodeAt(end - 1);
  if ((last >= 0xd800 && last <= 0xdbff && end < value.length) || (value[end - 1] === '\r' && value[end] === '\n')) end--;
  return value.slice(0, end);
}
function str(value: unknown, limit = 4000): string { return typeof value === 'string' ? excerpt(value.trim(), limit) : ''; }
function json(text: string): Record<string, unknown> {
  try { const value = obj(JSON.parse(text)); if (value) return value; } catch { /* Classify rather than exposing a remote response. */ }
  throw new DailySourceError('format', '公开来源返回的 JSON 无效。');
}
export function normalizeSourceUrl(raw: string): string {
  const url = publicUrl(raw); url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort(); return url.toString();
}
export function canonicalRepository(raw: string): string | undefined {
  try {
    const url = publicUrl(raw);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const match = /^\/([\w.-]+)\/([\w.-]+)(?:\/|$)/.exec(url.pathname);
    if (!match || ['topics', 'search', 'collections', 'settings', 'features', 'marketplace'].includes(match[1]!.toLowerCase())) return undefined;
    return `${match[1]}/${match[2]!.replace(/\.git$/, '')}`.toLowerCase();
  } catch { return undefined; }
}
export function sourceFingerprint(item: Pick<SourceItem, 'title' | 'summary' | 'primaryUrl' | 'url' | 'repository'>): string {
  // Time, rankings and star counts intentionally do not affect a fact fingerprint.
  const summary = item.summary.replace(/\b(?:stars?|watchers?|forks?)\s*[:：]?\s*[\d,.]+[kKmM]?|[\d,.]+\s*(?:stars?|星标)|[⭐★]\s*[\d,.]+[kKmM]?/gi, '')
    .replace(/(?:更新时间|updated at|last updated)\s*[:：]?\s*\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?Z?)?/gi, '').trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(JSON.stringify([item.title.trim(), summary, normalizeSourceUrl(item.primaryUrl ?? item.url), item.repository ?? ''])).digest('hex');
}
export function splitFactFingerprint(value: string): { list: string; material?: string } {
  const match = /^v1:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(value);
  return match ? { list: match[1]!, material: match[2]! } : { list: value };
}
export function withMaterialFingerprint(entry: SourceItem): SourceItem {
  const verified = (entry.materials ?? []).filter(material => material.status === 'verified');
  if (!verified.length) return entry;
  const substantive = verified.map(material => material.text
    .replace(/!?\[[^\]\n]*\]\(https?:\/\/[^\s)]*(?:shields\.io|badge|visitor|stargazers)[^)]*\)/gi, '')
    .split('\n').filter(line => !/^\s*(?:last updated|updated at|更新时间|访问(?:量|次数)|view(?:s| count)?|star(?:s| count)?)\s*[:：]/i.test(line)).join('\n')
    .replace(/\s+/g, ' ').trim());
  const material = createHash('sha256').update(JSON.stringify(substantive)).digest('hex');
  return { ...entry, fingerprint: `v1:${splitFactFingerprint(entry.fingerprint).list}:${material}` };
}
function sourceId(canonicalId: string): string { return `source_${createHash('sha256').update(canonicalId).digest('hex').slice(0, 20)}`; }
function item(value: Omit<SourceItem, 'id' | 'fingerprint'>): SourceItem { return { ...value, id: sourceId(value.canonicalId), fingerprint: sourceFingerprint(value) }; }
function cleanHtml(html: string): string {
  return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|tr)>/gi, '\n').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_all, digits: string) => { const code = digits[0]!.toLowerCase() === 'x' ? parseInt(digits.slice(1), 16) : parseInt(digits, 10); return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' '; })
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity] ?? ' ')
    .replace(/[\t ]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
export function parseGitStars(html: string): SourceItem[] {
  const result: SourceItem[] = [], seen = new Set<string>();
  const anchors = [...html.matchAll(/<a\b[^>]*href=["'](https:\/\/github\.com\/[^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index]!, repository = canonicalRepository(anchor[1]!);
    if (!repository || seen.has(repository)) continue;
    seen.add(repository);
    const start = (anchor.index ?? 0) + anchor[0].length;
    const end = Math.min(start + 1800, anchors[index + 1]?.index ?? html.length);
    const description = cleanHtml(html.slice(start, end)).slice(0, 1200);
    const title = cleanHtml(anchor[2]!) || repository;
    result.push(item({ canonicalId: `repository:${repository}`, kind: 'repository', repository, title, summary: description, url: `https://github.com/${repository}`, source: 'Git Stars', metadata: { discovery: 'created-order' } }));
  }
  if (!result.length) throw new DailySourceError('format', 'Git Stars 页面中没有可识别的仓库条目。');
  return result;
}
export function parseGithub(text: string): SourceItem[] {
  const root = json(text);
  if (!Array.isArray(root.items)) throw new DailySourceError('format', 'GitHub 仓库列表结构不兼容。');
  return root.items.flatMap(value => {
    const row = obj(value); if (!row) return [];
    const repository = canonicalRepository(str(row.html_url));
    if (!repository || typeof row.full_name !== 'string') return [];
    return [item({ canonicalId: `repository:${repository}`, kind: 'repository', repository, title: str(row.full_name, 200), summary: str(row.description, 2000), url: `https://github.com/${repository}`, source: 'GitHub（Git Stars 受阻后的补充）', createdAt: str(row.created_at, 50) || undefined, stars: typeof row.stargazers_count === 'number' ? row.stargazers_count : undefined, metadata: { discovery: 'repository-search' } })];
  });
}
function aiHotRows(text: string, hot: boolean): { items: SourceItem[]; nextCursor?: string } {
  const root = json(text);
  if (root.schemaVersion !== 1 || !Array.isArray(root.items)) throw new DailySourceError('format', 'AIHOT API 版本或列表结构不兼容。');
  const items = root.items.flatMap(value => {
    const row = obj(value), links = row && obj(row.links); if (!row || !links) return [];
    const title = str(row.title, 500), url = str(links.aihot), original = str(links.original);
    if (!title || !url || !original || !str(row.id, 100)) return [];
    try {
      publicUrl(url); const normalized = normalizeSourceUrl(original), repository = canonicalRepository(original);
      const source = obj(row.source), canonicalId = repository ? `repository:${repository}` : `news:${normalized}`;
      return [item({ canonicalId, kind: repository ? 'repository' : 'news', repository, title, summary: str(row.summary), url, primaryUrl: original, source: 'AIHOT', sourceIds: [str(row.id, 100)], publishedAt: str(row.publishedAt, 50) || undefined,
        metadata: { channel: hot ? 'hot-topics' : 'selected', attribution: str(source?.name, 300), ...(hot && typeof row.rank === 'number' ? { rank: row.rank } : {}), ...(str(links.story) ? { story: str(links.story) } : {}) } })];
    } catch { return []; }
  });
  const page = obj(root.page), nextCursor = page?.hasMore === true ? str(page.nextCursor, 1000) : '';
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}
export function parseAiHot(text: string, hot = false): SourceItem[] { return aiHotRows(text, hot).items; }
export function mergeSourceItems(inputs: SourceItem[]): SourceItem[] {
  const byCanonical = new Map<string, SourceItem>();
  const stories = new Map<string, string>(), originalEvents = new Map<string, string>();
  // The deployment currently emits old-domain story links. Treat the returned
  // story ID as an event grouping hint; never fetch that old domain implicitly.
  for (const value of inputs) {
    const story = typeof value.metadata?.story === 'string' ? /\/story\/([\w-]+)$/.exec(value.metadata.story)?.[1] : undefined;
    if (story && value.kind === 'news') {
      const eventId = `news:aihot-story:${story}`;
      stories.set(story, eventId); originalEvents.set(normalizeSourceUrl(value.primaryUrl ?? value.url), eventId);
    }
  }
  for (const original of inputs) {
    const story = typeof original.metadata?.story === 'string' ? /\/story\/([\w-]+)$/.exec(original.metadata.story)?.[1] : undefined;
    const canonicalId = original.kind === 'news' ? (story ? stories.get(story) : undefined) ?? originalEvents.get(normalizeSourceUrl(original.primaryUrl ?? original.url)) ?? original.canonicalId : original.canonicalId;
    const value = { ...original, canonicalId, id: sourceId(canonicalId) };
    const existing = byCanonical.get(canonicalId);
    if (!existing) { byCanonical.set(canonicalId, value); continue; }
    const merged = { ...existing, summary: existing.summary || value.summary, source: [...new Set([...existing.source.split(' / '), value.source])].join(' / '), sourceIds: [...new Set([...(existing.sourceIds ?? []), ...(value.sourceIds ?? [])])], metadata: { ...value.metadata, ...existing.metadata } };
    merged.fingerprint = sourceFingerprint(merged); byCanonical.set(canonicalId, merged);
  }
  return [...byCanonical.values()];
}
export async function collectSources(signal: AbortSignal, options: SourceOptions = {}): Promise<SourceCollection> {
  const now = options.now ?? Date.now;
  const status = (name: string, state: SourceStatus['status'], message: string): SourceStatus => ({ name, status: state, message, at: now() });
  const groups = await Promise.all([
    (async (): Promise<SourceCollection> => {
      let gathered: SourceItem[] = [];
      try {
        for (let page = 1; page <= 2; page++) gathered.push(...parseGitStars((await fetchSource(`https://git-stars.org/zh/repositories/topic/ai?page=${page}&sort=created`, signal, options, 'text/html')).text));
        return { items: gathered, sources: [status('Git Stars', 'success', `读取 ${gathered.length} 条仓库发现；按创建时间排序，不代表热度。`)] };
      } catch (error) {
        active(signal);
        const failed = status('Git Stars', 'failed', error instanceof DailySourceError ? error.message : 'Git Stars 读取失败。');
        if (!options.githubFallback) return { items: gathered, sources: [failed] };
        try {
          const date = new Date(now() - 90 * 86400000).toISOString().slice(0, 10);
          const query = `topic:ai stars:>=500 pushed:>=2024-01-01 created:>=${date} fork:false archived:false`;
          for (let page = 1; page <= 2; page++) {
            const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=50&page=${page}`;
            const rows = parseGithub((await fetchSource(url, signal, options, 'application/vnd.github+json')).text);
            gathered.push(...rows); if (rows.length < 50) break;
          }
          gathered.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
          return { items: gathered, sources: [failed, status('GitHub', 'fallback', 'Git Stars 受阻，使用 GitHub 官方仓库搜索补充；不是 Git Stars 榜单。')] };
        } catch (fallbackError) { active(signal); return { items: gathered, sources: [failed, status('GitHub', 'failed', fallbackError instanceof DailySourceError ? fallbackError.message : 'GitHub 补充读取失败。')] }; }
      }
    })(),
    (async (): Promise<SourceCollection> => {
      const gathered: SourceItem[] = [], sources: SourceStatus[] = [];
      try {
        let cursor: string | undefined;
        for (let page = 0; page < 2; page++) {
          const url = `https://aihot.news/api/v1/items?mode=selected&window=24h&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const parsed = aiHotRows((await fetchSource(url, signal, options)).text, false);
          gathered.push(...parsed.items); cursor = parsed.nextCursor; if (!cursor) break;
        }
        sources.push(status('AIHOT 精选', 'success', '已读取最近 24 小时精选。'));
      } catch (error) { active(signal); sources.push(status('AIHOT 精选', 'failed', error instanceof DailySourceError ? error.message : 'AIHOT 精选读取失败。')); }
      try {
        gathered.push(...parseAiHot((await fetchSource('https://aihot.news/api/v1/hot-topics', signal, options)).text, true));
        sources.push(status('AIHOT 热点', 'success', '已读取当前事件热点排序。'));
      } catch (error) { active(signal); sources.push(status('AIHOT 热点', 'failed', error instanceof DailySourceError ? error.message : 'AIHOT 热点读取失败。')); }
      return { items: gathered, sources };
    })(),
  ]);
  active(signal); return { items: mergeSourceItems(groups.flatMap(group => group.items)), sources: groups.flatMap(group => group.sources) };
}

export async function readMaterials(items: SourceItem[], signal: AbortSignal, options: SourceOptions = {}): Promise<SourceItem[]> {
  if (items.length > 10) throw new DailySourceError('format', '原始材料候选超过十条。');
  const result: SourceItem[] = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++, entry = items[index]!; active(signal);
      const url = entry.repository ? `https://api.github.com/repos/${entry.repository}/readme` : entry.primaryUrl ?? entry.url;
      let material: SourceMaterial;
      try {
        if (publicUrl(url).protocol !== 'https:') throw new DailySourceError('blocked', '原始材料必须使用公开 HTTPS 地址。');
        const response = await fetchSource(url, signal, options, entry.repository ? 'application/vnd.github.raw+json' : 'text/html, text/plain;q=0.9');
        if (/application\/(?:pdf|octet-stream)|image\//i.test(response.contentType ?? '')) throw new DailySourceError('format', '原始材料是不可读取的二进制内容。');
        const extracted = /text\/html/i.test(response.contentType ?? '') || /^\s*<!doctype html|^\s*<html/i.test(response.text) ? cleanHtml(response.text) : response.text.trim();
        if (!extracted.trim()) throw new DailySourceError('format', '原始材料没有可读取文本。');
        material = { url: response.url, title: entry.title, text: excerpt(extracted, 8000), status: 'verified', truncated: extracted.length > 8000,
          ...(extracted.length > 8000 ? { message: '仅读取开头 8000 字符，未宣称读完全文。' } : {}) };
      } catch (error) {
        active(signal); material = { url, text: '', status: 'unavailable', message: error instanceof DailySourceError ? error.message : '原始材料读取失败。' };
      }
      result[index] = { ...entry, materials: [material] };
    }
  }));
  active(signal); return result;
}
