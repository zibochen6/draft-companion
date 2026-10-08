import * as http from 'node:http';
import * as https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import type { ChatMessage, ChatResult, ModelInfo, Provider, ToolCall, ToolDefinition } from './types';

export type ProviderStage = 'configuration' | 'models' | 'chat';
export interface ProviderDiagnostics {
  category: string;
  httpStatus?: number;
  /** A plugin-generated classification code, never an unchecked remote field. */
  code?: string;
  stage?: ProviderStage;
}

export class ProviderError extends Error {
  readonly diagnostics: ProviderDiagnostics;
  constructor(public kind: string, message: string, details: Omit<ProviderDiagnostics, 'category'> = {}) {
    super(message);
    this.name = 'ProviderError';
    this.diagnostics = { ...details, category: kind };
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
  catch { throw new ProviderError('format', 'Base URL 无效，请填写完整的 HTTP 或 HTTPS 地址。', { stage: 'configuration', code: 'invalid_base_url' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new ProviderError('format', 'Base URL 仅支持 HTTP/HTTPS，不支持账户密码或片段。', { stage: 'configuration', code: 'invalid_base_url' });
  }
  const suffix = resource.replace(/^\/+|\/+$/g, '');
  if (!/^[a-z\d_-]+(?:\/[a-z\d_-]+)*$/i.test(suffix)) {
    throw new ProviderError('format', '接口路径无效。', { stage: 'configuration', code: 'invalid_resource_path' });
  }
  const path = url.pathname.replace(/\/+$/g, '');
  url.pathname = path.endsWith(`/${suffix}`) ? path : `${path}/${suffix}`;
  return url.toString();
}

function cancelled(stage?: ProviderStage): ProviderError {
  return new ProviderError('cancelled', '已停止生成。', { stage, code: 'cancelled' });
}

/** Inspect remote details only to classify; never expose the body or unknown codes. */
function errorKind(status: number, body: string): string {
  let identifiers = '', message = '';
  try {
    const parsed = parseUnknownJson(body);
    if (isJsonObject(parsed)) {
      const nested = field(parsed, 'error');
      const error = isJsonObject(nested) ? nested : parsed;
      identifiers = [field(error, 'code'), field(error, 'type')]
          .filter((value): value is string => typeof value === 'string')
          .join(' ')
          .toLowerCase();
      const detail = field(error, 'message');
      message = typeof detail === 'string' ? detail.toLowerCase() : typeof nested === 'string' ? nested.toLowerCase() : '';
    }
  } catch { /* Do not surface raw provider bodies: they may repeat private content. */ }
  const classify = (detail: string): string | undefined => {
    if (/insufficient[_ -](?:quota|credit|balance)|quota[_ -](?:exceeded|exhausted)|billing[_ -](?:hard[_ -]limit|limit|error)|credit[_ -](?:balance|exhausted)|payment[_ -]required|balance[_ -](?:insufficient|not[_ -]enough)|exceeded your current quota|insufficient funds|(?:额度|余额).*(?:不足|耗尽|用尽)|欠费/.test(detail)) return 'quota';
    if (/invalid[_ -](?:api[_ -]key|token)|incorrect api key|authentication[_ -](?:error|failed|required)|unauthorized|(?:密钥|令牌).*(?:无效|失效)|认证失败/.test(detail)) return 'auth';
    if (/permission[_ -](?:denied|error)|access[_ -]denied|forbidden|not[_ -]authorized|do(?:es)? not have access|无权访问|权限不足|没有权限/.test(detail)) return 'permission';
    if (/model[_ -](?:not[_ -]found|not[_ -]exist|unavailable|disabled|not[_ -]available|not[_ -]supported|does[_ -]not[_ -]exist)|no such model|model[^\n]{0,100}(?:does not exist|not found|is not available|is unavailable|not supported)|(?:不存在|不可用|未找到|已停用).{0,12}模型|模型.{0,30}(?:不存在|不可用|未找到|已停用)/.test(detail)) return 'model-unavailable';
    if (/context[_ -]length|context window|maximum context|too[_ -]many[_ -]tokens|token limit|上下文.{0,12}(?:超过|超出|不足)|上下文长度/.test(detail)) return 'context';
    if (/rate[_ -]limit|too[_ -]many[_ -]requests|requests per minute|请求.{0,12}(?:频繁|限流)|速率限制/.test(detail)) return 'rate-limit';
    if (/request[_ -]timeout|gateway[_ -]timeout|deadline[_ -]exceeded|timed?[_ -]out|请求超时|响应超时/.test(detail)) return 'timeout';
    if (/connection[_ -](?:error|failed|refused)|connect[_ -]error|upstream[_ -]connection|连接失败|连接中断/.test(detail)) return 'connection';
    if (/unsupported[_ -]parameter|not[_ -]supported|unsupported[_ -](?:endpoint|operation|api)|unrecognized request argument/.test(detail)) return 'unsupported';
    return undefined;
  };
  // Explicit codes/types take precedence over prose and generic HTTP status.
  const classified = classify(identifiers) ?? classify(message);
  if (classified) return classified;
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 402) return 'quota';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 413) return 'context';
  // Bare 429 does not tell us whether the cause is rate or credit exhaustion.
  if (status === 429) return 'service';
  if ([301, 302, 303, 307, 308, 404, 405, 501].includes(status)) return 'unsupported';
  return 'service';
}

function serviceError(status: number, body: string, stage: ProviderStage): ProviderError {
  const kind = errorKind(status, body);
  const messages: Record<string, string> = {
    auth: '服务认证失败，请检查已有密钥配置。',
    permission: '当前账户没有本次请求的访问权限，请检查服务权限。',
    'rate-limit': '服务限制了请求频率，请稍后重试。',
    quota: '服务额度或账户余额不足，请检查服务账户。',
    'model-unavailable': '当前模型不可用，请检查模型 ID、启用状态和访问权限。',
    timeout: '服务未在时限内完成请求，请稍后重试或检查超时配置。',
    connection: '服务报告连接失败，请检查服务状态和网络后重试。',
    context: '模型上下文不足，服务拒绝了本次完整上下文。请换用更大上下文的模型或开始新会话。',
    unsupported: status >= 300 && status < 400
      ? '接口返回重定向，请检查 Base URL。插件不会把密钥转发到重定向地址。'
      : '服务不支持这个接口或请求设置，请检查 Base URL；模型列表不可用时可手动填写模型 ID。',
    service: status === 429
      ? '服务拒绝了请求（HTTP 429），未明确说明限流或额度原因。请检查服务账户后重试。'
      : `模型服务返回错误${status ? `（HTTP ${status}）` : ''}，请稍后重试或检查模型配置。`,
  };
  return new ProviderError(kind, messages[kind] ?? '模型服务返回错误，请检查模型配置。', {
    stage, ...(status > 0 ? { httpStatus: status } : {}), code: kind.replaceAll('-', '_'),
  });
}

function formatError(message: string, stage: ProviderStage, httpStatus?: number): ProviderError {
  return new ProviderError('format', message, { stage, httpStatus, code: 'invalid_response' });
}

interface TransportResult { status: number; text: string }
export interface ChatOptions {
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  parallelToolCalls?: boolean;
}
interface RequestOptions {
  url: string; method: 'GET' | 'POST'; key?: string; body?: string;
  timeoutMs: number; signal?: AbortSignal; onText?: (text: string) => boolean; stage: ProviderStage;
}

/** Node transport works in the desktop host without browser CORS restrictions. */
function request(options: RequestOptions): Promise<TransportResult> {
  if (options.signal?.aborted) return Promise.reject(cancelled(options.stage));
  if (options.key && /[\r\n]/.test(options.key)) {
    return Promise.reject(new ProviderError('auth', '密钥包含换行，请重新保存有效的密钥。', { stage: 'configuration', code: 'invalid_credential' }));
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
      reject(response?.statusCode && error.diagnostics.httpStatus === undefined
        ? new ProviderError(error.kind, error.message, { ...error.diagnostics, httpStatus: response.statusCode })
        : error);
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
    const abort = () => fail(cancelled(options.stage));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
    timer = setNodeTimeout(() => fail(new ProviderError('timeout', '请求超时，连接已中止。可检查网络或调整请求超时。', { stage: options.stage, code: 'request_timeout' })), timeout);
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
        else { fail(formatError('服务返回的内容编码不兼容。', options.stage, status)); return; }
        const consume = (chunk: string) => {
          if (!chunk || settled) return;
          if (streaming) {
            if (options.onText?.(chunk)) complete({ status, text: '' }, true);
          } else text += chunk;
        };
        decodedStream.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) { fail(formatError('服务返回内容过大，已停止接收。', options.stage, status)); return; }
          try { consume(decoder.write(chunk)); }
          catch (error) { fail(error instanceof ProviderError ? error : formatError('服务返回的内容格式不兼容。', options.stage, status)); }
        });
        decodedStream.on('end', () => {
          if (settled) return;
          try { consume(decoder.end()); }
          catch (error) { fail(error instanceof ProviderError ? error : formatError('服务返回的内容格式不兼容。', options.stage, status)); return; }
          complete({ status, text });
        });
        decodedStream.on('error', () => fail(new ProviderError('connection', '响应连接中断或内容解码失败，未完成生成。', { stage: options.stage, httpStatus: status, code: 'response_interrupted' })));
        res.on('aborted', () => fail(new ProviderError('connection', '响应连接提前关闭，未完成生成。', { stage: options.stage, httpStatus: status, code: 'response_interrupted' })));
        res.on('error', () => fail(new ProviderError('connection', '响应连接中断，未完成生成。', { stage: options.stage, httpStatus: status, code: 'response_interrupted' })));
      });
      req.on('error', () => fail(new ProviderError('connection', '无法连接服务，请检查 API 地址、网络及桌面端代理配置。', { stage: options.stage, code: 'connection_failed' })));
      req.end(options.body);
    } catch {
      fail(new ProviderError('connection', '无法建立请求，请检查 API 地址与连接配置。', { stage: options.stage, code: 'connection_failed' }));
    }
  });
}

function parseJson(text: string, stage: ProviderStage, httpStatus?: number): JsonObject {
  let value: unknown;
  try { value = parseUnknownJson(text); }
  catch { throw formatError('服务返回的 JSON 格式不兼容。', stage, httpStatus); }
  if (!isJsonObject(value)) throw formatError('服务返回的 JSON 结构不兼容。', stage, httpStatus);
  if (field(value, 'error')) throw serviceError(httpStatus ?? 0, text, stage);
  return value;
}

function toolFormatError(httpStatus?: number): ProviderError {
  return formatError('工具调用格式不完整或不兼容。', 'chat', httpStatus);
}

/** A tool call is usable only when its identity, function and JSON object arguments are complete. */
function validateToolCall(value: unknown, httpStatus?: number): ToolCall {
  if (!isJsonObject(value)) throw toolFormatError(httpStatus);
  const id = field(value, 'id');
  const type = field(value, 'type');
  const functionValue = field(value, 'function');
  if (typeof id !== 'string' || !id || type !== 'function' || !isJsonObject(functionValue)) throw toolFormatError(httpStatus);
  const name = field(functionValue, 'name');
  const argumentsText = field(functionValue, 'arguments');
  if (typeof name !== 'string' || !name || typeof argumentsText !== 'string') throw toolFormatError(httpStatus);
  let argumentsValue: unknown;
  try { argumentsValue = parseUnknownJson(argumentsText); }
  catch { throw toolFormatError(httpStatus); }
  if (!isJsonObject(argumentsValue)) throw toolFormatError(httpStatus);
  return { id, type: 'function', function: { name, arguments: argumentsText } };
}

function validateToolCalls(value: unknown, httpStatus?: number): ToolCall[] | undefined {
  // OpenAI-compatible services commonly serialize an absent optional array as
  // either [] or null on ordinary prose completions. Neither is a call.
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return undefined;
  if (!Array.isArray(value)) throw toolFormatError(httpStatus);
  const ids = new Set<string>();
  return value.map(item => {
    const call = validateToolCall(item, httpStatus);
    if (ids.has(call.id)) throw toolFormatError(httpStatus);
    ids.add(call.id);
    return call;
  });
}

export async function listModels(provider: Provider, key: string | undefined, signal?: AbortSignal): Promise<ModelInfo[]> {
  const result = await request({ url: endpoint(provider.baseUrl, 'models'), method: 'GET', key, timeoutMs: provider.timeoutMs, signal, stage: 'models' });
  if (signal?.aborted) throw cancelled('models');
  if (result.status < 200 || result.status >= 300) throw serviceError(result.status, result.text, 'models');
  const parsed = parseJson(result.text, 'models', result.status);
  const data = field(parsed, 'data');
  if (!Array.isArray(data)) throw formatError('模型列表格式不兼容；可在高级选项中手动填写模型 ID。', 'models', result.status);
  const ids = new Set<string>();
  for (const row of data) {
    if (!isJsonObject(row)) {
      throw formatError('模型列表中的模型 ID 格式不兼容；可手动填写模型 ID。', 'models', result.status);
    }
    const id = field(row, 'id');
    if (typeof id !== 'string' || !id.trim()) {
      throw formatError('模型列表中的模型 ID 格式不兼容；可手动填写模型 ID。', 'models', result.status);
    }
    ids.add(id);
  }
  return [...ids].map(id => ({ id })).sort((a, b) => a.id.localeCompare(b.id));
}

interface StreamToolCall {
  id?: string;
  type?: 'function';
  name?: string;
  arguments: string;
}

class ChatStream {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private done = false;
  private result: ChatResult = { text: '', finishReason: '' };
  private toolCalls = new Map<number, StreamToolCall>();
  private toolIds = new Map<string, number>();
  constructor(private onChunk: (text: string) => void) {}

  push(text: string): boolean {
    if (this.done) return true;
    this.buffer += text;
    if (this.buffer.length > MAX_RESPONSE_BYTES) throw formatError('流式事件过大，已停止接收。', 'chat');
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
      if (!this.result.finishReason) throw formatError('流式响应缺少完成原因，不能确认生成完整。', 'chat');
      this.done = true; return;
    }
    if (event === 'error') throw serviceError(0, body, 'chat');
    const parsed = parseJson(body, 'chat');
    const choices = field(parsed, 'choices');
    if (!Array.isArray(choices)) throw formatError('流式响应缺少 choices，格式不兼容。', 'chat');
    if (!choices.length) return; // Final usage events may have no choices.
    const choice = choices.find((row): row is JsonObject => isJsonObject(row) && (field(row, 'index') === 0 || field(row, 'index') === undefined));
    if (!choice) return;
    const delta = field(choice, 'delta');
    if (!isJsonObject(delta)) throw formatError('流式响应缺少 delta，格式不兼容。', 'chat');
    const content = field(delta, 'content');
    if (content !== undefined && content !== null && typeof content !== 'string') throw formatError('流式正文格式不兼容。', 'chat');
    if (typeof content === 'string' && content) {
      if (this.result.finishReason) throw formatError('流式响应在完成标记后继续返回正文。', 'chat');
      this.result.text += content;
      this.onChunk(content);
    }
    const toolCalls = field(delta, 'tool_calls');
    if (toolCalls !== undefined) this.collectToolCalls(toolCalls);
    const finishReason = field(choice, 'finish_reason');
    if (finishReason !== null && finishReason !== undefined) {
      if (typeof finishReason !== 'string' || !finishReason) throw formatError('流式完成原因格式不兼容。', 'chat');
      this.result.finishReason = finishReason;
    }
  }

  private collectToolCalls(value: unknown): void {
    // A streamed prose delta may carry an empty/null optional tool_calls field.
    // Completion still requires a fully assembled call when finish_reason says tool_calls.
    if (value === null || (Array.isArray(value) && value.length === 0)) return;
    if (!Array.isArray(value)) throw toolFormatError();
    for (const fragment of value) {
      if (!isJsonObject(fragment)) throw toolFormatError();
      const index = field(fragment, 'index');
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw toolFormatError();
      const state = this.toolCalls.get(index) ?? { arguments: '' };
      const id = field(fragment, 'id');
      // Some OpenAI-compatible streamers repeat optional fields as null after
      // the first tool delta. Treat null as omitted; completion still requires
      // the original nonempty ID.
      if (id !== undefined && id !== null) {
        if (typeof id !== 'string' || !id || (state.id !== undefined && state.id !== id)) throw toolFormatError();
        const existingIndex = this.toolIds.get(id);
        if (existingIndex !== undefined && existingIndex !== index) throw toolFormatError();
        state.id = id;
        this.toolIds.set(id, index);
      }
      const type = field(fragment, 'type');
      if (type !== undefined) {
        if (type !== 'function' || (state.type !== undefined && state.type !== type)) throw toolFormatError();
        state.type = type;
      }
      const functionValue = field(fragment, 'function');
      if (functionValue !== undefined) {
        if (!isJsonObject(functionValue)) throw toolFormatError();
        const name = field(functionValue, 'name');
        // As with id, a later argument fragment may carry name:null.
        if (name !== undefined && name !== null) {
          if (typeof name !== 'string' || !name || (state.name !== undefined && state.name !== name)) throw toolFormatError();
          state.name = name;
        }
        const argumentsText = field(functionValue, 'arguments');
        if (argumentsText !== undefined) {
          if (typeof argumentsText !== 'string') throw toolFormatError();
          state.arguments += argumentsText;
        }
      }
      this.toolCalls.set(index, state);
    }
  }

  private completeToolCalls(): ToolCall[] | undefined {
    if (!this.toolCalls.size) return undefined;
    const calls: ToolCall[] = [];
    for (let index = 0; index < this.toolCalls.size; index++) {
      const state = this.toolCalls.get(index);
      if (!state) throw toolFormatError();
      calls.push(validateToolCall({ id: state.id, type: state.type, function: { name: state.name, arguments: state.arguments } }));
    }
    return calls;
  }

  finish(): ChatResult {
    if (!this.done) {
      if (this.buffer) { this.line(this.buffer.replace(/\r$/, '')); this.buffer = ''; }
      this.dispatch();
    }
    if (!this.result.finishReason) throw formatError('流式响应没有完整结束；请重试，或关闭流式后测试兼容性。', 'chat');
    const toolCalls = this.completeToolCalls();
    if (toolCalls && this.result.finishReason !== 'tool_calls') throw toolFormatError();
    if (!toolCalls && this.result.finishReason === 'tool_calls') throw toolFormatError();
    return toolCalls ? { ...this.result, toolCalls } : { ...this.result };
  }
}

export async function chat(
  provider: Provider,
  key: string | undefined,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal: AbortSignal,
  options?: ChatOptions,
): Promise<ChatResult> {
  if (signal.aborted) throw cancelled('chat');
  if (!provider.model.trim()) throw new ProviderError('format', '请先选择模型，或在高级选项中填写模型 ID。', { stage: 'configuration', code: 'missing_model' });
  const stream = provider.stream;
  const parser = new ChatStream(text => { if (!signal.aborted) onChunk(text); });
  const requestBody: {
    model: string;
    messages: ChatMessage[];
    stream: boolean;
    tools?: ToolDefinition[];
    tool_choice?: ChatOptions['toolChoice'];
    parallel_tool_calls?: boolean;
  } = { model: provider.model, messages, stream };
  if (options?.tools !== undefined) requestBody.tools = options.tools;
  if (options?.toolChoice !== undefined) requestBody.tool_choice = options.toolChoice;
  if (options?.parallelToolCalls !== undefined) requestBody.parallel_tool_calls = options.parallelToolCalls;
  const body = JSON.stringify(requestBody);
  const result = await request({
    url: endpoint(provider.baseUrl, 'chat/completions'), method: 'POST', key, body,
    timeoutMs: provider.timeoutMs, signal, onText: stream ? text => parser.push(text) : undefined, stage: 'chat',
  });
  if (signal.aborted) throw cancelled('chat');
  if (result.status < 200 || result.status >= 300) throw serviceError(result.status, result.text, 'chat');
  if (stream) return parser.finish();
  const parsed = parseJson(result.text, 'chat', result.status);
  const choices = field(parsed, 'choices');
  if (!Array.isArray(choices) || !choices.length) throw formatError('聊天响应缺少 choices，格式不兼容。', 'chat', result.status);
  const choice: unknown = choices[0];
  if (!isJsonObject(choice)) {
    throw formatError('聊天响应缺少正文或完成原因，不能确认生成完整。', 'chat', result.status);
  }
  const message = field(choice, 'message');
  const finishReason = field(choice, 'finish_reason');
  if (!isJsonObject(message) || typeof finishReason !== 'string' || !finishReason) {
    throw formatError('聊天响应缺少正文或完成原因，不能确认生成完整。', 'chat', result.status);
  }
  const content = field(message, 'content');
  if (content !== null && typeof content !== 'string') {
    throw formatError('聊天响应缺少正文或完成原因，不能确认生成完整。', 'chat', result.status);
  }
  const toolCalls = validateToolCalls(field(message, 'tool_calls'), result.status);
  if (content === null && !toolCalls) throw toolFormatError(result.status);
  if (toolCalls && finishReason !== 'tool_calls') throw toolFormatError(result.status);
  if (!toolCalls && finishReason === 'tool_calls') throw toolFormatError(result.status);
  if (typeof content === 'string' && content) onChunk(content);
  if (signal.aborted) throw cancelled('chat');
  return toolCalls ? { text: content ?? '', finishReason, toolCalls } : { text: content ?? '', finishReason };
}
