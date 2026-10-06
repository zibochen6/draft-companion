/** Real API / actual Obsidian QA. Input is ONE stdin JSON line {key,baseUrl,model}; never pass credentials as arguments. */
import { writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

let secret = '';
let configuration;
let configurationValidated = false;
let ws;
let vaultVerified = false;
let getterInstalled = false;
const checks = [];
let phaseNumber = 0;
let fatal = '';
const args = process.argv.slice(2);
const isolationOnly = args.includes('--isolation-only');
const resumeWorkflow = args.includes('--resume-workflow');
const editingOnly = args.includes('--editing-only');
const selectionOnly = args.includes('--selection-only');
if ([isolationOnly,resumeWorkflow,editingOnly].filter(Boolean).length>1) throw new Error('Choose only one partial-run mode.');
const reportName = selectionOnly ? 'real-api-selection.json' : editingOnly ? 'real-api-editing-recheck.json' : resumeWorkflow ? 'real-api-gui-resumed.json' : isolationOnly ? 'real-api-isolation.json' : 'real-api-gui-first-run.json';
const reportPath = resolve(`docs/${reportName}`);
const startedAt = new Date().toISOString();
const sleep = ms => new Promise(done => setTimeout(done, ms));

// Never print CDP exception objects, expressions, stdin or model replies.
function safeError(error) {
  let value = error instanceof Error ? error.message : 'Operation failed.';
  if (secret) value = value.split(secret).join('[REDACTED]');
  value = value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  return value.slice(0, 500);
}
function progress(text) { process.stdout.write(`${text}\n`); }

async function readConfiguration() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let first = '';
  try { for await (const line of lines) { first = line; break; } }
  finally { lines.close(); process.stdin.pause(); }
  try { configuration = JSON.parse(first); }
  catch { throw new Error('stdin must provide one valid configuration JSON line.'); }
  finally { first = ''; }
  if (!configuration || typeof configuration.key !== 'string' || !configuration.key.trim() || /[\r\n]/.test(configuration.key)) throw new Error('A nonempty one-line API key is required on stdin.');
  secret = configuration.key;
  if (typeof configuration.baseUrl !== 'string' || typeof configuration.model !== 'string' || !configuration.model.trim() || /[\r\n]/.test(configuration.model)) throw new Error('A valid API root and model ID are required.');
  let root;
  try { root = new URL(configuration.baseUrl); } catch { throw new Error('API root must be a complete URL.'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash || configuration.baseUrl.includes(secret)) throw new Error('API root must use http/https without credentials, query or fragment.');
  configuration.baseUrl = configuration.baseUrl.replace(/\/+$/, '');
  configuration.model = configuration.model.trim();
  if (configuration.model.includes(secret)) throw new Error('The model ID must not contain the API key.');
  configurationValidated = true;
}

let serial = 0;
const pending = new Map();
async function call(method, params = {}) {
  const id = ++serial;
  const result = new Promise((accept, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop debugging operation timed out.')); }, 60000);
    pending.set(id, { accept, reject, timer });
  });
  ws.send(JSON.stringify({ id, method, params }));
  const response = await result;
  if (response.error) throw new Error('Desktop debugging operation was rejected; raw details omitted.');
  return response.result;
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(safeError(new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)));
  return result.result.value;
}
async function waitFor(expression, timeout = 8000) {
  const started = performance.now(); const until = started + timeout; let lastProgress = started;
  while (performance.now() < until) {
    if (await evaluate(expression)) return;
    if (performance.now() - lastProgress >= 10000) { progress(`    等待宿主状态：${Math.round((performance.now() - started) / 1000)} 秒`); lastProgress = performance.now(); }
    await sleep(120);
  }
  if (await evaluate(expression)) return;
  throw new Error('An expected desktop state did not appear within the timeout.');
}
async function phase(name, run) {
  const number = ++phaseNumber; const started = performance.now();
  progress(`[${number}] ${name} — 开始`);
  try {
    const details = await run();
    checks.push({ number, name, passed: true, durationMs: performance.now() - started, details: details ?? {} });
    progress(`[${number}] ${name} — 通过`); return true;
  } catch (error) {
    const detail = safeError(error);
    checks.push({ number, name, passed: false, durationMs: performance.now() - started, error: detail });
    progress(`[${number}] ${name} — 未通过：${detail}`); return false;
  }
}

/** Start work without awaiting the whole provider response in a single CDP call. */
async function startOperation(statement) {
  await evaluate(String.raw`(()=>{
    const q=window.dcrealqa;
    if(q.host.running)throw new Error('A generation is already running.');
    const operation={done:false,error:'',characters:0,requestId:'',sessionId:q.host.currentSession()?.id||''};
    q.operation=operation;
    Promise.resolve().then(()=>{${statement}}).then(value=>{
      operation.characters=typeof value==='string'?value.length:0;
      operation.done=true;
    }).catch(error=>{
      const text=error instanceof Error?error.message:'Operation failed.';
      operation.error=text.split(q.key).join('[REDACTED]').slice(0,500);
      operation.done=true;
    });return true;
  })()`);
}
async function awaitOperation(label, timeout = 130000) {
  const started = performance.now(); let lastProgress = started;
  while (performance.now() - started < timeout) {
    const state = await evaluate(String.raw`(()=>{const q=dcrealqa;return {done:q.operation.done,error:q.operation.error,characters:q.host.running?.text.length||q.operation.characters};})()`);
    if (state.done) {
      if (state.error) throw new Error(state.error);
      return { durationMs: performance.now() - started, characters: state.characters };
    }
    if (performance.now() - lastProgress >= 10000) {
      progress(`    ${label}：等待 ${Math.round((performance.now() - started) / 1000)} 秒，已接收 ${state.characters} 字符`);
      lastProgress = performance.now();
    }
    await sleep(250);
  }
  const finalState = await evaluate(String.raw`(()=>{const q=dcrealqa;return {done:q.operation.done,error:q.operation.error,characters:q.host.running?.text.length||q.operation.characters};})()`);
  if (finalState.done) { if (finalState.error) throw new Error(finalState.error); return { durationMs: performance.now()-started, characters: finalState.characters }; }
  await evaluate('dcrealqa.host.stop();true');
  throw new Error('The real provider operation exceeded its 120-second request timeout plus cleanup allowance.');
}
async function chooseRole(id) {
  await evaluate(String.raw`dcrealqa.host.chooseRole(${JSON.stringify(id)})`);
}
async function runRound(name, roleId, input, mode = 'discuss', scope = 'body', afterStart) {
  return phase(name, async () => {
    await chooseRole(roleId);
    await startOperation(`const promise=q.host.send(${JSON.stringify(input)},${JSON.stringify(mode)},${JSON.stringify(scope)});operation.requestId=q.host.running?.id||'';return promise;`);
    if (afterStart) await afterStart();
    await awaitOperation(name);
    const state = await evaluate(String.raw`(()=>{
      const q=dcrealqa;const s=Object.values(q.host.data.sessions).find(s=>s.id===q.operation.sessionId);
      const reply=s?.messages.find(m=>m.id===q.operation.requestId);
      return {status:reply?.status,characters:reply?.content.length||0,roleName:reply?.roleName,
        candidateReady:!!s?.candidate&&s.candidate.requestId===q.operation.requestId&&s.candidate.state==='ready',
        candidateCharacters:s?.candidate?.replacement.length||0};
    })()`);
    assert.equal(state.status, 'completed', 'The host must mark this reply complete.');
    assert(state.characters > 0, 'The reply must contain text.');
    if (mode === 'edit') assert.equal(state.candidateReady, true, 'JSON must be valid and yield a ready candidate; no format repair is performed.');
    return { ...state, mode, scope, jsonValidatedByActualPlugin: mode === 'edit' };
  });
}
async function applyThroughModal(name) {
  return phase(name, async () => {
    await evaluate(String.raw`(()=>{
      const q=dcrealqa;q.applying=q.host.currentSession().candidate;
      if(q.applying?.state!=='ready')throw new Error('No ready candidate.');
      [...document.querySelectorAll('.dc-candidate-bar button')].find(b=>b.textContent==='预览差异').click();return true;
    })()`);
    await waitFor('!!document.querySelector(".dc-candidate-modal")');
    assert.equal(await evaluate(String.raw`document.querySelector('.dc-candidate-modal').textContent.includes(dcrealqa.host.target().path)`), true, 'Preview must show the actual target path.');
    await evaluate(String.raw`(()=>{const button=[...document.querySelectorAll('.dc-candidate-modal button')].find(b=>b.textContent==='应用整批修改');if(!button||button.disabled)throw new Error('Apply is unavailable.');button.click();return true;})()`);
    await waitFor('dcrealqa.applying.state === "applied" || dcrealqa.applying.state === "stale"');
    assert.equal(await evaluate('dcrealqa.applying.state'), 'applied', 'Actual preview apply must succeed.');
    await waitFor('!document.querySelector(".dc-candidate-modal")');
    return { path: await evaluate('dcrealqa.host.target().path'), actualModalClick: true };
  });
}

const frontmatter = '---\ntitle: 稿伴真实 API 合成测试\nstatus: 测试草稿\n---\n';
const authorJudgment = '作者判断：工具应保留人的判断，修改需要先预览。';
const seedBody = `\n# 文稿旁的 AI 写作\n\n作者在文稿与聊天窗口之间复制内容，容易把未应用建议误当正文。这是合成场景，不是实测。\n\n## 具体判断\n\n- ${authorJudgment}\n- [[合成资料]] 和 ![[合成案例#片段]] 仅是引用，不展开。\n- ![流程示意](assets/合成示意图.png) 与 [示例材料](https://example.com) 待作者检查。\n\n\`\`\`typescript\nconst workflow = ['讨论', '预览', '应用', '撤回'];\nconsole.log(workflow.join(' → '));\n\`\`\`\n\n## 下一步\n\n先预览一处修改，再决定是否应用。不提供收益数字或真实经历。\n`;
const aSeed = `${frontmatter}\n# 冻结选区测试\n\n冻结选区原句：写作讨论要留在当前文稿旁。📝\n\n${authorJudgment}\n\n\`\`\`text\n范围外代码保持不变\n\`\`\`\n`;
const bSeed = '# B 合成测试文稿\n\nB 的正文和会话不应被 A 的生成污染。\n';

try {
  await readConfiguration();
  const arg = key => args[args.indexOf(key) + 1];
  const expected = args.includes('--vault') ? await realpath(arg('--vault')) : '';
  if (!expected || !expected.includes('draft-companion-qa-') || !expected.endsWith('/TestVault')) throw new Error('Only an isolated draft-companion-qa-*/TestVault is permitted.');
  const port = args.includes('--port') ? Number(arg('--port')) : 9334;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Debug port is invalid.');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = pages.find(page => page.title.includes('TestVault') && page.url === 'app://obsidian.md/index.html');
  if (!target) throw new Error('The isolated TestVault desktop window was not found.');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop debugging connection timed out.')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); accept(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Desktop debugging connection failed.')); }, { once: true });
  });
  ws.addEventListener('message', event => {
    let result; try { result = JSON.parse(event.data); } catch { return; }
    const entry = pending.get(result.id); if (!entry) return;
    pending.delete(result.id); clearTimeout(entry.timer); entry.accept(result);
  });
  const actual = await evaluate('app.vault.adapter.getBasePath()');
  assert.equal(await realpath(actual), expected, 'The actual host vault must match the explicitly isolated vault.');
  vaultVerified = true;
  let setup;
  if (resumeWorkflow) {
    setup = await phase('恢复现有真实宿主、内存密钥与已完成初稿候选', async () => {
      await evaluate(String.raw`(()=>{
        const q=window.dcrealqa;
        if(!q||q.host!==app.plugins.plugins['draft-companion']?.controller||q.host.running||typeof q.originalGetSecret!=='function')throw new Error('Existing paused workflow is unavailable.');
        if(q.host.target()?.path!=='Workflow.md'||q.host.currentSession()?.candidate?.state!=='ready')throw new Error('The completed initial candidate is unavailable.');
        q.key=${JSON.stringify(secret)};
        q.storage.getSecret=function(ref){const live=window.dcrealqa;return ref==='dc-real-api-memory-only'?live.key:live.originalGetSecret.call(this,ref);};
        const provider=q.host.data.providers.find(p=>p.id==='real-api-qa');
        if(!provider||provider.secretRef!=='dc-real-api-memory-only')throw new Error('Memory-only provider configuration is unavailable.');
        provider.baseUrl=${JSON.stringify(configuration.baseUrl)};provider.model=${JSON.stringify(configuration.model)};provider.stream=true;provider.timeoutMs=120000;
        return true;
      })()`);
      getterInstalled = true;
      await waitFor('!!document.querySelector(".dc-input")');
      return await evaluate('({reusedActualHost:true,historyRetained:true,priorRequestsNotRepeated:true,candidateReady:dcrealqa.host.currentSession().candidate.state==="ready",candidateCharacters:dcrealqa.host.currentSession().candidate.replacement.length})');
    });
  } else {
  setup = await phase('隔离真实 Obsidian 宿主与内存密钥配置', async () => {
    await evaluate(String.raw`(async()=>{
      if(window.dcrealqa)throw new Error('Another real QA run is present.');
      document.querySelectorAll('.modal-close-button').forEach(b=>b.click());app.setting.close();
      if(app.plugins.plugins['draft-companion']?.controller?.running)throw new Error('Existing plugin generation is busy.');
      await app.plugins.disablePlugin('draft-companion');await app.plugins.enablePlugin('draft-companion');
      const h=app.plugins.plugins['draft-companion']?.controller;if(!h||h.running)throw new Error('Plugin is unavailable or busy.');
      const storage=h.app.secretStorage;
      window.dcrealqa={host:h,key:${JSON.stringify(secret)},storage,originalGetSecret:storage.getSecret,
        originalDescriptor:Object.getOwnPropertyDescriptor(storage,'getSecret'),
        originalProviders:structuredClone(h.data.providers),originalActiveProvider:h.data.activeProviderId,
        originalPreferences:h.data.preferences};
      storage.getSecret=function(ref){const q=window.dcrealqa;return ref==='dc-real-api-memory-only'?q.key:q.originalGetSecret.call(this,ref);};
      h.data.providers=[{id:'real-api-qa',name:'真实 API 合成验证',baseUrl:${JSON.stringify(configuration.baseUrl)},secretRef:'dc-real-api-memory-only',model:${JSON.stringify(configuration.model)},stream:true,timeoutMs:120000}];
      h.data.activeProviderId='real-api-qa';h.data.preferences='自然简短的中文。讨论尽量120字以内，候选完整Markdown正文不超过400字符。不虚构经历，保留作者判断与既有Markdown引用、代码结构。';
      for(const [path,text] of ${JSON.stringify(editingOnly ? [['A.md',aSeed],['B.md',bSeed]] : [['A.md',aSeed],['Workflow.md',frontmatter + seedBody],['B.md',bSeed]])}){
        const file=app.vault.getAbstractFileByPath(path);if(file)await app.vault.process(file,()=>text);else await app.vault.create(path,text);
      }
      const leaf=app.workspace.getLeaf(false);await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(editingOnly || isolationOnly ? 'A.md' : 'Workflow.md')}));await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);
      const view=leaf.view;if(!view.editor)throw new Error('The loaded leaf is not a source Markdown editor.');
      if(${editingOnly || isolationOnly}){dcrealqa.aView=view;view.editor.setValue(${JSON.stringify(aSeed)});}else{dcrealqa.workflowView=view;view.editor.setValue(${JSON.stringify(frontmatter + seedBody)});}
      await h.clearSession();await h.setBrief('仅使用合成素材；讨论120字内，replacement完整Markdown不超过400字符。逐字保留作者判断：工具应保留人的判断，修改需要先预览。保留H1/H2、双链、嵌入、图片/外链与代码围栏。');
      app.commands.executeCommandById('draft-companion:open-sidebar');return true;
    })()`);
    getterInstalled = true;
    await waitFor('!!document.querySelector(".dc-input")');
    assert.equal(await evaluate('dcrealqa.host.target().path'), editingOnly || isolationOnly ? 'A.md' : 'Workflow.md');
    return { isolatedVault: true, memoryOnlySecret: true, stream: true, timeoutMs: 120000 };
  });
  }
  if (!setup) throw new Error('The isolated desktop setup failed; no further actions were performed.');

  if (!isolationOnly) {
  if (!editingOnly) {
  const unchanged = async () => assert.equal(await evaluate('dcrealqa.workflowView.editor.getValue()===dcrealqa.workflowBeforeDiscussion'), true, 'Discussion must not write the document.');
  if (!resumeWorkflow) {
  await phase('真实宿主获取模型列表', async () => {
    await startOperation('return q.host.models(q.host.data.providers[0]).then(models=>{q.modelCount=models.length;q.suppliedModelListed=models.some(m=>m.id===q.host.data.providers[0].model);return "models";});');
    await awaitOperation('模型列表');
    return await evaluate('({modelCount:dcrealqa.modelCount,suppliedModelListed:dcrealqa.suppliedModelListed,manualConfiguredModelRetained:true})');
  });
  await phase('真实宿主独立聊天测试且不创建会话消息', async () => {
    await evaluate('dcrealqa.messagesBeforeTest=Object.values(dcrealqa.host.data.sessions).reduce((n,s)=>n+s.messages.length,0);dcrealqa.sessionsBeforeTest=Object.keys(dcrealqa.host.data.sessions).sort().join(",");true');
    await startOperation('return q.host.testProvider(q.host.data.providers[0]);');
    const result = await awaitOperation('独立聊天测试');
    assert.equal(await evaluate('Object.values(dcrealqa.host.data.sessions).reduce((n,s)=>n+s.messages.length,0)===dcrealqa.messagesBeforeTest'), true);
    assert.equal(await evaluate('Object.keys(dcrealqa.host.data.sessions).sort().join(",")===dcrealqa.sessionsBeforeTest'), true);
    assert(result.characters > 0, 'The independent test must return text.');
    return { responseCharacters: result.characters, sessionMessagesUnchanged: true, sessionsUnchanged: true };
  });

  await evaluate('dcrealqa.workflowBeforeDiscussion=dcrealqa.workflowView.editor.getValue();true');
  await runRound('六角色：选题', 'topic-editor', '从当前合成场景选一个最具体的写作方向，说明读者与价值；最多120字，不要追问。');
  await phase('选题仅讨论，不写回正文', async () => { await unchanged(); return { unchanged: true }; });
  await runRound('六角色：大纲', 'outline-editor', '我选定“把AI讨论留在文稿旁并先预览再应用”。给三个小节的大纲，每节一句，100字内。');
  await phase('大纲仅讨论，不写回正文', async () => { await unchanged(); return { unchanged: true }; });
  const drafted = await runRound('六角色：初稿 JSON 候选', 'draft-author', `根据选定方向和大纲生成短初稿。replacement完整Markdown不超过400字符。逐字保留“${authorJudgment}”。保留原H1/H2层级、双链、嵌入、图片外链和typescript代码围栏。不加新事实。`,'edit');
  if (drafted) await applyThroughModal('六角色：实际差异弹窗应用初稿');
  else checks.push({ name: '初稿应用', passed: false, skipped: true, error: 'Model output failed actual plugin validation; no format repair or application was attempted.' });
  } else {
    await applyThroughModal('恢复流程：实际差异弹窗应用已有初稿');
  }
  await evaluate('dcrealqa.workflowBeforeDiscussion=dcrealqa.workflowView.editor.getValue();true');
  await runRound('六角色：审稿', 'managing-editor', '审阅当前真实正文，仅列1个最值得改善的衔接问题，引用一句原文；100字内，标记建议，不直接改稿。');
  await runRound('六角色：记录用户明确拒绝', 'managing-editor', `我拒绝任何删除或弱化作者判断的建议。必须逐字保留“${authorJudgment}”。只回复“已记录，后续仅改善衔接”，不要改稿。`);
  await phase('审稿及拒绝记录保持正文不变', async () => {
    await unchanged();
    assert.equal(await evaluate('dcrealqa.host.currentSession().messages.some(m=>m.role==="user"&&m.content.includes("我拒绝"))'), true);
    return { unchanged: true, userRejectionInActualSession: true };
  });
  const revised = await runRound('六角色：指定最小改稿 JSON 候选', 'revision-editor', `仅改善开头到“具体判断”小节的衔接，其他Markdown结构、引用、代码与事实保持。遵守我拒绝删除作者判断的决定，逐字保留“${authorJudgment}”。replacement完整Markdown400字符内，说明和核实项留在正文外。`, 'edit');
  if (revised) await applyThroughModal('六角色：实际差异弹窗应用指定改稿');
  else checks.push({ name: '指定改稿应用', passed: false, skipped: true, error: 'Model output failed actual plugin validation; no format repair or application was attempted.' });
  await evaluate('dcrealqa.workflowBeforeDiscussion=dcrealqa.workflowView.editor.getValue();true');
  await runRound('六角色：标题与摘要', 'title-publish-check', '根据当前正文给2个标题、推荐1个及40字内发布摘要；总回复120字以内，不写入正文，不声称核实或发布。');
  await phase('六角色结果保留作者判断和 Markdown，标题摘要不混入正文', async () => {
    await unchanged();
    const quality = await evaluate(String.raw`(()=>{const text=dcrealqa.workflowView.editor.getValue();const body=text.slice(${frontmatter.length});return {
      frontmatterPreserved:text.startsWith(${JSON.stringify(frontmatter)}),authorJudgmentPreserved:text.includes(${JSON.stringify(authorJudgment)}),
      bodyCharacters:body.length,shortDraft:body.length<=400,h1:/^# /m.test(body),h2:/^## /m.test(body),
      wiki:body.includes('[[合成资料]]'),embed:body.includes('![[合成案例#片段]]'),image:body.includes('![流程示意](assets/合成示意图.png)'),
      link:body.includes('[示例材料](https://example.com)'),code:body.includes("const workflow = ['讨论', '预览', '应用', '撤回'];")&&body.includes("console.log(workflow.join(' → '));")&&body.includes('\x60\x60\x60typescript'),
      proseOnly:!/(?:explanation|replacement|候选正文|发布摘要：|待核实事项：)/.test(body)};})()`);
    for (const [key, value] of Object.entries(quality)) if (typeof value === 'boolean' && key !== 'shortDraft') assert.equal(value, true, `Document quality check failed: ${key}.`);
    return quality;
  });

  }
  await phase('选区测试准备：合成 A 文稿与实际未落盘编辑器', async () => {
    await evaluate(String.raw`(async()=>{
      const q=dcrealqa;if(!${editingOnly}){const leaf=app.workspace.getLeavesOfType('markdown')[0]||app.workspace.getLeaf('tab');await leaf.openFile(app.vault.getAbstractFileByPath('A.md'));await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);q.aView=leaf.view;}if(!q.aView?.editor||q.aView.file?.path!=='A.md')throw new Error('The saved A source editor is unavailable.');
      q.aView.editor.setValue(${JSON.stringify(aSeed)});await q.host.clearSession();await q.host.setBrief('仅修改发送时冻结的选区。完整replacement只含目标句子，保留中文与emoji。');
      const e=q.aView.editor;q.aBefore=e.getValue();q.from=q.aBefore.indexOf('冻结选区原句：');q.to=q.aBefore.indexOf('\n',q.from);
      e.setSelection(e.offsetToPos(q.from),e.offsetToPos(q.to));document.querySelector('.dc-input').focus();return true;
    })()`);
    assert.equal(await evaluate('dcrealqa.host.target().path'), 'A.md');
    return { sourceEditorBuffer: true, sidebarFocusBoundToA: true };
  });
  const selected = await runRound('实际 API：冻结发送选区并在生成时移动光标', 'revision-editor', '只将冻结选区替换为这句完整文本：冻结选区新句：讨论应该紧贴当前文稿。📝。不要改范围外任何字符；replacement不要额外说明。', 'edit', 'selection', async () => {
    await waitFor('!!dcrealqa.host.running && dcrealqa.host.running.text.length>0 || dcrealqa.operation.done', 125000);
    await evaluate('dcrealqa.aView.editor.setCursor({line:0,ch:0});true');
  });
  if (selected) {
    await applyThroughModal('实际选区候选通过原生差异弹窗应用');
    await phase('冻结选区范围外逐字符一致，重复应用被阻止，撤回恢复全文', async () => {
      assert.equal(await evaluate(String.raw`(()=>{const q=dcrealqa;const text=q.aView.editor.getValue();const c=q.applying;return c.scope==='selection'&&c.replacement.includes('冻结选区新句：')&&c.replacement.includes('📝')&&c.from===q.from&&c.to===q.to&&text.slice(0,q.from)===q.aBefore.slice(0,q.from)&&text.slice(q.from+c.replacement.length)===q.aBefore.slice(q.to);})()`), true);
      assert.equal(await evaluate(String.raw`(async()=>{const q=dcrealqa;const text=q.aView.editor.getValue();try{await q.host.apply(q.applying);return false;}catch{return q.aView.editor.getValue()===text;}})()`), true);
      await evaluate('dcrealqa.host.undo()');
      assert.equal(await evaluate('dcrealqa.aView.editor.getValue()===dcrealqa.aBefore'), true);
      return { selectionFrozen: true, outsideCharactersIdentical: true, repeatedApplyBlocked: true, exactUndo: true };
    });
  } else checks.push({ name: '选区应用与撤回', passed: false, skipped: true, error: 'No valid real-model edit candidate; no format repair was attempted.' });

  await phase('本地明确删除候选复用：手动改动后应用冲突不覆盖', async () => {
    assert.equal(await evaluate(String.raw`(async()=>{
      const q=dcrealqa;const e=q.aView.editor;e.setValue(q.aBefore);e.setSelection(e.offsetToPos(q.from),e.offsetToPos(q.to));
      await q.host.deleteRange('selection');const c=q.host.currentSession().candidate;
      e.replaceRange('手动改动保留\n',e.offsetToPos(e.getValue().length));const changed=e.getValue();
      try{await q.host.apply(c);return false;}catch{return c.state==='stale'&&e.getValue()===changed;}
    })()`), true);
    return { noAdditionalModelRequest: true, manualChangesPreserved: true };
  });
  await phase('本地明确删除候选复用：后续手动编辑导致撤回冲突', async () => {
    assert.equal(await evaluate(String.raw`(async()=>{
      const q=dcrealqa;const e=q.aView.editor;e.setValue(q.aBefore);e.setSelection(e.offsetToPos(q.from),e.offsetToPos(q.to));
      await q.host.deleteRange('selection');await q.host.apply(q.host.currentSession().candidate);
      e.replaceRange('后续手动编辑保留\n',e.offsetToPos(e.getValue().length));const changed=e.getValue();
      try{await q.host.undo();return false;}catch{return !!q.host.currentSession().undo&&e.getValue()===changed;}
    })()`), true);
    return { noAdditionalModelRequest: true, laterEditPreserved: true, oldVersionStillAvailable: true };
  });

  }
  if (!selectionOnly) await phase('真实流式 A/B 隔离复验：30条简短建议首块后切 B 并停止', async () => {
    await evaluate(String.raw`(async()=>{const q=dcrealqa;const leaf=app.workspace.getLeaf(false);await leaf.openFile(app.vault.getAbstractFileByPath('A.md'));await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);q.aView=leaf.view;if(!q.aView.editor)throw new Error('A source editor is unavailable after deferred loading.');if(${isolationOnly}){q.aView.editor.setValue(${JSON.stringify(aSeed)});await q.host.clearSession();}return true;})()`);
    await chooseRole('topic-editor');
    await startOperation(`q.isolationSession=q.host.currentSession();return q.host.send('仅本轮用于停止测试：连续列出30条简短的Markdown写作建议，每条一句话，用编号列表持续输出。不要写入文稿，不编造真实经历，不提供选题方向，也不要在30条之前主动结束。','discuss','body');`);
    const started = performance.now(); let lastProgress = started; let received = 0;
    while (performance.now() - started < 125000) {
      const state = await evaluate('({running:!!dcrealqa.host.running,characters:dcrealqa.host.running?.text.length||0,done:dcrealqa.operation.done,error:dcrealqa.operation.error})');
      if (state.error) throw new Error(state.error);
      if (state.running && state.characters > 0) { received = state.characters; break; }
      if (state.done) throw new Error('The provider completed before an interruptible streaming text block was observable.');
      if (performance.now() - lastProgress > 10000) { progress(`    首个流式文本块：等待 ${Math.round((performance.now() - started) / 1000)} 秒`); lastProgress = performance.now(); }
      await sleep(120);
    }
    if(!received){
      const finalState=await evaluate('({running:!!dcrealqa.host.running,characters:dcrealqa.host.running?.text.length||0,done:dcrealqa.operation.done,error:dcrealqa.operation.error})');
      if(finalState.error)throw new Error(finalState.error);
      if(finalState.running&&finalState.characters>0)received=finalState.characters;
      else if(finalState.done)throw new Error('The provider completed before an interruptible streaming text block was observable.');
    }
    assert(received > 0, 'An actual streamed block must arrive before stopping.');
    await evaluate(String.raw`(async()=>{const q=dcrealqa;const leaf=app.workspace.getLeaf(false);await leaf.openFile(app.vault.getAbstractFileByPath('B.md'));await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);q.bView=leaf.view;if(!q.bView.editor)throw new Error('B source editor is unavailable after deferred loading.');q.bBefore=q.bView.editor.getValue();await q.host.clearSession();q.bMessagesBefore=JSON.stringify(q.host.currentSession().messages);q.bBaselineMessageCount=q.host.currentSession().messages.length;return true;})()`);
    assert.equal(await evaluate('dcrealqa.host.target().path'), 'B.md');
    assert.equal(await evaluate('dcrealqa.host.currentSession().messages.every(m=>m.role==="event")'), true);
    assert.equal(await evaluate('document.querySelector(".dc-global-running").textContent.includes("A.md")'), true);
    await evaluate(String.raw`(()=>{const button=document.querySelector('.dc-global-running button');if(!button)throw new Error('Global Stop entry is missing.');button.click();return true;})()`);
    await waitFor('!dcrealqa.host.running'); await awaitOperation('停止后的网络清理', 10000); await sleep(250);
    assert.equal(await evaluate('dcrealqa.bView.editor.getValue()===dcrealqa.bBefore&&JSON.stringify(dcrealqa.host.currentSession().messages)===dcrealqa.bMessagesBefore&&dcrealqa.host.currentSession().messages.every(m=>m.role==="event")'), true);
    assert.equal(await evaluate('dcrealqa.isolationSession.messages.some(m=>m.role==="assistant"&&m.status==="stopped")'), true);
    return { inputVariant: '30 numbered short writing suggestions', actualStreamingCharactersBeforeStop: received, bBaselineEventMessages: await evaluate('dcrealqa.bBaselineMessageCount'), switchedToB: true, actualSidebarStopClick: true, bTextUnchanged: true, bSessionUnchanged: true, aReplyStopped: true };
  });
} catch (error) {
  fatal = safeError(error); progress(`真实宿主验证中断：${fatal}`);
} finally {
  let cleaned = false;
  if (ws && ws.readyState === WebSocket.OPEN && vaultVerified) {
    try {
      cleaned = await evaluate(String.raw`(async()=>{
        const q=window.dcrealqa;if(!q)return true;
        try{q.host.stop();}catch{}
        if(q.originalDescriptor)Object.defineProperty(q.storage,'getSecret',q.originalDescriptor);else delete q.storage.getSecret;
        delete q.key;
        try{q.host.data.providers=q.originalProviders;q.host.data.activeProviderId=q.originalActiveProvider;q.host.data.preferences=q.originalPreferences;await q.host.saveSettings();}catch{}
        delete window.dcrealqa;return true;
      })()`);
    } catch { cleaned = false; }
  }
  // Clear local references before writing any result. Output contains only fixed check names, booleans and counts.
  if (configuration) configuration.key = '';
  const report = {
    startedAt, completedAt: new Date().toISOString(), mode: editingOnly ? 'editing-only' : resumeWorkflow ? 'resumed-workflow' : isolationOnly ? 'isolation-only' : 'full-workflow', provider: 'real user-authorized API',
    baseUrl: configurationValidated ? configuration.baseUrl : '', model: configurationValidated ? configuration.model : '',
    stream: true, timeoutMs: 120000, isolatedVaultVerified: vaultVerified,
    secretPersisted: false, getterInstalled, memorySecretAndGetterCleaned: cleaned,
    formatRepairAttempted: false, fatal: fatal || undefined, checks,
    passed: !fatal && checks.every(check => check.passed) && cleaned,
    limitations: ['Synthetic materials only; this verifies basic plugin behavior, not factual accuracy or publication readiness.', 'Stopping a request does not guarantee that the provider stops billing.'],
  };
  const encoded = JSON.stringify(report, null, 2);
  const safeEncoded = secret ? encoded.split(secret).join('[REDACTED]') : encoded;
  secret = '';
  try { await writeFile(reportPath, `${safeEncoded}\n`); progress(`无密钥报告已写入 docs/${reportName}；${report.passed ? '全部通过' : '含未通过项'}`); }
  catch { progress('报告写入失败；未打印任何配置或原始异常。'); }
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Debug connection closed.')); }
  pending.clear();
  ws?.close();
  if (!report.passed) process.exitCode = 1;
}
