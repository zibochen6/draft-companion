/** Native editor acceptance for 0.2.0. Runs only against the isolated synthetic vault. */
import { readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const vault = await realpath(value('--vault', ''));
if (!vault.includes('draft-companion-qa-') || !vault.endsWith('/TestVault')) throw new Error('Only an isolated draft-companion-qa-*/TestVault is permitted.');
const port = Number(value('--port', '9334'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid desktop debug port is required.');
const fixture = await readFile(resolve('fixtures/公众号批注长文.md'), 'utf8');
const reportDirectory = resolve('docs/qa-0.2.0');
await mkdir(reportDirectory, { recursive: true });

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(item => item.type === 'page' && item.url === 'app://obsidian.md/index.html' && item.title.includes('TestVault'));
if (!page) throw new Error('The isolated TestVault desktop window is unavailable.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => { ws.addEventListener('open', resolveOpen, { once: true }); ws.addEventListener('error', rejectOpen, { once: true }); });
let serial = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data); const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id); clearTimeout(entry.timer);
  entry.resolve(message);
});
function call(method, params = {}) {
  const id = ++serial;
  return new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error('Desktop editor acceptance timed out.')); }, 30000);
    pending.set(id, { resolve: resolveCall, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error('A native editor assertion failed.');
  return result.result?.result?.value;
}
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function wait(expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(75); }
  throw new Error('Expected native editor state did not arrive.');
}
const checks = [];
async function phase(name, action) {
  try { const details = await action(); checks.push({ name, passed: true, ...details }); }
  catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : 'failure' }); throw error; }
}

let failure;
try {
  const base = await evaluate('app.vault.adapter.getBasePath()');
  assert.equal(await realpath(base), vault);
  await phase('隔离宿主、合成文稿和本地模拟服务', async () => {
    const models = await fetch('http://127.0.0.1:43127/v1/models'); assert.equal(models.ok, true);
    await evaluate(`(async()=>{
      const base=app.vault.adapter.getBasePath();if(!base.includes('draft-companion-qa-')||!base.endsWith('/TestVault'))throw new Error('not isolated');
      const plugin=app.plugins.plugins['draft-companion'];if(!plugin?.controller)throw new Error('plugin unavailable');
      for(const existing of app.workspace.getLeavesOfType('markdown'))if(['Native.md','NativeCRLF.md'].includes(existing.view.file?.path||''))existing.detach();
      const host=plugin.controller,file=app.vault.getAbstractFileByPath('Native.md')||await app.vault.create('Native.md','');
      const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);
      const view=leaf.view;if(!view?.editor)throw new Error('source editor unavailable');await view.setState({...await view.getState(),mode:'source',source:false},{history:false});view.editor.setValue(${JSON.stringify(fixture)});view.editor.setCursor({line:0,ch:0});app.workspace.setActiveLeaf(leaf,{focus:true});host.documents.focus(leaf);
      const session=host.currentSession();delete session.review;await host.clearSession();
      host.data.providers=[{id:'native-editor-mock',name:'本地模拟服务（编辑器验收）',baseUrl:'http://127.0.0.1:43127/v1',secretRef:'',model:'mock-review-model',stream:true,timeoutMs:60000}];host.data.activeProviderId='native-editor-mock';await host.saveSettings();
      window.dcNative={host,leaf,view};return true;
    })()`);
    return { syntheticOnly: true, mockProvider: true };
  });

  await phase('纯源文与 Live Preview 高亮、阅读模式隐藏高亮与长文滚动', async () => {
    await evaluate('dcNative.host.review("TEST:LONG 原生编辑器验收","body")');
    await wait('dcNative.host.currentSession().review?.suggestions.length===5');
    await wait('document.querySelectorAll(".workspace-leaf.mod-active .dc-review-highlight").length>0');
    const liveCount = await evaluate('document.querySelectorAll(".workspace-leaf.mod-active .dc-review-highlight").length');
    const liveSurface = await evaluate(`(async()=>{const source=document.querySelector('.markdown-source-view.mod-cm6'),state=await dcNative.view.getState();return{sourceEditor:!!source,livePreviewPreference:app.vault.getConfig('livePreview')===true,sourceFlag:state.source};})()`);
    assert.equal(liveSurface.sourceEditor, true); assert.equal(liveSurface.sourceFlag, false);
    await evaluate('app.commands.executeCommandById("editor:toggle-source")');
    await wait(`(async()=>{const s=await dcNative.view.getState();return s.source===true&&document.querySelectorAll('.workspace-leaf.mod-active .dc-review-highlight').length>0;})()`);
    const sourceCount = await evaluate('document.querySelectorAll(".workspace-leaf.mod-active .dc-review-highlight").length');
    await evaluate('app.commands.executeCommandById("editor:toggle-source")');
    await wait(`(async()=>{const s=await dcNative.view.getState();return s.source===false&&document.querySelectorAll('.workspace-leaf.mod-active .dc-review-highlight').length>0;})()`);
    await evaluate('app.commands.executeCommandById("markdown:toggle-preview")');
    await wait('dcNative.view.getMode()==="preview"');
    // Obsidian retains the hidden source DOM while reading preview is active;
    // require that no source mark is laid out, rather than counting detached nodes.
    assert.equal(await evaluate('[...document.querySelectorAll(".workspace-leaf.mod-active .dc-review-highlight")].filter(e=>e.getClientRects().length).length'), 0);
    await evaluate('app.commands.executeCommandById("markdown:toggle-preview")');
    await wait('dcNative.view.getMode()==="source"&&document.querySelectorAll(".workspace-leaf.mod-active .dc-review-highlight").length>0');
    const returnedLiveCount = await evaluate('document.querySelectorAll(".workspace-leaf.mod-active .dc-review-highlight").length');
    const scrolled = await evaluate(`(()=>{const scroller=document.querySelector('.cm-scroller');if(!scroller)return false;scroller.scrollTop=scroller.scrollHeight;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));return true;})()`); assert.equal(scrolled, true);
    await sleep(120);
    await evaluate(`(()=>{const editor=dcNative.view.editor,s=dcNative.host.currentSession().review.suggestions[0];editor.scrollIntoView({from:editor.offsetToPos(s.anchors.target.from),to:editor.offsetToPos(s.anchors.target.to)},true);return true;})()`);
    await wait('document.querySelectorAll(".workspace-leaf.mod-active .dc-review-highlight").length>0');
    return { sourceMarks: sourceCount, livePreviewMarks: liveCount, returnedLiveMarks: returnedLiveCount, hostLivePreviewPreference: liveSurface.livePreviewPreference, restoredAfterScroll: true };
  });

  await phase('被动单击、拖选、修饰键与已有选区', async () => {
    const rect = await evaluate(`(()=>{const el=[...document.querySelectorAll('.workspace-leaf.mod-active .dc-review-highlight')].find(x=>!(x.getAttribute('data-dc-review')||'').includes(','));if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,ids:el.getAttribute('data-dc-review').split(',')};})()`);
    assert(rect && Number.isFinite(rect.x) && Number.isFinite(rect.y));
    const ids = await evaluate('dcNative.host.currentSession().review.suggestions.map(s=>s.id)');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await wait(`dcNative.host.currentSession().review.selectedId===${JSON.stringify(rect.ids[0])}`);
    const preserved = ids.find(id=>id!==rect.ids[0])||rect.ids[0];
    await evaluate(`dcNative.host.selectSuggestion(dcNative.host.currentSession().document.id,${JSON.stringify(preserved)})`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 16, y: rect.y + 3, button: 'left' });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + 16, y: rect.y + 3, button: 'left', clickCount: 1 });
    await sleep(120); if (!(await evaluate(`dcNative.host.currentSession().review.selectedId===${JSON.stringify(preserved)}`))) throw new Error('drag unexpectedly selected a comment');
    await wait('dcNative.view.editor.getSelection().length>0');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', modifiers: 2, clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', modifiers: 2, clickCount: 1 });
    await sleep(80); if (!(await evaluate(`dcNative.host.currentSession().review.selectedId===${JSON.stringify(preserved)}`))) throw new Error('modified click unexpectedly selected a comment');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await sleep(80); if (!(await evaluate(`dcNative.host.currentSession().review.selectedId===${JSON.stringify(preserved)}`))) throw new Error('nonempty selection click unexpectedly selected a comment');
    return { clickSelected: true, dragPreservedSelection: true, modifierIgnored: true, nonemptySelectionIgnored: true };
  });

  await phase('双源文窗格回声只映射一次，随后原生撤销与重做恢复状态', async () => {
    await evaluate(`(()=>{window.dcNativeChanges=[];dcNative.host.documents.onChange(c=>{if(c.documentId===dcNative.host.currentSession().document.id)window.dcNativeChanges.push({kind:c.kind,before:c.before.length,after:c.after.length,changes:c.changes.map(x=>({from:x.from,to:x.to,insertLength:x.insert.length}))});});return true;})()`);
    await evaluate(`(async()=>{const second=await app.workspace.duplicateLeaf(dcNative.leaf,true);await second.loadIfDeferred();dcNative.second=second;return !!second.view.editor;})()`);
    const before = await evaluate('(()=>{const s=dcNative.host.currentSession().review.suggestions[0];return{from:s.anchors.target.from,id:s.id,text:dcNative.view.editor.getValue()};})()');
    await evaluate(`(()=>{const e=dcNative.view.editor,at=e.getValue().indexOf('# 写作工具');e.replaceRange('前置。\\n',e.offsetToPos(at));return true;})()`);
    await sleep(350);
    const mapped = await evaluate(`(()=>{const s=dcNative.host.currentSession().review.suggestions.find(s=>s.id===${JSON.stringify(before.id)});return{from:s.anchors.target.from,state:s.state,reason:s.invalidReason,changes:window.dcNativeChanges};})()`);
    if (mapped.from !== before.from + '前置。\n'.length || mapped.state !== 'pending') throw new Error(`multi-pane map failure ${JSON.stringify(mapped)}`);
    await evaluate(`dcNative.host.acceptSuggestion(dcNative.host.currentSession().document.id,${JSON.stringify(before.id)})`);
    await wait(`dcNative.host.currentSession().review.suggestions.find(s=>s.id===${JSON.stringify(before.id)}).state==='applied'`);
    await evaluate('dcNative.view.editor.undo()');
    await wait(`dcNative.host.currentSession().review.suggestions.find(s=>s.id===${JSON.stringify(before.id)}).state==='pending'`);
    await evaluate('dcNative.view.editor.redo()');
    await wait(`dcNative.host.currentSession().review.suggestions.find(s=>s.id===${JSON.stringify(before.id)}).state==='applied'`);
    return { multiPaneShiftedOnce: true, nativeUndoRestored: true, nativeRedoRestored: true };
  });

  await phase('程序定位不冒充用户选区', async () => {
    const selected = await evaluate(`(()=>{const session=dcNative.host.currentSession(),s=session.review.suggestions.find(x=>x.state==='pending')||session.review.suggestions[0];dcNative.view.editor.setCursor({line:0,ch:0});dcNative.host.locateSuggestion(session.document.id,s.id);return session.document.id;})()`);
    await sleep(120);
    const summary = await evaluate(`dcNative.host.selectionSummary()`);
    assert.equal(summary.kind, 'body'); assert.equal(selected, await evaluate('dcNative.host.currentSession().document.id'));
    return { summary: summary.kind };
  });

  await phase('CRLF 源文保护及关闭源文后的原始 CAS', async () => {
    const result = await evaluate(`(async()=>{const raw='甲'+String.fromCharCode(13,10)+'乙'+String.fromCharCode(13,10)+'丙';let file=app.vault.getAbstractFileByPath('NativeCRLF.md');if(file)await app.vault.modify(file,raw);else file=await app.vault.create('NativeCRLF.md',raw);const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);const view=leaf.view,host=dcNative.host,doc=host.documents.recordFor(file),logical=view.editor.getValue();let blocked=false;try{await host.documents.applyRangeValidated(doc,logical,logical.indexOf('乙'),logical.indexOf('乙')+1,'新',()=>{});}catch(e){blocked=String(e.message||e).includes('CRLF');}const state=await view.getState();await view.setState({...state,mode:'preview'},{history:false});const switchNormalizes=!(await app.vault.read(file)).includes(String.fromCharCode(13,10));let closed=app.vault.getAbstractFileByPath('NativeCRLF-Closed.md');if(closed)await app.vault.modify(closed,raw);else closed=await app.vault.create('NativeCRLF-Closed.md',raw);const closedDoc=host.documents.recordFor(closed);await host.documents.applyRangeValidated(closedDoc,raw,raw.indexOf('乙'),raw.indexOf('乙')+1,'新',()=>{});const after=await app.vault.read(closed);return{blocked,switchNormalizes,after,crlf:after.includes(String.fromCharCode(13,10)),outside:after.slice(0,3)==='甲'+String.fromCharCode(13,10)};})()`);
    assert.equal(result.blocked, true); assert.equal(result.crlf, true); assert.equal(result.outside, true);
    return { sourceBlocked: true, rawCasPreservedCRLF: true, hostModeSwitchNormalizedCRLF: result.switchNormalizes };
  });
} catch (error) { failure = error instanceof Error ? error.message : 'Native editor acceptance failed.'; process.exitCode = 1; }
finally {
  const report = { date: new Date().toISOString(), version: '0.2.0', isolatedVault: true, syntheticOnly: true, checks, passed: !failure, failure,
    limitations: ['This script requires the separately started localhost mock provider on port 43127.', 'The host normalizes CRLF through its source editor; plugin protection and raw Vault CAS are checked instead.'] };
  await writeFile(resolve(reportDirectory, 'editor-verification.json'), JSON.stringify(report, null, 2) + '\n');
  for (const entry of pending.values()) { clearTimeout(entry.timer); }
  ws.close();
}
