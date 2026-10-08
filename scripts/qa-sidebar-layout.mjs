/** Real Obsidian layout regression. Only a separately configured synthetic Vault is allowed. */
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2), arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const vault = await realpath(arg('--vault', ''));
if (!vault.includes('draft-companion-qa-') || !vault.endsWith('/TestVault')) throw new Error('An isolated synthetic TestVault is required.');
const port = Number(arg('--port', '9334'));
if (port === 9333) throw new Error('The daily Vault debug port must not be used.');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const output = resolve(`docs/qa-${manifest.version}`);
await mkdir(output, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p => p.url === 'app://obsidian.md/index.html' && p.title.includes('TestVault'));
if (!page) throw new Error('Isolated Obsidian window is unavailable.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let sequence = 0; const pending = new Map();
ws.addEventListener('message', e => {
  const value = JSON.parse(e.data), item = pending.get(value.id);
  if (item) { clearTimeout(item.timer); pending.delete(value.id); value.error ? item.reject(new Error('Desktop protocol failed.')) : item.resolve(value.result); }
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error('Desktop operation timed out.')); }, 20000) });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description?.split('\n')[0] || 'Desktop assertion failed.');
  return value.result?.value;
};
const settle = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function wait(expression) { const end = Date.now() + 8000; while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 80)); } throw new Error('Expected UI did not appear.'); }
const checks = [], layouts = []; let failure;
const synthetic = Array.from({ length: 400 }, (_, i) => `第${i + 1}条合成素材：工具应该解决具体工作问题，保留作者判断，不虚构收益。😀`).join('\n');
const measure = `(()=>{
 const root=document.querySelector('.dc-sidebar'),input=root.querySelector('.dc-input'),reader=root.querySelector('.dc-reader'),composer=root.querySelector('.dc-composer'),controls=root.querySelector('.dc-composer-controls');
 const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};
 const buttons=[...controls.querySelectorAll('button')].filter(b=>!b.hidden&&getComputedStyle(b).display!=='none');
 const r=rect(root);return{sidebar:r,input:rect(input),reader:rect(reader),composer:rect(composer),controls:rect(controls),inputScrollable:input.scrollHeight>input.clientHeight,inputResize:getComputedStyle(input).resize,empty:root.classList.contains('dc-reader-is-empty'),horizontalOverflow:root.scrollWidth>root.clientWidth+2,controlsInside:buttons.every(b=>{const q=rect(b);return q.bottom<=r.bottom+1&&q.y>=r.y&&q.x>=r.x-1&&q.x+q.width<=r.x+r.width+1;}),rootScrollHeight:root.scrollHeight,rootClientHeight:root.clientHeight};
})()`;
async function check(name, fn) { const details = await fn(); checks.push({ name, passed: true, ...details }); console.log(name); }
try {
  assert.equal(await realpath(await evaluate('app.vault.adapter.getBasePath()')), vault);
  const files = {};
  for (const name of ['main.js', 'manifest.json', 'styles.css']) files[name] = await readFile(name, 'utf8');
  await evaluate(`(async()=>{
    const id='draft-companion';if(app.plugins.plugins[id]?.controller.running)throw new Error('Test plugin is busy');
    await app.plugins.disablePlugin(id);
    const dir=app.vault.configDir+'/plugins/'+id;
    for(const [name,value]of Object.entries(${JSON.stringify(files)}))await app.vault.adapter.write(dir+'/'+name,value);
    app.plugins.manifests[id]={...app.plugins.manifests[id],...${JSON.stringify(manifest)}};
    await app.plugins.enablePlugin(id);app.setting.close();
    const file=app.vault.getAbstractFileByPath('布局合成验收.md')||await app.vault.create('布局合成验收.md',${JSON.stringify('# 合成布局测试\n\n这是一篇只用于布局验证的文稿。')});
    const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.loadIfDeferred();app.workspace.setActiveLeaf(leaf,{focus:true});
    const h=app.plugins.plugins[id].controller;h.documents.focus(leaf);
    window.dcLayout={h,s:h.currentSession(),leaf};const q=dcLayout;
    q.s.messages=[];delete q.s.review;
    q.s.selectedRoleId=h.data.roles[0].id;q.s.mode='discuss';
    h.data.roles[0].quickTasks=Array.from({length:18},(_,i)=>'合成快捷任务 '+(i+1)+'：根据读者问题和真实素材生成不同方向，不编造收益。');
    h.data.providers=[{id:'layout',name:'布局验收（不发请求）',baseUrl:'http://127.0.0.1:1/v1',secretRef:'',model:'synthetic-layout-model',stream:true,timeoutMs:1000}];h.data.activeProviderId='layout';
    await h.saveSettings();app.commands.executeCommandById(id+':open-sidebar');return true;
  })()`);
  await wait('!!document.querySelector(".dc-more-button")');
  await check('长输入、空对话与浮层：十二种桌面布局', async () => {
    for (const [width, height] of [[1440, 900], [1280, 800]]) for (const sidebar of [360, 420, 480]) for (const theme of ['light', 'dark']) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate(`(()=>{document.body.classList.toggle('theme-dark',${theme === 'dark'});document.body.classList.toggle('theme-light',${theme === 'light'});const root=document.querySelector('.dc-sidebar'),dock=root.closest('.workspace-split.mod-right-split');dock.style.width='${sidebar}px';dock.style.flexBasis='${sidebar}px';dock.style.minWidth='${sidebar}px';const input=root.querySelector('.dc-input');input.value=${JSON.stringify(synthetic)};input.dispatchEvent(new Event('input',{bubbles:true}));dcLayout.h.changed();return true;})()`);
      await settle(); const state = await evaluate(measure);
      assert(state.controlsInside, JSON.stringify(state)); assert(!state.horizontalOverflow, JSON.stringify(state));
      assert(state.empty); assert(state.reader.height < 105, JSON.stringify(state));
      assert(state.input.y - state.reader.bottom < 20, JSON.stringify(state));
      assert(state.input.height <= 131 && state.inputScrollable && state.inputResize === 'none', JSON.stringify(state));
      assert.equal(await evaluate('document.querySelector(".dc-input").value.length'), synthetic.length);
      await evaluate('document.querySelector(".dc-more-button").click()'); await settle();
      const menu = await evaluate(`(()=>{const m=document.querySelector('.dc-secondary-popover'),r=m.getBoundingClientRect(),c=document.querySelector('.dc-composer').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,scrollable:m.scrollHeight>m.clientHeight,composerHeight:c.height,portal:m.parentElement===document.body};})()`);
      assert(menu.portal && menu.scrollable); assert(menu.left >= 0 && menu.right <= width + 1 && menu.top >= 0 && menu.bottom <= height + 1, JSON.stringify(menu));
      assert(Math.abs(menu.composerHeight - state.composer.height) < 1);
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await evaluate('!document.querySelector(".dc-secondary-popover")&&document.activeElement.classList.contains("dc-more-button")'), true);
      layouts.push({ viewport: [width, height], sidebar, theme, ...state, menu });
      if (width === 1280 && sidebar === 420) { const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(resolve(output, `layout-empty-long-${theme}.png`), Buffer.from(shot.data, 'base64')); }
    }
    return { cases: layouts.length };
  });
  await check('输入框真实滚轮与完整粘贴', async () => {
    const rect = await evaluate('(()=>{const i=document.querySelector(".dc-input");i.scrollTop=0;const r=i.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect });
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...rect, deltaX: 0, deltaY: 480 });
    await wait('document.querySelector(".dc-input").scrollTop>0');
    const scrolled = await evaluate('document.querySelector(".dc-input").scrollTop');
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...rect, deltaX: 0, deltaY: -480 });
    await wait(`document.querySelector('.dc-input').scrollTop<${scrolled}`);
    const input = await evaluate('(()=>{const i=document.querySelector(".dc-input");i.focus();i.value="";i.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
    assert(input); await call('Input.insertText', { text: synthetic }); await settle();
    assert.equal(await evaluate('document.querySelector(".dc-input").value'), synthetic);
    assert((await evaluate(measure)).controlsInside);
    return { nativeWheelBothDirections: true, insertedCharacters: synthetic.length };
  });
  await check('快捷任务只填输入，点击外部关闭，键盘菜单可达', async () => {
    const before = await evaluate('dcLayout.s.messages.length');
    await evaluate('document.querySelector(".dc-more-button").click()'); await settle();
    await evaluate('document.querySelector(".dc-secondary-popover .dc-quick-task").click()');
    assert.equal(await evaluate('!document.querySelector(".dc-secondary-popover")&&document.activeElement.classList.contains("dc-input")'), true);
    assert.equal(await evaluate('dcLayout.s.messages.length'), before);
    await evaluate('document.querySelector(".dc-more-button").click()'); await settle();
    const point = await evaluate('(()=>{const r=document.querySelector(".dc-input").getBoundingClientRect();return{x:r.right-12,y:r.bottom-12};})()');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await wait('!document.querySelector(".dc-secondary-popover")');
    return { noAutomaticRequest: true, outsideClickCloses: true };
  });
  await check('长历史、展开本文要求、缩小窗口与停止入口', async () => {
    await evaluate(`(()=>{dcLayout.s.messages=Array.from({length:24},(_,i)=>({id:'synthetic-'+i,role:'assistant',content:'## 合成回答 '+i+${JSON.stringify('\n\n')}+('这是一段用于滚动验证的合成材料。'.repeat(50)),at:i,status:'completed'}));dcLayout.h.changed();const root=document.querySelector('.dc-sidebar');root.querySelector('.dc-brief').open=true;root.querySelector('.dc-brief textarea').value=${JSON.stringify(synthetic)};root.querySelector('.dc-input').value=${JSON.stringify(synthetic)};root.querySelector('.dc-input').dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await settle(); let state = await evaluate(measure); assert(state.controlsInside && !state.horizontalOverflow, JSON.stringify(state));
    const point = await evaluate('(()=>{const r=document.querySelector(".dc-reader").getBoundingClientRect();document.querySelector(".dc-reader").scrollTop=0;return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 400 });
    await wait('document.querySelector(".dc-reader").scrollTop>0');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 450, deviceScaleFactor: 1, mobile: false }); await settle();
    state = await evaluate(measure);
    if (!state.controlsInside) {
      await evaluate('document.querySelector(".dc-sidebar").scrollTop=10000'); await settle(); state = await evaluate(measure);
    }
    assert(state.controlsInside && !state.horizontalOverflow, JSON.stringify(state));
    await evaluate(`(()=>{const h=dcLayout.h;h.running={id:'synthetic-running',documentId:dcLayout.s.document.id,path:dcLayout.s.document.path,sessionId:dcLayout.s.id,roleName:'合成状态',mode:'discuss',text:'不发模型请求，仅验停止按钮',stop:()=>{h.running=undefined;h.changed();}};h.changed();return true;})()`);
    assert((await evaluate(measure)).controlsInside);
    await evaluate('[...document.querySelectorAll(".dc-composer-controls button")].find(b=>b.textContent==="停止").click()'); assert.equal(await evaluate('!dcLayout.h.running'), true);
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await settle();
    const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(resolve(output, 'layout-history-dark.png'), Buffer.from(shot.data, 'base64'));
    return { readerWheel: true, briefExpanded: true, shortViewport: [1280, 450], stopReachable: true };
  });
} catch (error) { failure = error.message; console.log(`Layout verification failed: ${failure}`); process.exitCode = 1; }
finally {
  try { await call('Emulation.clearDeviceMetricsOverride'); } catch {}
  const report = { date: new Date().toISOString(), version: manifest.version, isolatedVault: true, syntheticOnly: true, modelRequests: 0, checks, layouts, passed: !failure, failure, limitations: ['Physical Chinese IME candidate window is not exercised; composition-event regression remains in unit tests.', 'CSS zoom and native OS window resizing are recorded only when separately verified.'] };
  await writeFile(resolve(output, 'layout-verification.json'), JSON.stringify(report, null, 2) + '\n');
  for (const item of pending.values()) clearTimeout(item.timer); ws.close();
}
