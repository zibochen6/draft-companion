import * as http from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { chat, endpoint, listModels, ProviderError } from '../src/provider';
import type { Provider } from '../src/types';

const servers: http.Server[] = [];
async function server(handler: http.RequestListener): Promise<string> {
  const instance = http.createServer(handler);
  servers.push(instance);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed');
  return `http://127.0.0.1:${address.port}/custom/v1`;
}
function provider(baseUrl: string, stream = true, timeoutMs = 2_000): Provider {
  return { id: 'test', name: 'Test', baseUrl, secretRef: 'test-secret', model: 'test-model', stream, timeoutMs };
}
function chunk(content: string | null, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\r\n\r\n`;
}
async function expectKind(promise: Promise<unknown>, kind: string): Promise<ProviderError> {
  try { await promise; throw new Error('Expected provider error'); }
  catch (error) { expect(error).toBeInstanceOf(ProviderError); expect((error as ProviderError).kind).toBe(kind); return error as ProviderError; }
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(instance => new Promise<void>(resolve => {
    instance.closeAllConnections(); instance.close(() => resolve());
  })));
});

describe('provider URLs and model discovery', () => {
  it('preserves base paths and never inserts v1', () => {
    expect(endpoint('https://example.com/proxy/openai/v1///', '/models')).toBe('https://example.com/proxy/openai/v1/models');
    expect(endpoint('https://example.com', 'chat/completions')).toBe('https://example.com/chat/completions');
    expect(endpoint('https://example.com/v1/models', 'models')).toBe('https://example.com/v1/models');
    expect(endpoint('https://example.com/custom?route=one', 'models')).toBe('https://example.com/custom/models?route=one');
    expect(() => endpoint('file:///tmp/data', 'models')).toThrow(ProviderError);
    expect(() => endpoint('https://user:password@example.com', 'models')).toThrow(ProviderError);
  });

  it('lists and deduplicates models, with authorization only in headers', async () => {
    const baseUrl = await server((req, res) => {
      expect(req.url).toBe('/custom/v1/models');
      expect(req.headers.authorization).toBe('Bearer fake-test-token');
      expect(req.method).toBe('GET');
      res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }));
    });
    await expect(listModels(provider(baseUrl), 'fake-test-token')).resolves.toEqual([{ id: 'model-a' }, { id: 'model-b' }]);
  });

  it.each([
    [401, { error: { message: 'fake-test-token' } }, 'auth'],
    [403, {}, 'permission'],
    [404, {}, 'unsupported'],
    [405, {}, 'unsupported'],
    [500, {}, 'service'],
    [429, {}, 'service'],
    [400, { error: { code: 'context_length_exceeded' } }, 'context'],
    [200, { models: ['other-shape'] }, 'format'],
    [200, { data: [{ name: 'no-id' }] }, 'format'],
    [200, { data: ['not-a-model-object'] }, 'format'],
  ])('classifies HTTP %s responses without exposing remote error content', async (status, body, kind) => {
    const baseUrl = await server((_req, res) => { res.statusCode = status; res.end(JSON.stringify(body)); });
    const error = await expectKind(listModels(provider(baseUrl), 'fake-test-token'), kind);
    expect(error.message).not.toContain('fake-test-token');
    expect(error.diagnostics).toMatchObject({ category: kind, stage: 'models', httpStatus: status });
  });

  it.each([
    [429, { code: 'insufficient_quota', message: 'Rate limit or private details' }, 'quota'],
    [403, { type: 'authentication_error', message: 'private details' }, 'auth'],
    [401, { code: 'permission_denied', message: 'private details' }, 'permission'],
    [400, { code: 'rate_limit_exceeded', message: 'private details' }, 'rate-limit'],
    [404, { code: 'model_not_found', message: 'private details' }, 'model-unavailable'],
    [400, { code: 'model_not_supported', message: 'private details' }, 'model-unavailable'],
    [500, { type: 'invalid_request_error', message: 'The model requested is not available' }, 'model-unavailable'],
    [400, { message: '账户余额不足，请充值。' }, 'quota'],
    [400, { message: '当前账户没有权限访问。' }, 'permission'],
    [400, { message: '请求过于频繁，请稍后再试。' }, 'rate-limit'],
    [500, { code: 'request_timeout', message: 'private details' }, 'timeout'],
    [400, { type: 'upstream_connection_error', message: 'private details' }, 'connection'],
  ])('uses the actual service error over generic HTTP %s classification', async (status, remoteError, kind) => {
    let requests = 0;
    const privateDraft = 'PRIVATE_SYNTHETIC_DOCUMENT_不得记录';
    const baseUrl = await server((_req, res) => {
      requests++;
      res.statusCode = status;
      res.end(JSON.stringify({ error: { ...remoteError, privateDraft, authorization: 'Bearer fake-test-token' } }));
    });
    const error = await expectKind(chat(provider(baseUrl, false), 'fake-test-token', [], () => {}, new AbortController().signal), kind);
    expect(error.diagnostics).toEqual({ category: kind, stage: 'chat', httpStatus: status, code: kind.replaceAll('-', '_') });
    const exposed = JSON.stringify({ message: error.message, diagnostics: error.diagnostics });
    expect(exposed).not.toContain(privateDraft);
    expect(exposed).not.toContain('fake-test-token');
    expect(requests).toBe(1);
  });

  it('keeps an ambiguous 429 honest and never exposes an unknown remote error code', async () => {
    const baseUrl = await server((_req, res) => {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { code: 'fake-test-token-PRIVATE_DOCUMENT', message: 'Opaque failure' } }));
    });
    const error = await expectKind(listModels(provider(baseUrl), 'fake-test-token'), 'service');
    expect(error.message).toContain('未明确说明');
    expect(error.diagnostics).toEqual({ category: 'service', stage: 'models', httpStatus: 429, code: 'service' });
    expect(JSON.stringify(error)).not.toContain('fake-test-token');
    expect(JSON.stringify(error)).not.toContain('PRIVATE_DOCUMENT');
  });

  it('classifies explicit permission denial separately from missing models', async () => {
    const baseUrl = await server((_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'permission_denied', message: 'You do not have access to this model' } }));
    });
    const error = await expectKind(listModels(provider(baseUrl), undefined), 'permission');
    expect(error.diagnostics.code).toBe('permission');
  });

  it('classifies top-level compatible error fields without retaining their private message', async () => {
    const baseUrl = await server((_req, res) => {
      res.statusCode = 400;
      res.end(JSON.stringify({ code: 'insufficient_quota', message: 'PRIVATE_DOCUMENT fake-test-token' }));
    });
    const error = await expectKind(listModels(provider(baseUrl), 'fake-test-token'), 'quota');
    expect(JSON.stringify({ message: error.message, diagnostics: error.diagnostics })).not.toMatch(/PRIVATE_DOCUMENT|fake-test-token/);
  });

  it('rejects a redirect without making a second request', async () => {
    let requests = 0;
    const baseUrl = await server((_req, res) => { requests++; res.writeHead(302, { Location: '/stolen-key' }); res.end(); });
    await expectKind(listModels(provider(baseUrl), 'fake-test-token'), 'unsupported');
    expect(requests).toBe(1);
  });

  it('distinguishes invalid JSON and refused connections', async () => {
    const baseUrl = await server((_req, res) => res.end('<html>not JSON</html>'));
    await expectKind(listModels(provider(baseUrl), undefined), 'format');
    const error = await expectKind(listModels(provider('http://127.0.0.1:1', true, 500), undefined), 'connection');
    expect(error.diagnostics).toEqual({ category: 'connection', stage: 'models', code: 'connection_failed' });
  });

  it('cancels model discovery, closes its connection, and does not retry', async () => {
    let connected!: () => void, disconnected!: () => void;
    const ready = new Promise<void>(resolve => { connected = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    let requests = 0;
    const baseUrl = await server((_req, res) => {
      requests++; res.writeHead(200); res.flushHeaders(); connected();
      const timer = setTimeout(() => res.end(JSON.stringify({ data: [{ id: 'late-model' }] })), 500);
      res.on('close', () => { clearTimeout(timer); disconnected(); });
    });
    const abort = new AbortController();
    const pending = listModels(provider(baseUrl), undefined, abort.signal);
    await ready; abort.abort();
    await expectKind(pending, 'cancelled'); await closed;
    expect(requests).toBe(1);
  });

  it('times out model discovery and actively closes the connection', async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    let requests = 0;
    const baseUrl = await server((_req, res) => {
      requests++; res.writeHead(200); res.flushHeaders(); res.on('close', disconnected);
    });
    const error = await expectKind(listModels(provider(baseUrl, true, 100), undefined), 'timeout');
    expect(error.diagnostics).toMatchObject({ category: 'timeout', stage: 'models', code: 'request_timeout' });
    await closed; expect(requests).toBe(1);
  });
});

describe('chat transport', () => {
  it('classifies a streamed service error and stops without retry or executable output', async () => {
    let requests = 0;
    const baseUrl = await server((_req, res) => {
      requests++;
      res.end(`event: error\ndata: ${JSON.stringify({ error: { code: 'insufficient_quota', message: 'PRIVATE_DOCUMENT fake-test-token' } })}\n\n`);
    });
    const received: string[] = [];
    const error = await expectKind(chat(provider(baseUrl), 'fake-test-token', [], text => received.push(text), new AbortController().signal), 'quota');
    expect(error.diagnostics).toEqual({ category: 'quota', stage: 'chat', code: 'quota', httpStatus: 200 });
    expect(received).toEqual([]);
    expect(requests).toBe(1);
    expect(JSON.stringify({ message: error.message, diagnostics: error.diagnostics })).not.toMatch(/PRIVATE_DOCUMENT|fake-test-token/);
  });

  it('reports configuration failures without sending a request or exposing the invalid URL', async () => {
    const error = await expectKind(chat(provider('https://user:fake-test-token@example.com'), undefined, [], () => {}, new AbortController().signal), 'format');
    expect(error.diagnostics).toEqual({ category: 'format', stage: 'configuration', code: 'invalid_base_url' });
    expect(error.message).not.toContain('fake-test-token');
  });

  it('decodes fragmented Chinese UTF-8 and CRLF SSE and resolves before a lingering connection ends', async () => {
    const output = Buffer.from(`: comment\r\n\r\n${chunk('你好，')}${chunk('世界')}${chunk(null, 'stop')}data: [DONE]\r\n\r\n`);
    const baseUrl = await server((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= output.length) { clearInterval(timer); return; }
        res.write(output.subarray(offset, ++offset));
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    const received: string[] = [];
    await expect(chat(provider(baseUrl), undefined, [{ role: 'user', content: '中文请求' }], text => received.push(text), new AbortController().signal))
      .resolves.toEqual({ text: '你好，世界', finishReason: 'stop' });
    expect(received.join('')).toBe('你好，世界');
  });

  it('accepts a complete finish reason at EOF without DONE', async () => {
    const baseUrl = await server((_req, res) => res.end(chunk('正文') + chunk(null, 'stop')));
    await expect(chat(provider(baseUrl), undefined, [], () => {}, new AbortController().signal)).resolves.toEqual({ text: '正文', finishReason: 'stop' });
  });

  it.each(['length', 'content_filter'])('returns %s for the controller to reject incomplete edits', async reason => {
    const baseUrl = await server((_req, res) => res.end(chunk('半篇正文') + chunk(null, reason) + 'data: [DONE]\n\n'));
    await expect(chat(provider(baseUrl), undefined, [], () => {}, new AbortController().signal)).resolves.toEqual({ text: '半篇正文', finishReason: reason });
  });

  it.each([chunk('只有部分'), chunk('只有部分') + 'data: [DONE]\n\n', 'data: {broken}\n\n'])('rejects incomplete or malformed streams', async output => {
    const baseUrl = await server((_req, res) => res.end(output));
    await expectKind(chat(provider(baseUrl), undefined, [], () => {}, new AbortController().signal), 'format');
  });

  it('returns a validated non-stream response and sends only compatible fields', async () => {
    const baseUrl = await server((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        const body = Buffer.concat(parts).toString();
        expect(req.headers.authorization).toBe('Bearer fake-test-token');
        expect(req.url).toBe('/custom/v1/chat/completions');
        expect(body).not.toContain('fake-test-token');
        expect(JSON.parse(body)).toEqual({ model: 'test-model', messages: [{ role: 'user', content: '请讨论' }], stream: false });
        res.end(JSON.stringify({ choices: [{ message: { content: '讨论结果' }, finish_reason: 'stop' }] }));
      });
    });
    const received: string[] = [];
    await expect(chat(provider(baseUrl, false), 'fake-test-token', [{ role: 'user', content: '请讨论' }], text => received.push(text), new AbortController().signal))
      .resolves.toEqual({ text: '讨论结果', finishReason: 'stop' });
    expect(received).toEqual(['讨论结果']);
  });

  it('supports compressed compatible responses', async () => {
    const baseUrl = await server((_req, res) => { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(chunk('压缩正文') + chunk(null, 'stop') + 'data: [DONE]\n\n')); });
    await expect(chat(provider(baseUrl), undefined, [], () => {}, new AbortController().signal)).resolves.toEqual({ text: '压缩正文', finishReason: 'stop' });
  });

  it('fixes the model and messages when the request starts', async () => {
    let sent: unknown;
    const baseUrl = await server((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        sent = JSON.parse(Buffer.concat(parts).toString());
        res.end(JSON.stringify({ choices: [{ message: { content: '结果' }, finish_reason: 'stop' }] }));
      });
    });
    const configured = provider(baseUrl, false);
    const messages = [{ role: 'user' as const, content: '原请求' }];
    const pending = chat(configured, undefined, messages, () => {}, new AbortController().signal);
    configured.model = 'different-model';
    configured.baseUrl = 'http://127.0.0.1:1';
    messages[0]!.content = '后来改变的输入';
    await pending;
    expect(sent).toEqual({ model: 'test-model', messages: [{ role: 'user', content: '原请求' }], stream: false });
  });

  it.each([
    { choices: [{ message: { content: '正文' } }] },
    { choices: [{ message: { content: null }, finish_reason: 'stop' }] },
    { choices: ['not-a-choice-object'] },
    { choices: [] },
  ])('rejects incomplete non-stream response structures', async body => {
    const baseUrl = await server((_req, res) => res.end(JSON.stringify(body)));
    await expectKind(chat(provider(baseUrl, false), undefined, [], () => {}, new AbortController().signal), 'format');
  });

  it('does not deliver a late non-stream response after cancellation', async () => {
    const baseUrl = await server((_req, res) => {
      const timer = setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: '迟到结果' }, finish_reason: 'stop' }] })), 80);
      res.on('close', () => clearTimeout(timer));
    });
    const controller = new AbortController();
    const received: string[] = [];
    const pending = chat(provider(baseUrl, false), undefined, [], text => received.push(text), controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expectKind(pending, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received).toEqual([]);
  });

  it('aborts in-flight generation immediately and ignores late content', async () => {
    let closed = false;
    const baseUrl = await server((_req, res) => {
      res.write(chunk('第一段'));
      const timer = setTimeout(() => res.end(chunk('不应收到') + chunk(null, 'stop')), 80);
      res.on('close', () => { closed = true; clearTimeout(timer); });
    });
    const controller = new AbortController();
    const received: string[] = [];
    const pending = chat(provider(baseUrl), undefined, [], text => { received.push(text); controller.abort(); }, controller.signal);
    await expectKind(pending, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received).toEqual(['第一段']);
    expect(closed).toBe(true);
  });

  it('actively closes timed-out connections and does not retry', async () => {
    let requests = 0;
    let closed = false;
    const baseUrl = await server((_req, res) => { requests++; res.writeHead(200); res.flushHeaders(); res.on('close', () => { closed = true; }); });
    const error = await expectKind(chat(provider(baseUrl, true, 35), undefined, [], () => {}, new AbortController().signal), 'timeout');
    expect(error.diagnostics).toMatchObject({ category: 'timeout', stage: 'chat', code: 'request_timeout' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests).toBe(1);
    expect(closed).toBe(true);
  });

  it('rejects a premature socket close after partial output', async () => {
    const baseUrl = await server((_req, res) => { res.write(chunk('部分内容')); setTimeout(() => res.destroy(), 10); });
    const error = await expectKind(chat(provider(baseUrl), undefined, [], () => {}, new AbortController().signal), 'connection');
    expect(error.diagnostics).toMatchObject({ category: 'connection', stage: 'chat', code: 'response_interrupted' });
  });

  it('makes no request for an already cancelled signal', async () => {
    let requests = 0;
    const baseUrl = await server((_req, res) => { requests++; res.end(); });
    const controller = new AbortController(); controller.abort();
    await expectKind(chat(provider(baseUrl), undefined, [], () => {}, controller.signal), 'cancelled');
    expect(requests).toBe(0);
  });
});
