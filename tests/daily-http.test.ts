import * as http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chat } from '../src/provider';
import { runDailyPipeline, type DailyPipelineResult } from '../src/daily-pipeline';
import { DailyProtocolError } from '../src/daily-protocol';
import * as dailyProtocol from '../src/daily-protocol';
import { sourceFingerprint, type PublicTransport } from '../src/daily-sources';
import type { SourceItem } from '../src/daily-types';
import type { ChatMessage, Provider } from '../src/types';

const servers: http.Server[] = [];
const results: { scenario: string; modelRequests: number; publicReads: number; completedOutput: boolean; noteWrites: number; passed: boolean }[] = [];
const material = '合成工具支持本地 Markdown 知识管理，保留中文与 emoji 😀。';
const sourceBase = { id: 'synthetic-source', canonicalId: 'repository:synthetic/knowledge-tool', kind: 'repository' as const, repository: 'synthetic/knowledge-tool', title: '合成知识工具', summary: '仅用于隔离验证的合成项目。', url: 'https://github.com/synthetic/knowledge-tool', source: '合成公开来源' };
const source: SourceItem = { ...sourceBase, fingerprint: sourceFingerprint(sourceBase) };
const statuses = [{ name: '合成公开来源', status: 'success' as const, message: '仅测试，无外部网络请求。', at: 1 }];
type Mode = 'complete' | 'invalid-json' | 'truncated' | 'hold-second' | 'late-second' | 'zero';

async function service(mode: Mode, stream = false) {
  let calls = 0, publicReads = 0;
  const streamFlags: boolean[] = [];
  let deliverLate = () => { throw new Error('No late streaming response is ready'); };
  let secondReceived!: () => void;
  const second = new Promise<void>(resolve => { secondReceived = resolve; });
  const instance = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      calls++;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/mock/custom/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer dummy-local-test-key');
      const request = JSON.parse(Buffer.concat(parts).toString('utf8')) as { messages: ChatMessage[]; stream: boolean; tools?: unknown };
      streamFlags.push(request.stream);
      expect(request.stream).toBe(stream); expect(request.tools).toBeUndefined();
      expect(request.messages[1]?.content).not.toContain('fullText');
      const input = JSON.parse(request.messages[1]!.content!) as { sources: { sourceId: string; materials?: { text: string }[] }[] };
      expect(input.sources[0]?.sourceId).toBe(source.id);
      let answer: unknown;
      if (calls === 1) answer = { summary: mode === 'zero' ? '没有值得勉强推荐的选题。' : '保留合成知识管理方向。', shortlist: mode === 'zero' ? [] : [{ sourceId: source.id, reason: '可演示，具体且材料可补。' }] };
      else {
        secondReceived();
        expect(input.sources[0]?.materials?.[0]?.text).toBe(material);
        if (mode === 'hold-second') return; // Cancellation destroys this connection.
        answer = { summary: '优选一条，标题仅为预设。', cards: [{
          sourceId: source.id, selected: true, description: '本地知识管理工具，帮助作者把零散中文笔记整理为可复用工作流。', reason: '合成材料支撑具体的知识管理演示。', gaps: ['还需作者实际试用。'], potential: 'high',
          angle: '从零散中文笔记切入本地整理工作流。', primaryTitle: '把零散 Markdown 整理成可用知识库',
          alternativeTitles: ['笔记总找不到？先整理入口', '本地知识管理怎样开始', '让中文笔记进入工作流', '这个知识工具适合谁'],
          opening: '这是一次合成演示，中文和 emoji 😀 都应完整保留。', outline: ['读者的问题', '合成演示步骤', '限制与待验证材料'], evidence: [{ sourceId: source.id, quote: material }],
        }] };
      }
      const content = mode === 'invalid-json' && calls === 2 ? '{"summary":"未完成"' : JSON.stringify(answer);
      if (stream) {
        const characters = Array.from(content), frames: string[] = [];
        for (let index = 0; index < characters.length; index += 37) frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: characters.slice(index, index + 37).join('') }, finish_reason: null }] })}\n\n`);
        frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: mode === 'truncated' && calls === 2 ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
        const bytes = Buffer.from(frames.join(''), 'utf8'), position = bytes.indexOf(Buffer.from('合成'));
        const cut = position >= 0 ? position + 1 : 7;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.on('error', () => undefined);
        res.write(bytes.subarray(0, cut));
        const finish = () => { res.end(bytes.subarray(cut)); };
        if (mode === 'late-second' && calls === 2) deliverLate = finish;
        else setImmediate(finish);
        return;
      }
      const bytes = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: mode === 'truncated' && calls === 2 ? 'length' : 'stop' }] }), 'utf8');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // Split inside a multibyte Chinese character to exercise the real UTF-8
      // transport decoder rather than relying on a fabricated ChatResult.
      const position = bytes.indexOf(Buffer.from('合成'));
      const cut = position >= 0 ? position + 1 : 7;
      res.write(bytes.subarray(0, cut));
      setImmediate(() => res.end(bytes.subarray(cut)));
    });
  });
  servers.push(instance);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Local mock service did not start');
  const provider: Provider = { id: 'local-http-fixture', name: '隔离模拟服务', baseUrl: `http://127.0.0.1:${address.port}/mock/custom/v1`, model: 'synthetic-model', secretRef: '', stream, timeoutMs: 2000 };
  const request: PublicTransport = async publicRequest => {
    publicReads++;
    expect(publicRequest.url).toBe('https://api.github.com/repos/synthetic/knowledge-tool/readme');
    expect(publicRequest).not.toHaveProperty('key');
    expect(JSON.stringify(publicRequest)).not.toContain('dummy-local-test-key');
    return { url: publicRequest.url, status: 200, contentType: 'text/plain', text: material };
  };
  const pipeline = (signal: AbortSignal) => runDailyPipeline({
    profile: '合成作者，面向希望实践 AI 工作流的中文读者。', signal,
    collect: async () => ({ items: [source], sources: statuses }),
    sourceOptions: { request },
    chat: (messages, chatSignal) => chat(provider, 'dummy-local-test-key', messages, () => undefined, chatSignal),
  });
  return { pipeline, second, streamFlags, deliverLate: () => deliverLate(), counts: () => ({ calls, publicReads }) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(instance => new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); })));
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mkdir('docs/qa-0.4.0', { recursive: true });
  await writeFile('docs/qa-0.4.0/mock-service.json', JSON.stringify({
    at: new Date().toISOString(), mode: 'independent local HTTP mock Provider with actual provider.chat transport and pure daily pipeline',
    status: results.length === 7 ? 'passed' : 'incomplete', scenariosExpected: 7,
    syntheticOnly: true, realModelCalls: 0, externalNetworkRequests: 0, providerCredential: 'dummy fixture only; value not recorded',
    sourceCredentialForwarded: false, noteWrites: 0, scenarios: results,
  }, null, 2) + '\n');
});

describe('daily pipeline with a separate HTTP model service', () => {
  it('completes two ordinary chat requests with Chinese output and no source credentials', async () => {
    const mock = await service('complete');
    const output = await mock.pipeline(new AbortController().signal);
    const counts = mock.counts();
    expect(counts).toEqual({ calls: 2, publicReads: 1 });
    expect(output.cards[0]?.selected).toBe(true);
    expect(output.cards[0]?.description).toBe('本地知识管理工具，帮助作者把零散中文笔记整理为可复用工作流。');
    expect(output.cards[0]?.opening).toContain('中文和 emoji 😀');
    expect(output.cards[0]?.evidence?.[0]?.quote).toBe(material);
    results.push({ scenario: 'two-stage complete Chinese JSON', modelRequests: counts.calls, publicReads: counts.publicReads, completedOutput: true, noteWrites: 0, passed: true });
  });
  it.each(['invalid-json', 'truncated'] as const)('rejects %s on the second request without returning writable output or retrying', async mode => {
    const mock = await service(mode); let output: DailyPipelineResult | undefined;
    try { output = await mock.pipeline(new AbortController().signal); throw new Error('Invalid result unexpectedly completed'); }
    catch (error) { expect(error).toBeInstanceOf(DailyProtocolError); expect(error).toMatchObject({ sources: statuses }); }
    const counts = mock.counts();
    expect(output).toBeUndefined(); expect(counts).toEqual({ calls: 2, publicReads: 1 });
    results.push({ scenario: mode, modelRequests: counts.calls, publicReads: counts.publicReads, completedOutput: false, noteWrites: 0, passed: true });
  });
  it('stops the real second HTTP connection and suppresses all output', async () => {
    const mock = await service('hold-second'), controller = new AbortController(); let output: DailyPipelineResult | undefined;
    const pending = mock.pipeline(controller.signal).then(value => { output = value; });
    const checked = expect(pending).rejects.toMatchObject({ kind: 'cancelled', sources: statuses });
    await mock.second; controller.abort(); await checked;
    expect(output).toBeUndefined(); expect(mock.counts()).toEqual({ calls: 2, publicReads: 1 });
    results.push({ scenario: 'stop during second actual HTTP request', modelRequests: mock.counts().calls, publicReads: mock.counts().publicReads, completedOutput: false, noteWrites: 0, passed: true });
  });
  it('returns an empty valid shortlist after one request without reading materials', async () => {
    const mock = await service('zero'); const output = await mock.pipeline(new AbortController().signal);
    expect(output.noChanges).toBe(true); expect(output.cards).toEqual([]); expect(mock.counts()).toEqual({ calls: 1, publicReads: 0 });
    results.push({ scenario: 'zero qualified shortlist', modelRequests: mock.counts().calls, publicReads: mock.counts().publicReads, completedOutput: true, noteWrites: 0, passed: true });
  });
  it('respects streaming for both stages and validates complete Chinese SSE fragments', async () => {
    const mock = await service('complete', true);
    const output = await mock.pipeline(new AbortController().signal);
    expect(mock.streamFlags).toEqual([true, true]);
    expect(mock.counts()).toEqual({ calls: 2, publicReads: 1 });
    expect(output.cards[0]?.description).toBe('本地知识管理工具，帮助作者把零散中文笔记整理为可复用工作流。');
    expect(output.cards[0]?.opening).toBe('这是一次合成演示，中文和 emoji 😀 都应完整保留。');
    expect(output.cards[0]?.evidence?.[0]?.quote).toBe(material);
    results.push({ scenario: 'two-stage streaming with UTF-8 and Chinese SSE fragments', modelRequests: 2, publicReads: 1, completedOutput: true, noteWrites: 0, passed: true });
  });
  it('never parses a late complete streaming card after stopping its HTTP request', async () => {
    const parsedCards = vi.spyOn(dailyProtocol, 'parseDailyCards');
    const mock = await service('late-second', true), controller = new AbortController();
    let output: DailyPipelineResult | undefined;
    const pending = mock.pipeline(controller.signal).then(value => { output = value; });
    const checked = expect(pending).rejects.toMatchObject({ kind: 'cancelled', sources: statuses });
    await mock.second;
    expect(parsedCards).not.toHaveBeenCalled();
    controller.abort(); await checked;
    mock.deliverLate(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(output).toBeUndefined();
    expect(parsedCards).not.toHaveBeenCalled();
    expect(mock.streamFlags).toEqual([true, true]);
    expect(mock.counts()).toEqual({ calls: 2, publicReads: 1 });
    results.push({ scenario: 'stop suppresses late complete streaming JSON before validation', modelRequests: 2, publicReads: 1, completedOutput: false, noteWrites: 0, passed: true });
  });
});
