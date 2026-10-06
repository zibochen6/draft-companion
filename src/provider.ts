import * as http from 'node:http';
import * as https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import type { ChatMessage, ChatResult, ModelInfo, Provider } from './types';

export class ProviderError extends Error {
  constructor(public kind: string, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(object: JsonObject, name: string): unknown {
  return object[name];
}

function parseUnknownJson(text: string): unknown {
  const parse: (source: string) => unknown = JSON.parse;
  return parse(text);
}

/** Preserve the configured base path; a bare host is not silently given /v1. */
export function endpoint(baseUrl: string, resource: string): string {
  let url: URL;
  try { url = new URL(baseUrl.trim()); }
  catch { throw new ProviderError('format', 'Base URL 无效，请填写完整的 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new ProviderError('format', 'Base URL 仅支持 HTTP/HTTPS，不支持账户密码或片段。');
  }
  const suffix = resource.replace(/^\/+|\/+$/g, '');
  if (!/^[a-z\d_-]+(?:\/[a-z\d_-]+)*$/i.test(suffix)) {
    throw new ProviderError('format', '接口路径无效。');
  }
  const path = url.pathname.replace(/\/+$/g, '');
  url.pathname = path.endsWith(`/${suffix}`) ? path : `${path}/${suffix}`;
  return url.toString();
}

function cancelled(): ProviderError {
  return new ProviderError('cancelled', '已停止生成。');
}

function errorKind(status: number, body: string): string {
  let code = '';
  try {
    const parsed = parseUnknownJson(body);
    if (isJsonObject(parsed)) {
      const error = field(parsed, 'error');
      if (isJsonObject(error)) {
        code = [field(error, 'code'), field(error, 'type'), field(error, 'message')]
          .filter((value): value is string => typeof value === 'string')
          .join(' ')
          .toLowerCase();
      }
    }
  } catch { /* Do not surface raw provider bodies: they may repeat private content. */ }
  if (status === 401 || status === 403 || /invalid_api_key|authentication_error/.test(code)) return 'auth';
  if (status === 413 || /context_length|context window|maximum context|too_many_tokens|token limit/.test(code)) return 'context';
  if ([301, 302, 303, 307, 308, 404, 405, 501].includes(status) || /unsupported_parameter|not_supported/.test(code)) return 'unsupported';
  return 'service';
}

function serviceError(status: number, body: string): ProviderError {
  const kind = errorKind(status, body);
  const messages: Record<string, string> = {
    auth: '认证失败，请检查密钥引用及模型服务的访问权限。',
    context: '模型上下文不足，服务拒绝了本次完整上下文。请换用更大上下文的模型或开始新会话。',
    unsupported: status >= 300 && status < 400
      ? '接口返回重定向，请检查 Base URL。插件不会把密钥转发到重定向地址。'
      : '服务不支持这个接口或请求设置，请检查 Base URL；模型列表不可用时可手动填写模型 ID。',
    service: status === 429
      ? '服务请求过于频繁或额度不足，请稍后再试并检查服务账户。'
      : `模型服务返回错误${status ? `（HTTP ${status}）` : ''}，请稍后重试或检查模型配置。`,
  };
  return new ProviderError(kind, messages[kind] ?? '模型服务返回错误，请检查模型配置。');
}

interface TransportResult { status: number; text: string }
interface RequestOptions {
  url: string; method: 'GET' | 'POST'; key?: string; body?: string;
  timeoutMs: number; signal?: AbortSignal; onText?: (text: string) => boolean;
}

/** Node transport works in the desktop host without browser CORS restrictions. */
function request(options: RequestOptions): Promise<TransportResult> {
  if (options.signal?.aborted) return Promise.reject(cancelled());
  if (options.key && /[\r\n]/.test(options.key)) {
    return Promise.reject(new ProviderError('auth', '密钥包含换行，请重新保存有效的密钥。'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    let decodedStream: Readable | undefined;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) {
        clearNodeTimeout(timer);
        timer = undefined;
      }
      options.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: ProviderError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      decodedStream?.destroy();
      response?.destroy();
      req?.destroy();
    };
    const complete = (result: TransportResult, close = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
      if (close) {
        decodedStream?.destroy();
        response?.destroy();
        req?.destroy();
      }
    };
    const abort = () => fail(cancelled());
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
    timer = setNodeTimeout(() => fail(new ProviderError('network', '请求超时，连接已中止。请检查网络或调整高级选项中的超时。')), timeout);
    const headers: Record<string, string> = { Accept: options.onText ? 'text/event-stream' : 'application/json', 'Accept-Encoding': 'identity' };
    if (options.key) headers.Authorization = `Bearer ${options.key}`;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    }
    try {
      const transport = options.url.startsWith('https:') ? https : http;
      req = transport.request(options.url, { method: options.method, headers }, res => {
        if (settled) { res.destroy(); return; }
        response = res;
        const status = res.statusCode ?? 0;
        const streaming = status >= 200 && status < 300 && !!options.onText;
        const decoder = new StringDecoder('utf8');
        let text = '';
        let bytes = 0;
        const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
        if (encoding === 'gzip') decodedStream = res.pipe(createGunzip());
        else if (encoding === 'deflate') decodedStream = res.pipe(createInflate());
        else if (encoding === 'br') decodedStream = res.pipe(createBrotliDecompress());
        else if (!encoding || encoding === 'identity') decodedStream = res;
        else { fail(new ProviderError('format', '服务返回的内容编码不兼容。')); return; }
        const consume = (chunk: string) => {
          if (!chunk || settled) return;
          if (streaming) {
            if (options.onText?.(chunk)) complete({ status, text: '' }, true);
          } else text += chunk;
        };
        decodedStream.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) { fail(new ProviderError('format', '服务返回内容过大，已停止接收。')); return; }
          try { consume(decoder.write(chunk)); }
          catch (error) { fail(error instanceof ProviderError ? error : new ProviderError('format', '服务返回的内容格式不兼容。')); }
        });
        decodedStream.on('end', () => {
          if (settled) return;
          try { consume(decoder.end()); }
          catch (error) { fail(error instanceof ProviderError ? error : new ProviderError('format', '服务返回的内容格式不兼容。')); return; }
          complete({ status, text });
        });
        decodedStream.on('error', () => fail(new ProviderError('network', '响应连接中断或内容解码失败，未完成生成。')));
        res.on('aborted', () => fail(new ProviderError('network', '响应连接提前关闭，未完成生成。')));
        res.on('error', () => fail(new ProviderError('network', '响应连接中断，未完成生成。')));
      });
      req.on('error', () => fail(new ProviderError('network', '网络连接失败，请检查 Base URL、网络及桌面端代理配置。')));
      req.end(options.body);
    } catch {
      fail(new ProviderError('network', '无法建立请求，请检查 Base URL 与连接配置。'));
    }
  });
}

function parseJson(text: string): JsonObject {
  let value: unknown;
  try { value = parseUnknownJson(text); }
  catch { throw new ProviderError('format', '服务返回的 JSON 格式不兼容。'); }
  if (!isJsonObject(value)) throw new ProviderError('format', '服务返回的 JSON 结构不兼容。');
  if (field(value, 'error')) throw serviceError(0, text);
  return value;
}

export async function listModels(provider: Provider, key: string | undefined, signal?: AbortSignal): Promise<ModelInfo[]> {
  const result = await request({ url: endpoint(provider.baseUrl, 'models'), method: 'GET', key, timeoutMs: provider.timeoutMs, signal });
  if (signal?.aborted) throw cancelled();
  if (result.status < 200 || result.status >= 300) throw serviceError(result.status, result.text);
  const parsed = parseJson(result.text);
  const data = field(parsed, 'data');
  if (!Array.isArray(data)) throw new ProviderError('format', '模型列表格式不兼容；可在高级选项中手动填写模型 ID。');
  const ids = new Set<string>();
  for (const row of data) {
    if (!isJsonObject(row)) {
      throw new ProviderError('format', '模型列表中的模型 ID 格式不兼容；可手动填写模型 ID。');
    }
    const id = field(row, 'id');
    if (typeof id !== 'string' || !id.trim()) {
      throw new ProviderError('format', '模型列表中的模型 ID 格式不兼容；可手动填写模型 ID。');
    }
    ids.add(id);
  }
  return [...ids].map(id => ({ id })).sort((a, b) => a.id.localeCompare(b.id));
}

class ChatStream {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private done = false;
  private result: ChatResult = { text: '', finishReason: '' };
  constructor(private onChunk: (text: string) => void) {}

  push(text: string): boolean {
    if (this.done) return true;
    this.buffer += text;
    if (this.buffer.length > MAX_RESPONSE_BYTES) throw new ProviderError('format', '流式事件过大，已停止接收。');
    let index: number;
    while (!this.done && (index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.line(line);
    }
    return this.done;
  }

  private line(line: string): void {
    if (!line) { this.dispatch(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') this.data.push(value);
    if (field === 'event') this.event = value;
  }

  private dispatch(): void {
    const body = this.data.join('\n');
    const event = this.event;
    this.data = []; this.event = '';
    if (!body) return;
    if (body.trim() === '[DONE]') {
      if (!this.result.finishReason) throw new ProviderError('format', '流式响应缺少完成原因，不能确认生成完整。');
      this.done = true; return;
    }
    if (event === 'error') throw serviceError(0, body);
    const parsed = parseJson(body);
    const choices = field(parsed, 'choices');
    if (!Array.isArray(choices)) throw new ProviderError('format', '流式响应缺少 choices，格式不兼容。');
    if (!choices.length) return; // Final usage events may have no choices.
    const choice = choices.find((row): row is JsonObject => isJsonObject(row) && (field(row, 'index') === 0 || field(row, 'index') === undefined));
    if (!choice) return;
    const delta = field(choice, 'delta');
    if (!isJsonObject(delta)) throw new ProviderError('format', '流式响应缺少 delta，格式不兼容。');
    const content = field(delta, 'content');
    if (content !== undefined && content !== null && typeof content !== 'string') throw new ProviderError('format', '流式正文格式不兼容。');
    if (typeof content === 'string' && content) {
      if (this.result.finishReason) throw new ProviderError('format', '流式响应在完成标记后继续返回正文。');
      this.result.text += content;
      this.onChunk(content);
    }
    const finishReason = field(choice, 'finish_reason');
    if (finishReason !== null && finishReason !== undefined) {
      if (typeof finishReason !== 'string' || !finishReason) throw new ProviderError('format', '流式完成原因格式不兼容。');
      this.result.finishReason = finishReason;
    }
  }

  finish(): ChatResult {
    if (!this.done) {
      if (this.buffer) { this.line(this.buffer.replace(/\r$/, '')); this.buffer = ''; }
      this.dispatch();
    }
    if (!this.result.finishReason) throw new ProviderError('format', '流式响应没有完整结束；请重试，或关闭流式后测试兼容性。');
    return { ...this.result };
  }
}

export async function chat(provider: Provider, key: string | undefined, messages: ChatMessage[], onChunk: (text: string) => void, signal: AbortSignal): Promise<ChatResult> {
  if (signal.aborted) throw cancelled();
  if (!provider.model.trim()) throw new ProviderError('format', '请先选择模型，或在高级选项中填写模型 ID。');
  const stream = provider.stream;
  const parser = new ChatStream(text => { if (!signal.aborted) onChunk(text); });
  const body = JSON.stringify({ model: provider.model, messages, stream });
  const result = await request({
    url: endpoint(provider.baseUrl, 'chat/completions'), method: 'POST', key, body,
    timeoutMs: provider.timeoutMs, signal, onText: stream ? text => parser.push(text) : undefined,
  });
  if (signal.aborted) throw cancelled();
  if (result.status < 200 || result.status >= 300) throw serviceError(result.status, result.text);
  if (stream) return parser.finish();
  const parsed = parseJson(result.text);
  const choices = field(parsed, 'choices');
  if (!Array.isArray(choices) || !choices.length) throw new ProviderError('format', '聊天响应缺少 choices，格式不兼容。');
  const choice: unknown = choices[0];
  if (!isJsonObject(choice)) {
    throw new ProviderError('format', '聊天响应缺少正文或完成原因，不能确认生成完整。');
  }
  const message = field(choice, 'message');
  const finishReason = field(choice, 'finish_reason');
  if (!isJsonObject(message) || typeof field(message, 'content') !== 'string'
    || typeof finishReason !== 'string' || !finishReason) {
    throw new ProviderError('format', '聊天响应缺少正文或完成原因，不能确认生成完整。');
  }
  const content = field(message, 'content');
  if (typeof content !== 'string') {
    throw new ProviderError('format', '聊天响应缺少正文或完成原因，不能确认生成完整。');
  }
  onChunk(content);
  if (signal.aborted) throw cancelled();
  return { text: content, finishReason };
}
