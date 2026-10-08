import { describe, expect, it, vi } from 'vitest';
import { fetchSource, SourceResponseCache, type PublicResponse, type PublicTransport } from '../src/daily-sources';

const url = 'https://aihot.news/api/v1/hot-topics';
const signal = () => new AbortController().signal;
const response = (text: string, etag = 'public-etag', source = url): PublicResponse => ({ status: 200, text, url: source, etag });

describe('bounded public response cache', () => {
  it('reuses complete Chinese content after 304 with no credentials in public requests', async () => {
    const cache = new SourceResponseCache();
    const request = vi.fn<PublicTransport>()
      .mockResolvedValueOnce(response('中文正文与 emoji 😀'))
      .mockResolvedValueOnce({ status: 304, text: '', url });
    expect((await fetchSource(url, signal(), { cache, request })).text).toBe('中文正文与 emoji 😀');
    expect((await fetchSource(url, signal(), { cache, request })).text).toBe('中文正文与 emoji 😀');
    expect(request.mock.calls[0]?.[0].etag).toBeUndefined();
    expect(request.mock.calls[1]?.[0].etag).toBe('public-etag');
    expect(request.mock.calls.every(([value]) => !('key' in value) && !('Authorization' in value))).toBe(true);
  });
  it('updates the cached body and ETag on a changed 200 response', async () => {
    const cache = new SourceResponseCache();
    const request = vi.fn<PublicTransport>()
      .mockResolvedValueOnce(response('第一版中文正文', 'v1'))
      .mockResolvedValueOnce(response('第二版中文正文与 😀', 'v2'))
      .mockResolvedValueOnce({ status: 304, text: '', url });
    await fetchSource(url, signal(), { cache, request });
    expect((await fetchSource(url, signal(), { cache, request })).text).toBe('第二版中文正文与 😀');
    expect((await fetchSource(url, signal(), { cache, request })).text).toBe('第二版中文正文与 😀');
    expect(request.mock.calls[2]?.[0].etag).toBe('v2'); expect(cache.size).toBe(1);
  });
  it('rejects 304 with no complete cached body, without retries', async () => {
    const request = vi.fn<PublicTransport>().mockResolvedValue({ status: 304, text: '', url });
    await expect(fetchSource(url, signal(), { cache: new SourceResponseCache(), request })).rejects.toMatchObject({ kind: 'http', status: 304 });
    expect(request).toHaveBeenCalledOnce();
  });
  it('evicts least recently used responses at the entry boundary and defaults to 128', () => {
    const cache = new SourceResponseCache(2), a = 'https://example.com/a', b = 'https://example.com/b', c = 'https://example.com/c';
    cache.set(a, response('a', 'a', a)); cache.set(b, response('b', 'b', b)); cache.get(a); cache.set(c, response('c', 'c', c));
    expect(cache.size).toBe(2); expect(cache.has(a)).toBe(true); expect(cache.has(b)).toBe(false); expect(cache.has(c)).toBe(true);
    const production = new SourceResponseCache();
    for (let index = 0; index < 129; index++) production.set(`https://example.com/${index}`, response(`公开内容 ${index}`));
    expect(production.size).toBe(128); expect(production.has('https://example.com/0')).toBe(false);
    expect(() => new SourceResponseCache(201)).toThrow(RangeError);
  });
  it('counts UTF-8 bytes, skips oversized responses, and resets accounting on clear', () => {
    const cache = new SourceResponseCache(2, 10), a = 'https://example.com/a', b = 'https://example.com/b';
    cache.set(a, response('中文', 'a', a)); cache.set(b, response('正文', 'b', b));
    expect(cache.size).toBe(1); expect(cache.has(a)).toBe(false); expect(cache.has(b)).toBe(true);
    cache.set(a, response('中文正文', 'a', a)); expect(cache.has(a)).toBe(false);
    cache.clear(); cache.set(a, response('中文', 'a', a)); expect(cache.size).toBe(1);
    cache.delete(a); cache.set(b, response('正文', 'b', b)); expect(cache.has(b)).toBe(true);
  });
  it('copies only successful public-response fields and refuses local URLs', () => {
    const cache = new SourceResponseCache();
    cache.set(url, { ...response('公开素材'), key: 'dummy-provider-credential', provider: { secretRef: 'dummy-reference' } } as PublicResponse);
    const cached = cache.get(url);
    expect(cached).not.toHaveProperty('key'); expect(cached).not.toHaveProperty('provider'); expect(JSON.stringify(cached)).not.toContain('dummy-provider-credential');
    cache.set('https://example.com/failed', { status: 403, text: 'failure', url: 'https://example.com/failed' });
    expect(cache.size).toBe(1);
    expect(() => cache.set('https://localhost/', response('bad'))).toThrow();
    expect(() => cache.set(url, response('bad', 'etag', 'http://127.0.0.1/private'))).toThrow();
  });
});
