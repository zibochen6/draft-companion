import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { chat, ProviderError } from '../src/provider';
import type { Provider, ToolDefinition } from '../src/types';

const servers: http.Server[] = [];

async function server(handler: http.RequestListener): Promise<string> {
  const instance = http.createServer(handler);
  servers.push(instance);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed');
  return `http://127.0.0.1:${address.port}/v1`;
}

function provider(baseUrl: string, stream = true): Provider {
  return { id: 'tools', name: 'Tools', baseUrl, secretRef: '', model: 'tool-model', stream, timeoutMs: 2_000, toolMode: 'native' };
}

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function expectKind(promise: Promise<unknown>, kind: string): Promise<ProviderError> {
  return promise.then(
    () => { throw new Error('Expected provider error'); },
    error => {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe(kind);
      return error as ProviderError;
    },
  );
}

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'lookup_weather',
    description: 'Find a city forecast.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(instance => new Promise<void>(resolve => {
    instance.closeAllConnections();
    instance.close(() => resolve());
  })));
});

describe('native tool calls', () => {
  it.each([
    { name: 'empty optional array', tool_calls: [] },
    { name: 'null optional field', tool_calls: null },
  ])('accepts $name on a normal non-tool completion', async ({ tool_calls }) => {
    const baseUrl = await server((_request, response) => response.end(JSON.stringify({ choices: [{
      message: { content: '正常中文回复', tool_calls }, finish_reason: 'stop',
    }] })));
    await expect(chat(provider(baseUrl, false), undefined, [], () => {}, new AbortController().signal, { tools }))
      .resolves.toEqual({ text: '正常中文回复', finishReason: 'stop' });
  });

  it('ignores empty and null optional stream fields but still returns prose normally', async () => {
    const baseUrl = await server((_request, response) => response.end([
      event({ choices: [{ index: 0, delta: { content: '正常', tool_calls: [] }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { content: '中文', tool_calls: null }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join('')));
    const output: string[] = [];
    await expect(chat(provider(baseUrl), undefined, [], text => output.push(text), new AbortController().signal, { tools }))
      .resolves.toEqual({ text: '正常中文', finishReason: 'stop' });
    expect(output).toEqual(['正常', '中文']);
  });

  it('still rejects an empty optional array when the service claims tool_calls completion', async () => {
    const baseUrl = await server((_request, response) => response.end(JSON.stringify({ choices: [{
      message: { content: null, tool_calls: [] }, finish_reason: 'tool_calls',
    }] })));
    await expectKind(chat(provider(baseUrl, false), undefined, [], () => {}, new AbortController().signal, { tools }), 'format');
  });

  it('sends OpenAI-compatible tool request fields and accepts a complete null-content response', async () => {
    const baseUrl = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (part: Buffer) => chunks.push(part));
      request.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
          model: 'tool-model',
          messages: [{ role: 'user', content: '查天气' }],
          stream: false,
          tools,
          tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
          parallel_tool_calls: false,
        });
        response.end(JSON.stringify({ choices: [{
          message: { content: null, tool_calls: [{ id: 'call-weather', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"北京"}' } }] },
          finish_reason: 'tool_calls',
        }] }));
      });
    });
    const output: string[] = [];
    await expect(chat(
      provider(baseUrl, false),
      undefined,
      [{ role: 'user', content: '查天气' }],
      text => output.push(text),
      new AbortController().signal,
      { tools, toolChoice: { type: 'function', function: { name: 'lookup_weather' } }, parallelToolCalls: false },
    )).resolves.toEqual({
      text: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call-weather', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"北京"}' } }],
    });
    expect(output).toEqual([]);
  });

  it('assembles fragmented Chinese arguments for multiple streamed calls without emitting arguments as text', async () => {
    const baseUrl = await server((_request, response) => {
      const responseText = [
        event({ choices: [{ index: 0, delta: { content: null, tool_calls: [
          { index: 0, id: 'call-weather', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"北' } },
          { index: 1, id: 'call-time', type: 'function', function: { name: 'lookup_time', arguments: '{"zone":"A' } },
        ] }, finish_reason: null }] }),
        event({ choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, function: { arguments: '京"}' } },
          { index: 1, function: { arguments: 'sia/Shanghai"}' } },
        ] }, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ].join('');
      const bytes = Buffer.from(responseText);
      for (let offset = 0; offset < bytes.length; offset += 2) response.write(bytes.subarray(offset, offset + 2));
      response.end();
    });
    const output: string[] = [];
    await expect(chat(provider(baseUrl), undefined, [], text => output.push(text), new AbortController().signal, { tools, toolChoice: 'required', parallelToolCalls: true }))
      .resolves.toEqual({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'call-weather', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"北京"}' } },
          { id: 'call-time', type: 'function', function: { name: 'lookup_time', arguments: '{"zone":"Asia/Shanghai"}' } },
        ],
      });
    expect(output).toEqual([]);
  });

  it('accepts null repeated ID and function name on later real-shaped tool fragments', async () => {
    const baseUrl = await server((_request, response) => response.end([
      event({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0, id: 'call-real', type: 'function', function: { name: 'lookup_weather', arguments: '' },
      }] }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0, id: null, type: 'function', function: { name: null, arguments: '{"city":"北' },
      }] }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0, id: null, type: 'function', function: { name: null, arguments: '京"}' },
      }] }, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ].join('')));
    await expect(chat(provider(baseUrl), undefined, [], () => {}, new AbortController().signal, { tools }))
      .resolves.toEqual({ text: '', finishReason: 'tool_calls', toolCalls: [
        { id: 'call-real', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"北京"}' } },
      ] });
  });

  it.each([
    {
      name: 'duplicate IDs across streamed calls',
      output: event({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'duplicate', type: 'function', function: { name: 'one', arguments: '{}' } },
        { index: 1, id: 'duplicate', type: 'function', function: { name: 'two', arguments: '{}' } },
      ] }, finish_reason: null }] }),
    },
    {
      name: 'missing name at streamed completion',
      output: event({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'missing-name', type: 'function', function: { arguments: '{}' } },
      ] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n',
    },
    {
      name: 'null initial ID and name at streamed completion',
      output: event({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: null, type: 'function', function: { name: null, arguments: '{}' } },
      ] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n',
    },
    {
      name: 'invalid final JSON arguments',
      output: event({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'bad-arguments', type: 'function', function: { name: 'one', arguments: '{' } },
      ] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n',
    },
  ])('rejects $name without exposing a callable result', async ({ output }) => {
    const baseUrl = await server((_request, response) => response.end(output));
    await expectKind(chat(provider(baseUrl), undefined, [], () => {}, new AbortController().signal, { tools }), 'format');
  });

  it('never returns a partial tool call after a broken stream', async () => {
    const baseUrl = await server((_request, response) => {
      response.write(event({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'partial', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"北' } },
      ] }, finish_reason: null }] }));
      setTimeout(() => response.destroy(), 5);
    });
    await expectKind(chat(provider(baseUrl), undefined, [], () => {}, new AbortController().signal, { tools }), 'connection');
  });

  it('cancels an in-flight tool stream before a completed call can be returned', async () => {
    let connected!: () => void;
    const ready = new Promise<void>(resolve => { connected = resolve; });
    const baseUrl = await server((_request, response) => {
      response.write(event({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'cancelled', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"北' } },
      ] }, finish_reason: null }] }));
      connected();
    });
    const abort = new AbortController();
    const pending = chat(provider(baseUrl), undefined, [], () => {}, abort.signal, { tools });
    await ready;
    abort.abort();
    await expectKind(pending, 'cancelled');
  });
});
