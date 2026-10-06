/** Live transport checks. Credentials enter through stdin and remain in memory. */
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const temp = await mkdtemp(join(tmpdir(), 'draft-companion-live-transport-'));
await build({ stdin: { contents: "export * from './src/provider.ts'; export * from './src/editing.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'transport.mjs') });
const { chat, listModels, parseEdit, endpoint } = await import(pathToFileURL(join(temp, 'transport.mjs')).href);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let key = '';
let provider;
let report;
const redact = value => JSON.parse(JSON.stringify(value).split(key || '\u0000').join('[redacted]'));
const output = value => process.stdout.write(JSON.stringify(redact(value)) + '\n');
try {
  for await (const line of lines) {
    const command = JSON.parse(line);
    if (!provider) {
      key = command.key;
      if (typeof key !== 'string' || !key.trim()) throw new Error('A nonempty credential must be provided via stdin.');
      provider = { id: 'live-qa', name: 'Live verification', baseUrl: command.baseUrl, secretRef: 'memory-only', model: '', stream: false, timeoutMs: 60000 };
      report = { date: new Date().toISOString(), baseUrl: provider.baseUrl, endpoints: { models: endpoint(provider.baseUrl, 'models'), chat: endpoint(provider.baseUrl, 'chat/completions') }, credentialStorage: 'memory only, not persisted', checks: [] };
      const started = Date.now();
      const models = await listModels(provider, key);
      const preferred = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini', 'deepseek-v3', 'gemini-2.5-flash'];
      const shortlist = models.map(m => m.id).filter(id => preferred.some(p => id.toLowerCase().includes(p)));
      report.modelCount = models.length;
      report.checks.push({ name: 'models', pass: true, durationMs: Date.now() - started, count: models.length });
      output({ action: 'models', count: models.length, preferred: shortlist.slice(0, 30), fallback: models.slice(0, 12).map(m => m.id) });
      continue;
    }
    if (command.action === 'quit') {
      await writeFile(resolve('docs/real-api-transport.json'), JSON.stringify(redact(report), null, 2) + '\n');
      output({ action: 'complete', report });
      break;
    }
    provider.model = command.model || provider.model;
    const started = Date.now();
    let result;
    try {
      const chunks = [];
      const abort = new AbortController();
      if (command.action === 'timeout') {
        try {
          await chat({ ...provider, timeoutMs: 1, stream: false }, key, [{ role: 'user', content: '仅输出连接成功。' }], () => {}, abort.signal);
          assert.fail('Expected an intentional deadline failure.');
        } catch (error) { assert.equal(error.kind, 'network'); assert.match(error.message, /超时/); }
        result = { intentionalDeadlineMs: 1, noRetry: true };
      } else if (command.action === 'cancel') {
        let stopped = false;
        const sending = chat({ ...provider, stream: true }, key, [{ role: 'user', content: '请用中文列出30条写作时检查段落衔接的简短建议。' }], chunk => { chunks.push(chunk); if (!stopped) { stopped = true; abort.abort(); } }, abort.signal);
        try { await sending; assert.fail('Expected cancellation.'); } catch (error) { assert.equal(error.kind, 'cancelled'); }
        const count = chunks.length;
        await new Promise(r => setTimeout(r, 400));
        assert(count > 0); assert.equal(chunks.length, count);
        result = { receivedChunks: count, callbacksAfterStop: 0 };
      } else {
        const edit = command.action === 'edit';
        const streaming = command.action === 'stream';
        const messages = edit ? [
          { role: 'system', content: '输出完整JSON，仅有explanation字符串、replacement字符串、notes字符串数组，不要代码围栏，不要附加文字。replacement仅是改写后正文，不要把说明放进去。' },
          { role: 'user', content: '这是合成测试段落：写文章时，作者在文稿和聊天窗口之间反复复制内容。工具应保留人的判断，修改需要先预览。📝\n请只改善第二句话表达，保留观点与emoji。' }
        ] : [{ role: 'user', content: '这是软件连接测试，请只输出：稿伴连接成功，中文正常😀' }];
        const response = await chat({ ...provider, stream: streaming }, key, messages, chunk => chunks.push(chunk), abort.signal);
        assert.equal(response.finishReason, 'stop'); assert(response.text.trim());
        assert.equal(chunks.join(''), response.text); assert(!response.text.includes('\uFFFD'));
        if (edit) {
          const parsed = parseEdit(response.text);
          assert(parsed.replacement.includes('判断'));
          result = { finishReason: response.finishReason, validCandidateFields: true, replacementCharacters: parsed.replacement.length };
        } else {
          assert.match(response.text, /中文/); assert(response.text.includes('😀'));
          result = { finishReason: response.finishReason, characters: response.text.length, chunks: chunks.length, response: response.text };
        }
      }
      const check = { name: command.action, model: provider.model, pass: true, durationMs: Date.now() - started, ...result };
      report.checks.push(check); output(check);
    } catch (error) {
      const check = { name: command.action, model: provider.model, pass: false, durationMs: Date.now() - started, kind: error.kind || 'assertion', error: error.message };
      report.checks.push(check); output(check);
    }
  }
} catch (error) {
  output({ fatal: true, kind: error.kind || 'error', error: error.message });
  process.exitCode = 1;
} finally {
  key = ''; lines.close(); await rm(temp, { recursive: true, force: true });
}
