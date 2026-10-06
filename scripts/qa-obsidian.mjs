/** Actual Obsidian desktop QA. Requires an explicitly isolated synthetic test vault. */
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
const arg = key => args[args.indexOf(key) + 1];
const expected = args.includes('--vault') ? await realpath(arg('--vault')) : '';
if (!expected || !expected.includes('draft-companion-qa-') || !expected.endsWith('/TestVault')) throw new Error('Only an isolated draft-companion-qa-*/TestVault is permitted.');
const port = args.includes('--port') ? Number(arg('--port')) : 9334;
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = pages.find(page => page.title.includes('TestVault') && page.url === 'app://obsidian.md/index.html');
if (!target) throw new Error('Isolated TestVault window was not found.');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
let serial = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const result = JSON.parse(event.data);
  if (result.id && pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); }
});
async function call(method, params = {}) {
  const id = ++serial;
  const response = new Promise(resolve => pending.set(id, resolve));
  ws.send(JSON.stringify({ id, method, params }));
  const value = await response;
  if (value.error) throw new Error(JSON.stringify(value.error));
  return value.result;
}
async function evaluate(expression) {
  const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(expression, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await evaluate(expression)) return; await sleep(50); }
  throw new Error(`Timed out: ${expression}`);
}
const checks = [];
const fixtureText = await readFile(resolve('fixtures/测试文稿.md'), 'utf8');
try {
  const actualPath = await evaluate('app.vault.adapter.getBasePath()');
  assert.equal(await realpath(actualPath), expected, 'No operations may run against another vault.');
  await evaluate('(async()=>{document.querySelectorAll(".modal-close-button").forEach(b=>b.click());await app.plugins.disablePlugin("draft-companion");await app.plugins.enablePlugin("draft-companion");app.setting.close();document.body.classList.remove("theme-dark");document.body.classList.add("theme-light");return true;})()');
  await evaluate(`(async()=>{
    window.dcqa = { host: app.plugins.plugins['draft-companion'].controller };
    const h=dcqa.host;
    h.data.providers=[{id:'qa',name:'明确标注的本地模拟服务',baseUrl:'http://127.0.0.1:43127/v1',secretRef:'',model:'mock-draft-model',stream:true,timeoutMs:60000}];
    h.data.activeProviderId='qa'; await h.saveSettings();
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('A.md'));
    dcqa.aView=app.workspace.getMostRecentLeaf().view;
    dcqa.aView.editor.setValue(${JSON.stringify(fixtureText)});
    await h.clearSession();
    dcqa.aOriginal=dcqa.aView.editor.getValue();
    app.commands.executeCommandById('draft-companion:open-sidebar'); return true;
  })()`);
  await wait('!!document.querySelector(".dc-input")');
  assert.equal(await evaluate('dcqa.host.target().path'), 'A.md');
  assert.equal((await evaluate('dcqa.host.models(dcqa.host.data.providers[0])')).length, 2);
  checks.push('真实插件加载、原生侧栏打开、Node 模型列表连接');

  await evaluate(String.raw`(()=>{const e=dcqa.aView.editor;const end=e.offsetToPos(e.getValue().length);e.replaceRange('\n尚未落盘的 GUI 中文段落 😀\n',end);document.querySelector('.dc-input').focus();return true;})()`);
  assert.equal(await evaluate('dcqa.host.target().path'), 'A.md');
  await evaluate('dcqa.host.send("TEST:DISCUSS 检查最新全文", "discuss", "auto")');
  const records = await (await fetch('http://127.0.0.1:43127/__requests')).json();
  assert(records.at(-1).messages.at(-1).content.includes('尚未落盘的 GUI 中文段落 😀'));
  checks.push('侧栏焦点保持绑定；实际请求包含编辑器最新中文全文');

  await evaluate(String.raw`(()=>{const e=dcqa.aView.editor;dcqa.before=e.getValue();dcqa.from=dcqa.before.indexOf('这份文稿用于验证');dcqa.to=dcqa.before.indexOf('\n',dcqa.from);e.setSelection(e.offsetToPos(dcqa.from),e.offsetToPos(dcqa.to));return true;})()`);
  await evaluate(`dcqa.host.send('TEST:EDIT TEST:REPLACE("这份文稿用于验证","这份文稿用来验证")', 'edit', 'auto')`);
  assert.equal(await evaluate('dcqa.host.currentSession().candidate.scope'), 'selection');
  await evaluate(`(()=>{dcqa.aView.editor.setCursor({line:0,ch:0});[...document.querySelectorAll('.dc-candidate-bar button')].find(b=>b.textContent==='预览差异').click();return true;})()`);
  await wait('!!document.querySelector(".dc-candidate-modal")');
  await call('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(resolve('docs/gui-light.png'), Buffer.from(result.data, 'base64')));
  await evaluate(`(()=>{[...document.querySelectorAll('.dc-candidate-modal button')].find(b=>b.textContent==='应用整批修改').click();return true;})()`);
  await wait('dcqa.host.currentSession().candidate.state === "applied"');
  assert.equal(await evaluate(`(()=>{const next=dcqa.aView.editor.getValue();return next.slice(0,dcqa.from)===dcqa.before.slice(0,dcqa.from)&&next.slice(dcqa.from+dcqa.host.currentSession().candidate.replacement.length)===dcqa.before.slice(dcqa.to);})()`), true);
  await evaluate('dcqa.host.undo()');
  assert.equal(await evaluate('dcqa.aView.editor.getValue()===dcqa.before'), true);
  checks.push('真实差异弹窗点击应用；冻结选区外字符相等；编辑器事务与条件撤回');

  await evaluate('dcqa.host.send("TEST:EDIT 修改正文", "edit", "body")');
  await evaluate('dcqa.aView.editor.replaceRange("手工改动",{line:1,ch:0})');
  const conflict = await evaluate('(async()=>{try{await dcqa.host.apply(dcqa.host.currentSession().candidate);return false;}catch{return dcqa.aView.editor.getValue().includes("手工改动");}})()');
  assert.equal(conflict, true);
  await evaluate('dcqa.host.send("TEST:EDIT 最新文稿", "edit", "body")');
  await evaluate('dcqa.host.apply(dcqa.host.currentSession().candidate)');
  await evaluate('dcqa.aView.editor.replaceRange("后续编辑",{line:8,ch:0})');
  assert.equal(await evaluate('(async()=>{try{await dcqa.host.undo();return false;}catch{return dcqa.aView.editor.getValue().includes("后续编辑");}})()'), true);
  checks.push('真实应用冲突与撤回冲突阻止覆盖后续编辑');

  await evaluate(`(()=>{dcqa.host.send('TEST:DISCUSS TEST:SLOW A 的请求','discuss','body').catch(()=>{});return true;})()`);
  await wait('!!dcqa.host.running && dcqa.host.running.text.length > 0');
  await evaluate(`(async()=>{await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('B.md'));dcqa.bView=app.workspace.getMostRecentLeaf().view;dcqa.bBefore=dcqa.bView.editor.getValue();dcqa.host.data.providers[0].model='mock-review-model';await dcqa.host.saveSettings();return true;})()`);
  assert.equal(await evaluate('dcqa.host.target().path'), 'B.md');
  assert.equal(await evaluate('dcqa.host.currentSession().messages.length'), 0);
  assert.equal(await evaluate('document.querySelector(".dc-global-running").textContent.includes("A.md")'), true);
  await evaluate('dcqa.host.stop()');
  await sleep(250);
  assert.equal(await evaluate('!dcqa.host.running && dcqa.bView.editor.getValue()===dcqa.bBefore && dcqa.host.currentSession().messages.length===0'), true);
  checks.push('真实 A/B 切换隔离、生成模型冻结、停止后不污染 B');

  // The following IME actions go through the actual sidebar handlers.
  assert.equal(await evaluate(`(()=>{const input=document.querySelector('.dc-input');input.value='TEST:DISCUSS 不应发送';input.dispatchEvent(new Event('input',{bubbles:true}));const count=dcqa.host.currentSession().messages.length;input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,isComposing:true,bubbles:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));return count===dcqa.host.currentSession().messages.length&&!dcqa.host.running;})()`), true);
  checks.push('真实侧栏中文输入法事件不误发送');
  await evaluate('document.body.classList.remove("theme-light");document.body.classList.add("theme-dark")');
  await call('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(resolve('docs/gui-dark.png'), Buffer.from(result.data, 'base64')));
  await evaluate('dcqa.host.openSettings()');
  await wait('!!document.querySelector(".dc-settings")');
  await evaluate(`(()=>{[...document.querySelectorAll('.dc-settings button')].find(b=>b.textContent==='添加服务').click();return true;})()`);
  await wait('!!document.querySelector(".dc-settings-modal")');
  assert.equal(await evaluate('document.querySelector(".dc-settings-modal").textContent.includes("API 密钥")'), true);
  await evaluate(`(()=>{[...document.querySelectorAll('.dc-settings-modal button')].find(b=>b.textContent==='取消').click();[...document.querySelectorAll('.dc-settings button')].find(b=>b.textContent==='获取模型并选择').click();return true;})()`);
  await wait('!!document.querySelector(".dc-model-search")');
  await evaluate(`(()=>{const input=document.querySelector('.dc-model-search');input.value='draft';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  assert.equal(await evaluate('document.querySelectorAll(".dc-model-option").length'), 1);
  await evaluate('document.querySelector(".dc-model-option").click()');
  await wait('!document.querySelector(".dc-model-search")');
  assert.equal(await evaluate('dcqa.host.data.providers[0].model'), 'mock-draft-model');
  checks.push('真实设置面板与深色主题渲染');
  checks.push('真实官方密钥组件可打开；模型获取、搜索与选择界面通过（未输入真实密钥）');

  await evaluate(`(async()=>{
    document.querySelector('.modal-close-button')?.click();
    const file=app.vault.getAbstractFileByPath('Workflow.md')||await app.vault.create('Workflow.md',dcqa.aOriginal);
    await app.workspace.getLeaf(false).openFile(file);dcqa.workflowView=app.workspace.getMostRecentLeaf().view;
    const h=dcqa.host;
    for(const [name,input,mode] of [
      ['选题编辑','TEST:DISCUSS 找到具体场景','discuss'],
      ['大纲编辑','TEST:OUTLINE 搭建大纲','discuss'],
      ['初稿作者','TEST:EDIT 生成初稿','edit'],
      ['责任编辑','TEST:REVIEW 审阅','discuss'],
      ['责任编辑','TEST:DISCUSS 我拒绝删除作者判断，必须保留人的判断','discuss'],
      ['改稿编辑','TEST:EDIT TEST:REPLACE("更容易对应","更加清楚对应") 只改善衔接，保留作者判断','edit'],
      ['标题与发布检查','TEST:TITLE 标题与摘要','discuss']
    ]){
      await h.chooseRole(h.data.roles.find(r=>r.name===name).id);
      await h.send(input,mode,'body');
      if(mode==='edit')await h.apply(h.currentSession().candidate);
    }
    return true;
  })()`);
  assert.equal(await evaluate('dcqa.workflowView.editor.getValue().includes("作者判断：工具应保留人的判断") && !dcqa.workflowView.editor.getValue().includes("这是确定性模拟响应") && !dcqa.workflowView.editor.getValue().includes("发布摘要：")'), true);
  checks.push('真实 Obsidian 六角色创作完整流程；正文不混入说明、核实清单或标题摘要');

  const sessionId = await evaluate('dcqa.host.currentSession().id');
  await evaluate('(async()=>{await app.plugins.disablePlugin("draft-companion");await app.plugins.enablePlugin("draft-companion");dcqa.host=app.plugins.plugins["draft-companion"].controller;return true;})()');
  assert.equal(await evaluate('dcqa.host.currentSession().id'), sessionId);
  assert.equal(await evaluate('dcqa.host.currentSession().messages.some(m=>m.content.includes("我拒绝删除作者判断"))'), true);
  await evaluate('(async()=>{await app.vault.rename(dcqa.workflowView.file,"Workflow-renamed.md");return true;})()');
  assert.equal(await evaluate('dcqa.host.currentSession().document.path'), 'Workflow-renamed.md');
  await evaluate('dcqa.host.send("TEST:EDIT 改名后的文稿", "edit", "body")');
  await evaluate('(async()=>{dcqa.deletedSession=dcqa.host.currentSession();await app.vault.delete(dcqa.workflowView.file);return true;})()');
  assert.equal(await evaluate('dcqa.deletedSession.document.deleted && dcqa.deletedSession.candidate.state==="stale"'), true);
  checks.push('真实插件重载恢复会话与拒绝记录；重命名关联更新；删除使候选失效');
  await writeFile(resolve('docs/gui-verification.json'), JSON.stringify({ date: '2026-10-06', windowTitle: target.title, provider: 'local deterministic mock, no real API key', checks }, null, 2) + '\n');
  console.log(JSON.stringify({ windowTitle: target.title, checks }, null, 2));
} finally { ws.close(); }
