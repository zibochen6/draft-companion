/** 0.2.0 desktop acceptance: synthetic, explicitly isolated vault only. */
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const args=process.argv.slice(2),arg=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const expected=await realpath(arg('--vault',''));
if(!expected.includes('draft-companion-qa-')||!expected.endsWith('/TestVault'))throw new Error('An isolated synthetic TestVault is required.');
const port=Number(arg('--port','9334')),live=args.includes('--live');
const liveOnly=args.includes('--live-only');
const liveStream=!args.includes('--non-stream');
const chatOnly=args.includes('--chat-only');
if(chatOnly&&(!live||!liveOnly))throw new Error('The independent real chat test requires --live --live-only.');
const reportName=arg('--report','desktop-verification.json');
if(!/^[a-z0-9.-]+\.json$/.test(reportName))throw new Error('Report name must be a local JSON filename.');
async function connect(port,title){
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page=pages.find(p=>p.url==='app://obsidian.md/index.html'&&p.title.includes(title));
  if(!page)throw new Error('Expected Obsidian window is unavailable.');
  const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const v=JSON.parse(e.data),entry=pending.get(v.id);if(entry){clearTimeout(entry.timer);pending.delete(v.id);v.error?entry.reject(new Error('Desktop protocol failed.')):entry.resolve(v.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject,timer:setTimeout(()=>{pending.delete(n);reject(new Error('Desktop check timed out.'));},180000)});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async(expression)=>{const v=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(v.exceptionDetails)throw new Error('A desktop acceptance assertion failed.');return v.result.value;};
  return{call,evaluate,close(){for(const e of pending.values()){clearTimeout(e.timer);e.reject(new Error('Closed'));}pending.clear();ws.close();}};
}
const c=await connect(port,'TestVault'),e=c.evaluate,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];let fatal='',configuration,source;
await mkdir(resolve('docs/qa-0.2.0'),{recursive:true});
async function wait(expression,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await e(expression))return;await sleep(80);}throw new Error('Expected UI state did not appear.');}
async function phase(name,fn){process.stdout.write(`验收：${name}\n`);try{const details=await fn();checks.push({name,passed:true,...details});}catch(err){
  let details={};if(name.startsWith('真实服务'))try{details=await e(`(()=>{const r=dc020.host.currentSession().review?.runs.at(-1);return{status:r?.status,error:(r?.error||'').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,512),stream:dc020.host.data.providers[0]?.stream};})()`);}catch{}
  checks.push({name,passed:false,...details});throw err;
}}
const shortFixture=args.includes('--short-fixture');
const fixture=await readFile(resolve(shortFixture?'fixtures/真实服务合成短稿.md':'fixtures/公众号批注长文.md'),'utf8');
if(shortFixture&&!liveOnly)throw new Error('The short fixture is only for separate real-provider checks.');
try{
  assert.equal(await realpath(await e('app.vault.adapter.getBasePath()')),expected);
  await wait('!!app.plugins.plugins["draft-companion"]');
  await e(`(async()=>{
    app.setting.close();document.querySelectorAll('.modal').forEach(m=>m.parentElement.querySelector('.modal-bg')?.click());
    window.dc020={host:app.plugins.plugins['draft-companion'].controller};
    const q=dc020;const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='A.md')||app.workspace.getLeaf('tab');
    await leaf.openFile(app.vault.getAbstractFileByPath('A.md'));await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);app.workspace.setActiveLeaf(leaf,{focus:true});q.aLeaf=leaf;q.aView=leaf.view;
    q.aView.editor.setValue(${JSON.stringify(fixture)});q.aView.editor.setCursor({line:0,ch:0});
    q.host.documents.focus(leaf);
    delete q.host.currentSession().review;await q.host.clearSession();
    q.host.data.providers=[{id:'qa020',name:'本地模拟服务（合成验收）',baseUrl:'http://127.0.0.1:43127/v1',secretRef:'',model:'mock-review-model',stream:true,timeoutMs:60000}];q.host.data.activeProviderId='qa020';await q.host.saveSettings();
    app.commands.executeCommandById('draft-companion:open-sidebar');return true;
  })()`);
  await wait('!!document.querySelector(".dc-input")');
  if(!liveOnly){
  await phase('真实插件加载、审阅协议与未落盘全文',async()=>{
    await e(`(()=>{const root=document.querySelector('.dc-sidebar');[...root.querySelectorAll('.dc-tabs button')].find(b=>b.textContent.startsWith('批注')).click();const input=root.querySelector('.dc-input');input.value='TEST:LONG 合成公众号审阅';input.dispatchEvent(new Event('input',{bubbles:true}));[...root.querySelectorAll('.dc-composer-controls button')].find(b=>b.textContent==='审阅').click();return true;})()`);
    await wait('!dc020.host.running&&dc020.host.currentSession().review?.suggestions.length===5');
    assert.equal(await e('dc020.host.currentSession().review.suggestions.length'),5);
    assert.equal(await e('dc020.host.currentSession().review.suggestions.filter(s=>s.state==="pending").length'),4);
    assert.equal(await e('dc020.aView.editor.getValue()'),fixture);
    await wait('document.querySelectorAll(".dc-review-highlight").length>0');
    await e('dc020.session=dc020.host.currentSession();dc020.ids=dc020.session.review.suggestions.map(s=>s.id);true');
    return{suggestions:5,sourceHighlight:true,frontmatterPreserved:true};
  });
  await phase('宽版三种只读预览与当前建议同步',async()=>{
    await e('dc020.host.openReview(dc020.session.document.id,dc020.ids[0])');
    await wait('!!document.querySelector(".dc-review-view")');
    assert.equal(await e('app.workspace.getLeavesOfType("markdown").some(l=>l===dc020.aLeaf)'),true);
    const beforeCount=(await(await fetch('http://127.0.0.1:43127/__requests')).json()).length;
    const state=await e('(async()=>{const h=dc020.host;const p=await h.previewSuggestion(dc020.session.document.id,dc020.ids[0]);return{valid:p.valid,after:p.after,path:p.path,before:p.before};})()');
    assert(state.valid);assert.equal(state.before,fixture);assert(state.after.includes('作者可以先整理写作材料'));
    await e(`(()=>{const root=document.querySelector('.dc-review-view');for(const label of ['原文','改后','修订']){[...root.querySelectorAll('button')].find(b=>b.textContent===label)?.click();}return true;})()`);
    assert.equal(await e('dc020.aView.editor.getValue()'),fixture);
    assert.equal((await(await fetch('http://127.0.0.1:43127/__requests')).json()).length,beforeCount);
    return{editorKept:true,previewWrites:0,previewRequests:0};
  });
  await phase('大幅改动第一句后继续采纳第二句，重叠失效，自动下一条',async()=>{
    await wait(`!![...document.querySelectorAll('.dc-review-view button')].find(b=>b.textContent==='采纳'&&!b.disabled)`);
    await e(`[...document.querySelectorAll('.dc-review-view button')].find(b=>b.textContent==='采纳'&&!b.disabled).click();true`);
    await wait('dc020.session.review.suggestions[0].state==="applied"');
    assert.equal(await e('dc020.session.review.selectedId===dc020.ids[1]'),true);
    assert.equal(await e('dc020.session.review.suggestions[3].state'),'needs-check');
    assert.equal(await e('dc020.session.review.suggestions[1].state'),'pending');
    await wait(`document.querySelector('.dc-review-meta strong')?.textContent.startsWith('#2 ')&&!![...document.querySelectorAll('.dc-review-view button')].find(b=>b.textContent==='采纳'&&!b.disabled)`);
    await e(`[...document.querySelectorAll('.dc-review-view button')].find(b=>b.textContent==='采纳'&&!b.disabled).click();true`);
    await wait('dc020.session.review.suggestions[1].state==="applied"');
    assert.equal(await e('dc020.session.review.selectedId===dc020.ids[2]'),true);
    assert.equal(await e('dc020.aView.editor.getValue().includes("AI 可以协助整理和修改文章")'),true);
    assert.equal(await e('(async()=>{const before=dc020.aView.editor.getValue();try{await dc020.host.acceptSuggestion(dc020.session.document.id,dc020.ids[1]);return false;}catch{return before===dc020.aView.editor.getValue();}})()'),true);
    return{independentSuggestionKept:true,overlapInvalidated:true,duplicateApplyBlocked:true};
  });
  await phase('逐条撤回保留第二条与后续手写文字',async()=>{
    await e(String.raw`(()=>{const editor=dc020.aView.editor;editor.replaceRange('\n无关手写内容应保留。\n',editor.offsetToPos(editor.getValue().length));return true;})()`);
    await e('dc020.host.openReview(dc020.session.document.id,dc020.ids[0])');
    await wait(`!![...document.querySelectorAll('.dc-review-view button')].find(b=>b.textContent==='撤回'&&!b.disabled)`);
    await e(`[...document.querySelectorAll('.dc-review-view button')].find(b=>b.textContent==='撤回'&&!b.disabled).click();true`);
    await wait('dc020.session.review.suggestions[0].state==="pending"');
    assert.equal(await e('dc020.aView.editor.getValue().includes("这款工具非常非常方便，真的特别好用。")&&dc020.aView.editor.getValue().includes("AI 可以协助整理和修改文章")&&dc020.aView.editor.getValue().includes("无关手写内容应保留")'),true);
    return{laterAcceptanceKept:true,manualEditKept:true};
  });
  await phase('重复句精确定位、忽略不写入与自动下一条',async()=>{
    await e('dc020.host.selectSuggestion(dc020.session.document.id,dc020.ids[2]);dc020.host.locateSuggestion(dc020.session.document.id,dc020.ids[2])');
    const p=await e('dc020.host.previewSuggestion(dc020.session.document.id,dc020.ids[2]).then(p=>({from:p.from,valid:p.valid}))');assert(p.valid);assert(p.from>fixture.indexOf('第二处重复：'));
    const before=await e('dc020.aView.editor.getValue()');await e('dc020.host.openReview(dc020.session.document.id,dc020.ids[2])');
    await wait(`!![...document.querySelectorAll('.dc-review-view button')].find(b=>b.textContent==='忽略'&&!b.disabled)`);
    await e(`[...document.querySelectorAll('.dc-review-view button')].find(b=>b.textContent==='忽略'&&!b.disabled).click();true`);
    await wait('dc020.session.review.suggestions[2].state==="ignored"');
    assert.equal(await e('dc020.aView.editor.getValue()'),before);
    assert.equal(await e('dc020.session.review.suggestions[2].state'),'ignored');
    assert.equal(await e('dc020.session.review.selectedId===dc020.ids[4]'),true);
    return{secondOccurrence:true,ignoreWrites:0};
  });
  await phase('批注追问不覆盖候选，新改法保留旧版本与原作者',async()=>{
    await e('dc020.host.selectSuggestion(dc020.session.document.id,dc020.ids[0])');
    await e('dc020.host.askSuggestion(dc020.session.document.id,dc020.ids[0],"请解释这条建议。",false)');
    assert.equal(await e('dc020.session.review.suggestions[0].versions.length'),1);
    await e('dc020.revisionPromise=dc020.host.askSuggestion(dc020.session.document.id,dc020.ids[0],"请再简短一些。",true);true');
    await wait('!!dc020.host.running');
    await e(`(()=>{const editor=dc020.aView.editor;editor.replaceRange('无关前置文字。\\n',editor.offsetToPos(editor.getValue().indexOf('# 写作工具')));return true;})()`);
    await e('dc020.revisionPromise');
    assert.equal(await e('dc020.session.review.suggestions[0].versions.length'),2);
    assert.equal(await e('!!dc020.session.review.suggestions[0].versions[0].supersededBy'),true);
    assert.equal(await e('dc020.aView.editor.getValue().includes("无关前置文字。")'),true);
    return{versions:2,ordinaryReplyKeptCandidate:true,unrelatedEditDuringRevisionKept:true};
  });
  await phase('A/B 文稿隔离、停止与迟到结果',async()=>{
    await e('dc020.host.review("TEST:SLOW 审阅停止测试","body").catch(()=>{});true');await wait('!!dc020.host.running');
    await e('(async()=>{const leaf=app.workspace.getLeaf("tab");await leaf.openFile(app.vault.getAbstractFileByPath("B.md"));await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);app.workspace.setActiveLeaf(leaf,{focus:true});dc020.bView=leaf.view;dc020.bBefore=leaf.view.editor.getValue();return true;})()');
    assert.equal(await e('dc020.host.target().path'),'B.md');
    await e('dc020.host.stop();true');await sleep(300);
    assert.equal(await e('!dc020.host.running&&dc020.bView.editor.getValue()===dc020.bBefore&&dc020.host.currentSession().messages.length===0'),true);
    await e('app.workspace.revealLeaf(dc020.aLeaf).then(()=>app.workspace.setActiveLeaf(dc020.aLeaf,{focus:true}))');return{stopped:true,bUnchanged:true};
  });
  await phase('中文组词与普通 Enter 不发送',async()=>{
    const count=await e('dc020.host.currentSession().messages.length');
    await e(`(()=>{const input=document.querySelector('.dc-input');input.value='中文组词验收';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,isComposing:true,bubbles:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
    assert.equal(await e('dc020.host.currentSession().messages.length'),count);return{compositionEvents:true,enterIsNewline:true,physicalIME:false};
  });
  await phase('重启恢复校验、配置和批注状态',async()=>{
    await e('(async()=>{await dc020.host.saveSettings();await app.plugins.disablePlugin("draft-companion");await app.plugins.enablePlugin("draft-companion");dc020.host=app.plugins.plugins["draft-companion"].controller;app.commands.executeCommandById("draft-companion:open-sidebar");await app.workspace.revealLeaf(dc020.aLeaf);app.workspace.setActiveLeaf(dc020.aLeaf,{focus:true});return true;})()');
    await e('dc020.session=dc020.host.currentSession();dc020.host.previewSuggestion(dc020.session.document.id,dc020.ids[0])');
    assert.equal(await e('dc020.host.data.version'),2);assert.equal(await e('dc020.session.review.suggestions[2].state'),'ignored');
    return{schema:2,ignoredKept:true};
  });
  await phase('明暗主题、两种窗口与三种侧栏宽度',async()=>{
    await mkdir(resolve('docs/qa-0.2.0'),{recursive:true});
    const layouts=[];
    for(const [width,height] of [[1440,900],[1280,800]])for(const sidebar of [360,420,480])for(const theme of ['light','dark']){
      await c.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await e(`(()=>{document.body.classList.toggle('theme-dark',${theme==='dark'});document.body.classList.toggle('theme-light',${theme==='light'});const root=document.querySelector('.dc-sidebar');const dock=root.closest('.workspace-split.mod-right-split');if(dock){dock.style.width='${sidebar}px';dock.style.flexBasis='${sidebar}px';}return true;})()`);
      await sleep(90);
      const measured=await e(`(()=>{const root=document.querySelector('.dc-sidebar');const reading=root.querySelector('.dc-reader');const r=root.getBoundingClientRect();const b=reading?.getBoundingClientRect();return{width:r.width,height:r.height,reading:b?.height||0,horizontalOverflow:root.scrollWidth>root.clientWidth+2};})()`);
      assert(!measured.horizontalOverflow);assert(measured.reading>=measured.height/2,JSON.stringify(measured));layouts.push({viewport:[width,height],sidebar,theme,...measured});
      if(sidebar===420){const shot=await c.call('Page.captureScreenshot',{format:'png'});await writeFile(resolve(`docs/qa-0.2.0/${width}-${height}-${theme}.png`),Buffer.from(shot.data,'base64'));}
    }
    await c.call('Emulation.clearDeviceMetricsOverride');return{layouts};
  });
  }
  if(live)await phase(chatOnly?'真实服务：独立聊天测试，不发送文稿':'真实服务：只发送合成材料、官方密钥引用与完整审稿结果',async()=>{
    source=await connect(Number(arg('--source-port','9333')),'personal_database');
    configuration=await source.evaluate(`(()=>{const h=app.plugins.plugins['draft-companion']?.controller;const p=h?.data.providers.find(p=>p.id===h.data.activeProviderId);if(!p?.secretRef||h.running)throw new Error('No configured idle provider.');return{baseUrl:p.baseUrl,model:p.model,key:app.secretStorage.getSecret(p.secretRef)};})()`);
    if(!configuration.key)throw new Error('Official secret reference is unavailable.');
    await e(`(()=>{const q=dc020;q.storage=app.secretStorage;q.secretDescriptor=Object.getOwnPropertyDescriptor(q.storage,'getSecret');q.storage.getSecret=(ref)=>ref==='qa020-memory-only'?${JSON.stringify(configuration.key)}:null;q.host.data.providers=[{id:'real020',name:'真实服务（仅合成材料）',baseUrl:${JSON.stringify(configuration.baseUrl)},model:${JSON.stringify(configuration.model)},secretRef:'qa020-memory-only',stream:${liveStream},timeoutMs:120000}];q.host.data.activeProviderId='real020';return true;})()`);
    if(chatOnly){const started=Date.now();const result=await e(`dc020.host.testProvider(dc020.host.data.providers[0]).then(text=>({characters:text.length})).catch(error=>({error:String(error.message||error).replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,512)}))`);if(result.error)throw new Error(result.error);return{provider:configuration.baseUrl,model:configuration.model,stream:liveStream,durationMs:Date.now()-started,...result,noNoteContentSent:true,officialSecretReference:true};}
    const before=await e('dc020.aView.editor.getValue()');const started=Date.now();
    const instruction=shortFixture?'这是合成验收材料。只提出一至两条非空的原地句子改写，纠正夸张或无依据的承诺，不建议删除。quote必须照抄快照。原句均唯一，请将contextBefore和contextAfter设为空字符串。严格遵守运行时JSON协议，不虚构数据，不声称联网核查。':'这是合成验收材料。请给出至多三条重要句级建议，不声称联网核查，不虚构数据。必须严格遵守运行时JSON协议：replacement不得为空字符串或空白。删除、合并和移动建议一律replacement设为JSON null，仅评论；只有能给出非空原地新句时才提供字符串。';
    await e(`dc020.host.review(${JSON.stringify(instruction)},'body')`);
    assert.equal(await e('dc020.aView.editor.getValue()'),before);
    const result=await e('(()=>{const session=dc020.host.currentSession(),run=session.review.runs.at(-1);const suggestions=session.review.suggestions.filter(s=>s.runId===run.id);return{status:run.status,added:run.added,duplicates:run.duplicates,pending:suggestions.filter(s=>s.state==="pending").length,comments:suggestions.filter(s=>s.state==="comment").length,unlocated:suggestions.filter(s=>s.state==="unlocated").length};})()');assert.equal(result.status,'completed');assert(result.pending+result.comments>0,'The real response must have at least one exact-located suggestion.');
    const write=await e(`(async()=>{const h=dc020.host,s=h.currentSession(),run=s.review.runs.at(-1),suggestion=s.review.suggestions.find(x=>x.runId===run.id&&x.state==='pending');if(!suggestion)return{applied:false,reason:'comment-only response'};const before=dc020.aView.editor.getValue();const p=await h.previewSuggestion(s.document.id,suggestion.id);if(!p.valid)throw new Error('Invalid current real proposal.');await h.acceptSuggestion(s.document.id,suggestion.id);const applied=dc020.aView.editor.getValue()===p.after;await h.undoSuggestion(s.document.id,suggestion.id);return{applied,exactUndo:dc020.aView.editor.getValue()===before};})()`);
    if(write.applied)assert(write.exactUndo);
    return{provider:configuration.baseUrl,model:configuration.model,stream:liveStream,shortFixture,durationMs:Date.now()-started,...result,...write,syntheticOnly:true,officialSecretReference:true};
  });
}catch(error){fatal=error instanceof Error?error.message:'Acceptance failed.';process.stdout.write(`验收未完成：${fatal}\n`);process.exitCode=1;}
finally{
  if(configuration)configuration.key='';source?.close();
  try{await e(`(()=>{const q=window.dc020;if(q?.storage){if(q.secretDescriptor)Object.defineProperty(q.storage,'getSecret',q.secretDescriptor);else delete q.storage.getSecret;}q?.host.stop();return true;})()`);}catch{}
  const report={date:new Date().toISOString(),version:'0.2.0',environment:'macOS ARM64 / actual Obsidian desktop',isolatedVault:true,liveRequested:live,checks,fatal:fatal||undefined,passed:!fatal,limitations:['Physical Chinese IME candidate-window interaction requires manual follow-up; composition events are tested.','Windows/Linux and minimum Obsidian 1.11.4 are not verified.','CRLF source writes are deliberately blocked; host mode switching may also normalize them. Raw Vault CAS preserves CRLF only without source buffers.','Remote billing cancellation is not guaranteed.']};
  await writeFile(resolve('docs/qa-0.2.0',reportName),JSON.stringify(report,null,2)+'\n');c.close();
}
