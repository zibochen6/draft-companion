/**
 * Synthetic OpenAI-compatible service for Draft Companion agent acceptance tests.
 * It never retains request bodies or headers.  Responses are deterministic and
 * derived only from opaque references which the client already supplied.
 */
import http from 'node:http';

const models = ['mock-agent-native', 'mock-agent-structured'];
const safeString = value => typeof value === 'string' ? value : '';
const sendJson = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};
const call = (name, args, id = `mock_${name}`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const chunks = value => {
  const chars = Array.from(value);
  if (chars.length < 2) return [value];
  const pivot = Math.max(1, Math.floor(chars.length / 2));
  return [chars.slice(0, pivot).join(''), chars.slice(pivot).join('')];
};

function strings(messages) { return messages.map(message => safeString(message?.content)).join('\n'); }
function systemText(messages) { return messages.filter(message => message?.role === 'system').map(message => safeString(message.content)).join('\n'); }
function lastUser(messages) { return [...messages].reverse().find(message => message?.role === 'user')?.content ?? ''; }
function reference(text, name) {
  const match = new RegExp(`${name}=([^\\s；]+)`).exec(text);
  return match?.[1] ?? '';
}
function toolResults(messages) {
  return messages.flatMap(message => {
    const content = safeString(message?.content);
    const encoded = message?.role === 'tool' ? content
      : message?.role === 'user' && content.startsWith('工具结果（可信执行记录）：')
        ? content.slice('工具结果（可信执行记录）：'.length) : undefined;
    if (encoded === undefined) return [];
    try { return [JSON.parse(encoded)]; } catch { return [{}]; }
  });
}
function requestInput(messages) {
  const match = /【用户本轮要求】\s*([\s\S]*)$/.exec(strings(messages));
  return match?.[1]?.trim() ?? safeString(lastUser(messages));
}
function replacementFor(messages) {
  const input = requestInput(messages);
  const quoted = /改成[“「\"]([^”」\"]+)[”」\"]/.exec(input)?.[1];
  return quoted ? `【本地模拟】${quoted}` : '【本地模拟】已按冻结范围改写。';
}
function topicPlan(messages) {
  for (const result of toolResults(messages)) {
    if (!Array.isArray(result?.data?.topic_items)) continue;
    const policy = result.data.selection_policy;
    const items = result.data.topic_items.filter(value => value?.available !== false && !value?.checked && typeof value?.topic_ref === 'string');
    const count = policy?.mode === 'exact' ? policy.min : Math.min(1, policy?.max ?? 5);
    return items.slice(0, count).map(item => item.topic_ref);
  }
  return [];
}
function actionRef(messages) {
  for (const result of toolResults(messages)) {
    const item = Array.isArray(result?.data?.actions) ? result.data.actions.find(value => value?.can_undo) : undefined;
    if (typeof item?.action_id === 'string') return item.action_id;
  }
  return '';
}
function classify(input) {
  if (/只推荐|不要勾选|不写入/.test(input)) return { intent: 'recommend-topic' };
  if (/选一个|直接勾选/.test(input)) return { intent: 'select-topic', count: 1 };
  if (/撤回/.test(input)) return { intent: 'undo' };
  if (/选区|改成|替换|改写/.test(input)) return { intent: 'replace' };
  return { intent: 'discuss' };
}
function finalTopic(count) {
  return `已选择${count}个可用选题。\n\n切入角度：从作者眼前的真实写作阻塞开始。\n\n首推标题：把一个具体写作问题写清楚\n\n备选标题：\n1. 从一处卡点开始写文章\n2. 让选题回到读者的问题\n3. 一篇稿子的第一个可验证承诺\n4. 先写清楚谁会需要它`;
}
function plan(messages, payload) {
  const system = systemText(messages), input = safeString(lastUser(messages));
  if (system.includes('判断用户本轮意图')) return { kind: 'content', text: JSON.stringify(classify(input)) };
  const probe = payload.tool_choice?.function?.name === 'protocol_probe';
  if (probe) return { kind: 'tools', calls: [call('protocol_probe', { value: 'ok' }, 'mock_probe')] };
  const structured = system.includes('本服务采用结构化兼容路径');
  const intent = /当前意图=([^。\n]+)/.exec(system)?.[1] ?? 'discuss';
  const documentRef = reference(system, '文稿引用');
  const rangeRef = reference(system, '授权范围引用');
  const results = toolResults(messages), usedTools = results.length > 0;
  let calls = [];
  let reply = '这是本地合成讨论回复；没有执行正文写入。';
  if (intent === 'select-topic') {
    if (!usedTools) calls = [call('list_topic_items', { document_ref: documentRef }, 'mock_topics')];
    else if (messages.some(message => (message?.role === 'tool' && /mock_check/.test(safeString(message.tool_call_id)))
      || (message?.role === 'user' && /"id":"mock_check/.test(safeString(message.content))))) {
      const completed = results.filter(result => result?.status === 'success' && result?.actionId && result?.data?.checked === true).length;
      reply = completed ? finalTopic(completed) : '本轮没有完成新的勾选，请查看材料不足或冲突说明。';
    }
    else {
      const frozen = results.find(result => Array.isArray(result?.data?.topic_refs));
      if (!frozen) calls = [call('plan_topic_selection', { document_ref: documentRef, topic_refs: topicPlan(messages), reason: '【本地模拟】材料明确且具有独立读者问题的选题集合；不足时不凑数。' }, 'mock_topic_plan')];
      else if (['success', 'noop'].includes(frozen.status) && frozen.data.topic_refs.length) calls = frozen.data.topic_refs.map((topicRef, index) => call('set_topic_checked', { document_ref: documentRef, topic_ref: topicRef, checked: true }, `mock_check_${index}`));
      else reply = frozen.message || '没有可用的选题条目，因此没有勾选。';
    }
  } else if (intent === 'replace') {
    if (!usedTools && documentRef && rangeRef) calls = [call('replace_text_range', { document_ref: documentRef, range_ref: rangeRef, replacement: replacementFor(messages), label: '本地模拟改写' }, 'mock_replace')];
    else reply = '已完成本地模拟改写；只修改了工具授权的位置。';
  } else if (intent === 'undo') {
    if (!usedTools) calls = [call('read_document', { document_ref: documentRef }, 'mock_read')];
    else if (messages.some(message => (message?.role === 'tool' && /mock_undo/.test(safeString(message.tool_call_id)))
      || (message?.role === 'user' && safeString(message.content).includes('"id":"mock_undo"')))) reply = '已撤回本地模拟的那一项操作。';
    else if (actionRef(messages)) calls = [call('undo_action', { document_ref: documentRef, action_id: actionRef(messages) }, 'mock_undo')];
    else reply = '没有可撤回的本地操作。';
  } else if (intent === 'recommend-topic') reply = '推荐从最具体的读者问题开始；本地模拟没有勾选任何选题。';
  if (structured) return { kind: 'content', text: JSON.stringify({ calls: calls.map(item => ({ id: item.id, name: item.function.name, arguments: JSON.parse(item.function.arguments) })), reply: calls.length ? '' : reply }) };
  return calls.length ? { kind: 'tools', calls } : { kind: 'content', text: reply };
}

function writeStream(response, responsePlan) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  const event = body => response.write(`data: ${JSON.stringify(body)}\r\n\r\n`);
  if (responsePlan.kind === 'tools') {
    responsePlan.calls.forEach((tool, index) => {
      const pieces = chunks(tool.function.arguments);
      event({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.function.name, arguments: pieces[0] } }] }, finish_reason: null }] });
      for (const piece of pieces.slice(1)) event({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] }, finish_reason: null }] });
    });
    event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    for (const text of chunks(responsePlan.text)) event({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  response.end('data: [DONE]\r\n\r\n');
}

/** Start a local-only service. `stats.requests` contains only sanitized metadata. */
export async function createMockAgentProvider({ port = 0, host = '127.0.0.1' } = {}) {
  const stats = { requests: 0, modelRequests: 0, chatRequests: 0, nativeRequests: 0, structuredRequests: 0, streamRequests: 0, toolNames: [] };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      stats.requests++; stats.modelRequests++;
      sendJson(response, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'draft-companion-mock' })) });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      sendJson(response, 404, { error: { code: 'not_found', message: 'Synthetic route not found.' } });
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', part => {
      raw += part;
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) { sendJson(response, 413, { error: { code: 'context_length_exceeded' } }); request.destroy(); }
    });
    request.on('end', () => {
      if (response.writableEnded) return;
      let payload;
      try { payload = JSON.parse(raw); } catch { sendJson(response, 400, { error: { code: 'invalid_json' } }); return; }
      if (!payload || !Array.isArray(payload.messages)) { sendJson(response, 400, { error: { code: 'invalid_messages' } }); return; }
      const responsePlan = plan(payload.messages, payload);
      stats.requests++; stats.chatRequests++;
      if (payload.stream === true) stats.streamRequests++;
      if (Array.isArray(payload.tools)) stats.nativeRequests++; else if (systemText(payload.messages).includes('本服务采用结构化兼容路径')) stats.structuredRequests++;
      const names = responsePlan.kind === 'tools' ? responsePlan.calls.map(item => item.function.name) : [];
      stats.toolNames.push(...names); if (stats.toolNames.length > 100) stats.toolNames.splice(0, stats.toolNames.length - 100);
      // Intentionally log only aggregate metadata: no headers, prompts, documents, or arguments.
      console.log(`[mock-agent-provider] request=${stats.chatRequests} stream=${payload.stream === true} protocol=${Array.isArray(payload.tools) ? 'native' : 'content'} tools=${names.join(',') || 'none'}`);
      if (payload.stream === true) { writeStream(response, responsePlan); return; }
      const message = responsePlan.kind === 'tools'
        ? { role: 'assistant', content: null, tool_calls: responsePlan.calls }
        : { role: 'assistant', content: responsePlan.text };
      sendJson(response, 200, { id: `mock-agent-${stats.chatRequests}`, object: 'chat.completion', model: safeString(payload.model) || models[0], choices: [{ index: 0, message, finish_reason: responsePlan.kind === 'tools' ? 'tool_calls' : 'stop' }] });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock provider did not expose a TCP port.');
  return { server, port: address.port, stats, close: () => new Promise(resolve => server.close(() => resolve())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = process.argv.indexOf('--port');
  const requested = index >= 0 ? Number(process.argv[index + 1]) : 43128;
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error('Usage: node scripts/mock-agent-provider.mjs [--port 43128]');
  const mock = await createMockAgentProvider({ port: requested });
  console.log(`MOCK_AGENT_PROVIDER_URL=http://127.0.0.1:${mock.port}/v1`);
  console.log('Synthetic native/structured agent provider; request logs are sanitized metadata only.');
  const close = async () => { await mock.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
