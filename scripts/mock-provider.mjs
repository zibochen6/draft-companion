/** Local synthetic test service only. Never logs request headers or credentials. */
import http from 'node:http';

const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const port = Number(value('--port') ?? 0);
const delay = Number(value('--delay') ?? 20);
if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(delay) || delay < 0) {
  console.error('Usage: node scripts/mock-provider.mjs [--port 43127] [--delay 20]');
  process.exit(1);
}
const records = [];
let requestNumber = 0;
const modelIds = ['mock-draft-model', 'mock-review-model'];
const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

function context(messages) {
  const last = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
  const input = last.includes('【用户本轮要求】') ? last.slice(last.lastIndexOf('【用户本轮要求】') + '【用户本轮要求】'.length).trim() : last;
  const start = /【唯一最新全文开始 [^\n]+】\r?\n/.exec(last);
  const fromIndex = start ? start.index + start[0].length : -1;
  const endIndex = fromIndex < 0 ? -1 : last.indexOf('\n【唯一最新全文结束 ', fromIndex);
  const fullText = fromIndex >= 0 && endIndex >= fromIndex ? last.slice(fromIndex, endIndex) : '';
  const range = /UTF-16 偏移 \[(\d+), (\d+)\)/.exec(last);
  const from = range ? Number(range[1]) : 0;
  const to = range ? Number(range[2]) : fullText.length;
  const target = fullText.slice(from, to);
  const role = /当前角色：([^\n]+)/.exec(messages.find(message => message.role === 'system')?.content ?? '')?.[1] ?? '创作伙伴';
  return { input, fullText, target, role, selection: last.includes('修改范围：选中部分') };
}

function editReply(snapshot, number) {
  const explicit = /TEST:REPLACE\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/.exec(snapshot.input);
  const chinese = /将[“「"](.+?)[”」"](?:替换|改)为[“「"](.*?)[”」"]/.exec(snapshot.input);
  let replacement = snapshot.target;
  if (explicit) replacement = replacement.replaceAll(JSON.parse(explicit[1]), JSON.parse(explicit[2]));
  else if (chinese) replacement = replacement.replaceAll(chinese[1], chinese[2]);
  else if (replacement.includes('这份文稿用于验证')) replacement = replacement.replace('这份文稿用于验证', '这份文稿用来验证');
  else if (snapshot.selection) replacement = `${replacement.trimEnd()}（模拟调整第 ${number} 轮）`;
  else {
    const paragraph = replacement.split(/\r?\n/).find(line => line.trim() && !/^(?:#|!|\[|```|~~~|>)/.test(line));
    if (paragraph) replacement = replacement.replace(paragraph, `${paragraph}（模拟调整第 ${number} 轮）`);
    else replacement = `${replacement.trimEnd()}\n\n这段内容来自本地模拟改稿服务，用于验证预览与回写。\n`;
  }
  return JSON.stringify({
    explanation: `【本地模拟】只调整发送时冻结的${snapshot.selection ? '选区' : '正文'}；第 ${number} 次测试请求。`,
    replacement,
    notes: ['这是确定性模拟响应，只用于验证插件流程，不代表真实模型审稿或事实核查。'],
  });
}

function reply(messages, number) {
  const snapshot = context(messages);
  const bodyText = snapshot.target.replace(/^\uFEFF?---[\t ]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/, '');
  const first = bodyText.split(/\r?\n/).find(line => line.trim() && !/^(?:#|!|\[|```|~~~)/.test(line)) ?? '当前文章';
  if (/TEST:EDIT\b/.test(snapshot.input) || messages.some(message => message.role === 'system' && message.content.includes('本轮方式：改稿'))) return editReply(snapshot, number);
  if (/TEST:REVIEW\b/.test(snapshot.input)) return `【本地模拟审稿】\n\n1. **表达问题**：原文“${first}”。建议让开头更快说明文章用于什么场景。\n2. **材料不足**：示例尚未展示真实工作记录；这是测试素材，不能改写成作者亲历。\n3. **待外部核实**：图片路径、引用与链接需要用户检查；模拟服务没有联网核实。\n\n以上意见尚未修改正文。`;
  if (/TEST:TITLE\b/.test(snapshot.input)) return '【本地模拟标题与发布检查】\n\n- 把 AI 写作留在文稿旁边：一次可撤回的创作流程\n- 从讨论到改稿：让修改先经过预览\n- 在笔记里写文章，怎样保护原来的表达\n\n推荐第二个标题，适合想了解工作流的读者。发布摘要：围绕当前 Markdown 文稿讨论、审阅和预览修改，并保留作者判断。\n\n待检查：图片引用是否存在、外链是否可访问、第一人称经历是否有材料支撑。此处没有执行联网核查或平台发布。';
  if (snapshot.role.includes('大纲') || /TEST:OUTLINE\b/.test(snapshot.input)) return '【本地模拟大纲】\n\n一句话主旨：将讨论与可预览修改放在文稿旁边。\n\n1. 从反复复制文章的工作场景进入。\n2. 解释讨论、选区改稿与整篇文稿之间的关系。\n3. 展示预览、应用和撤回如何保护原稿。\n4. 指出材料与事实仍需作者核实。\n\n材料缺口：真实使用记录。此大纲尚未写入正文。';
  const discussion = `【本地模拟讨论 · ${snapshot.role}】\n\n当前全文共 ${snapshot.fullText.length} 个字符；我收到的最新材料包含“${first}”。\n\n建议以“读者在什么工作中需要它”为切入点，再说明流程和限制。用户本轮要求是“${snapshot.input}”。\n\n本次只提供讨论；没有修改文稿，也没有读取双链、图片或外部网页。`;
  return /TEST:SLOW\b/.test(snapshot.input) ? `${discussion}\n\n${'这是一段用于验证停止生成的本地模拟内容。\n'.repeat(60)}` : discussion;
}

const instance = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: modelIds.map(id => ({ id, object: 'model', owned_by: 'local-mock' })) }); return;
  }
  if (req.method === 'GET' && req.url === '/__requests') { sendJson(res, 200, records); return; }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { sendJson(res, 404, { error: { code: 'not_found', message: 'Mock route not found' } }); return; }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', data => {
    body += data;
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) { sendJson(res, 413, { error: { code: 'context_length_exceeded' } }); req.destroy(); }
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let payload;
    try { payload = JSON.parse(body); } catch { sendJson(res, 400, { error: { code: 'invalid_json' } }); return; }
    if (!Array.isArray(payload.messages) || payload.messages.some(message => !message || typeof message.content !== 'string' || !['system', 'user', 'assistant'].includes(message.role))) {
      sendJson(res, 400, { error: { code: 'invalid_messages' } }); return;
    }
    if (!modelIds.includes(payload.model) && payload.model !== 'test-model') { sendJson(res, 404, { error: { code: 'unknown_model' } }); return; }
    const number = ++requestNumber;
    // Body-only records are transient and meant exclusively for synthetic fixtures.
    records.push({ number, model: payload.model, stream: payload.stream === true, messages: payload.messages.map(({ role, content }) => ({ role, content })) });
    if (records.length > 100) records.shift();
    const content = reply(payload.messages, number);
    if (!payload.stream) {
      sendJson(res, 200, { id: `mock-${number}`, object: 'chat.completion', model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    let offset = 0;
    const interval = /TEST:SLOW\b/.test(context(payload.messages).input) ? Math.max(delay, 100) : delay;
    const timer = setInterval(() => {
      if (offset >= content.length) {
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\r\n\r\n`);
        res.end('data: [DONE]\r\n\r\n'); return;
      }
      // Array.from avoids creating lone emoji surrogates in individual SSE JSON chunks.
      const segment = Array.from(content.slice(offset)).slice(0, 18).join('');
      offset += segment.length;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: segment }, finish_reason: null }] })}\r\n\r\n`);
    }, interval);
    res.on('close', () => clearInterval(timer));
  });
});
instance.listen(port, '127.0.0.1', () => {
  const address = instance.address();
  console.log(`MOCK_PROVIDER_URL=http://127.0.0.1:${address.port}/v1`);
  console.log('Models: mock-draft-model, mock-review-model; key is optional.');
  console.log('Synthetic test content only. GET /__requests exposes transient body-only test records; headers are never recorded.');
});
instance.on('error', error => { console.error(`Mock provider could not start (${error.code ?? 'unknown'}).`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { instance.closeAllConnections(); instance.close(() => process.exit(0)); });
