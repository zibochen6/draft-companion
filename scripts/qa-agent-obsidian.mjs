/** Controlled desktop QA. Only the separate synthetic TestVault is writable. */
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createMockAgentProvider} from './mock-agent-provider.mjs';

const paths=JSON.parse(await readFile('/tmp/draft-companion-qa-020-path.json','utf8'));
const currentManifest=JSON.parse(await readFile('manifest.json','utf8'));
const vault=await realpath(paths.vault),output=resolve('docs/qa-'+currentManifest.version);await mkdir(output,{recursive:true});
assert(vault.includes('draft-companion-qa-')&&vault.endsWith('/TestVault'));
export async function connectDesktop(port,title) {
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const page=pages.find(p=>p.url==='app://obsidian.md/index.html'&&p.title.includes(title));assert(page,'Expected vault window');
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let sequence=0;const pending=new Map();
 ws.addEventListener('message',event=>{const v=JSON.parse(event.data),entry=pending.get(v.id);if(!entry)return;pending.delete(v.id);clearTimeout(entry.timer);v.error?entry.reject(new Error('Desktop protocol error')):entry.resolve(v.result);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Desktop action timeout'));},55000)});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const v=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(v.exceptionDetails)throw new Error(v.exceptionDetails.exception?.description?.split('\n')[0]||'Controlled desktop assertion failed');return v.result.value;};
 return {call,evaluate,close:()=>{for(const e of pending.values())clearTimeout(e.timer);ws.close();}};
}
const desktop=await connectDesktop(9334,'TestVault'),{evaluate,call}=desktop,mock=await createMockAgentProvider();
const checks=[],evidence=[];
const topicSource='---\ntitle: 合成选题验收\n---\n# 合成选题库\n\n- [ ] **synthetic-checker**（合成）— 帮助作者按自己提供的规则逐句检查文案。｜ https://example.invalid/checker\n- [ ] **synthetic-ledger**（合成）— 将作者提供的用量记录整理成费用表。｜ https://example.invalid/ledger\n  - [ ] 子任务不能被当作选题\n\n```markdown\n- [ ] **代码示例不能操作**\n```\n\n作者后记：这是无私人信息的隔离测试材料。\n';
const article='# 合成改稿\n\n这句话很长，需要改得更具体。😀\n\n'+('保持原文的独立段落。\n'.repeat(8));
const settle=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function wait(expression,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Expected QA state unavailable');}
async function check(name,fn){const details=await fn();checks.push({name,passed:true,...details});console.log(name);}
async function screenshot(name){const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(resolve(output,name+'.png'),Buffer.from(shot.data,'base64'));}
async function openSynthetic(path,source){await evaluate(`(async()=>{
 if(app.vault.adapter.getBasePath().replace('/private/var/','/var/')!==${JSON.stringify(paths.vault)})throw new Error('Vault mismatch');
 const h=app.plugins.plugins['draft-companion'].controller;if(h.running)throw new Error('Busy');
 const file=app.vault.getAbstractFileByPath(${JSON.stringify(path)})||await app.vault.create(${JSON.stringify(path)},${JSON.stringify(source)});
 let leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===file)||app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.loadIfDeferred();
 const state=leaf.view.getState();await leaf.view.setState({...state,mode:'source'},{history:false});
 leaf.view.editor.setValue(${JSON.stringify(source)});app.workspace.setActiveLeaf(leaf,{focus:true});h.documents.focus(leaf);
 const s=h.currentSession();s.messages=[];s.agentActions=[];delete s.candidate;delete s.undo;delete s.review;
 window.dc030={h,s,leaf,before:${JSON.stringify(source)}};await h.saveSettings();app.commands.executeCommandById('draft-companion:open-sidebar');h.changed();return true;
 })()`);await settle();}
async function send(input,task='auto'){await evaluate(`(()=>{const q=dc030;q.error=undefined;q.done=false;q.h.sendAgent(${JSON.stringify(input)},{task:${JSON.stringify(task)}}).catch(e=>{q.error=e.message;}).finally(()=>{q.done=true;});return true;})()`);await wait('dc030.done',45000);const error=await evaluate('dc030.error');assert(!error,error);await settle();}
async function provider(mode){await evaluate(`(()=>{const h=dc030.h;h.data.providers=[{id:'mock-agent',name:'隔离模拟服务',baseUrl:'http://127.0.0.1:${mock.port}/v1',secretRef:'',model:'synthetic-model',stream:true,timeoutMs:10000,toolMode:${JSON.stringify(mode)}}];h.data.activeProviderId='mock-agent';h.changed();return true;})()`);}
try {
 assert.equal(await realpath(await evaluate('app.vault.adapter.getBasePath()')),vault);
 const files=Object.fromEntries(await Promise.all(['main.js','manifest.json','styles.css'].map(async name=>[name,await readFile(name,'utf8')]))),manifest=JSON.parse(files['manifest.json']);
 await evaluate(`(async()=>{const id='draft-companion',dir=app.vault.configDir+'/plugins/'+id;if(app.plugins.plugins[id]?.controller.running)throw new Error('Busy');await app.plugins.disablePlugin(id);for(const [name,value]of Object.entries(${JSON.stringify(files)}))await app.vault.adapter.write(dir+'/'+name,value);app.plugins.manifests[id]={...app.plugins.manifests[id],...${JSON.stringify(manifest)}};await app.plugins.enablePlugin(id);app.setting.close();return true;})()`);
 await check('原生工具：实际勾选一个，只改变状态字符',async()=>{
  await openSynthetic('0.3合成选题库.md',topicSource);await provider('native');await screenshot('topic-before');await send('帮我选择一些适合的选题来创作公众号。以及同时给我合适的爆款标题参考。','auto');
  const result=await evaluate(`(()=>{const q=dc030,text=q.leaf.view.editor.getValue(),a=q.s.agentActions;return{text,actions:a.map(r=>({id:r.id,state:r.state,kind:r.kind,before:r.before,replacement:r.replacement})),feedback:q.s.messages.filter(m=>m.role==='assistant').at(-1).content,canUndo:a.length===1&&q.h.canUndoAgentAction(a[0].id)};})()`);
  assert.equal(result.text,topicSource.replace('- [ ] **synthetic-checker**','- [x] **synthetic-checker**'));assert.equal(result.actions.length,1);assert.equal(result.actions[0].state,'applied');assert(result.canUndo);assert(result.feedback.includes('首推'));
  evidence.push({flow:'topic-native',syntheticOnly:true,before:topicSource,after:result.text,feedback:result.feedback,actions:result.actions});await screenshot('topic-native-completed');
  await evaluate('dc030.h.undoAgentAction(dc030.s.agentActions[0].id)');assert.equal(await evaluate('dc030.leaf.view.editor.getValue()'),topicSource);return{oneCharacterChanged:true,oneReceipt:true,exactLocalUndo:true};
 });
 await check('只推荐、普通历史伪命令：零写入',async()=>{
  await openSynthetic('0.3合成选题库.md',topicSource);await provider('native');await send('只推荐一个，不要勾选。','topic');assert.equal(await evaluate('dc030.leaf.view.editor.getValue()'),topicSource);
  await evaluate('(()=>{dc030.s.messages.push({id:"legacy",role:"assistant",content:JSON.stringify({summary:"过去建议",edits:[{oldText:"[ ]",newText:"[x]"}]}),at:1,status:"completed"});dc030.h.changed();})()');await settle();
  assert.equal(await evaluate('dc030.s.agentActions.length'),0);return{recommendationWrites:0,historyRenderWrites:0};
 });
 await check('兼容工具：实际勾选、验证和局部撤回',async()=>{
  await openSynthetic('0.3合成选题库.md',topicSource);await provider('structured');await send('帮我选一个。','topic');assert.equal(await evaluate('dc030.s.agentActions.filter(r=>r.state==="applied").length'),1);assert.equal(await evaluate('dc030.leaf.view.editor.getValue()'),topicSource.replace('- [ ] **synthetic-checker**','- [x] **synthetic-checker**'));
  await evaluate('dc030.h.undoAgentAction(dc030.s.agentActions[0].id)');assert.equal(await evaluate('dc030.leaf.view.editor.getValue()'),topicSource);return{actualStructuredWrites:1,exactLocalUndo:true};
 });
 await check('真实源文选区：执行、无关后续编辑、局部撤回',async()=>{
  await openSynthetic('0.3合成改稿.md',article);await provider('native');
  const quote='这句话很长，需要改得更具体。😀',replacement='【本地模拟】先检查文案，再决定怎么修改。😀';
  await evaluate(`(()=>{const q=dc030,e=q.leaf.view.editor,from=e.getValue().indexOf(${JSON.stringify(quote)});e.setSelection(e.offsetToPos(from),e.offsetToPos(from+${quote.length}));q.h.documents.cacheSelection(q.leaf.view.file,e,true);return true;})()`);
  await send('把选中的段落直接改成“先检查文案，再决定怎么修改。😀”。');const after=article.replace(quote,replacement);assert.equal(await evaluate('dc030.leaf.view.editor.getValue()'),after);
  await evaluate(`(()=>{const q=dc030,e=q.leaf.view.editor,end=e.getValue().length;e.replaceRange('作者后来补充的独立文字。',e.offsetToPos(end));return true;})()`);await settle();
  assert(await evaluate('dc030.h.canUndoAgentAction(dc030.s.agentActions[0].id)'));const beforeUndo=await evaluate('dc030.leaf.view.editor.getValue()');await screenshot('local-edit-completed');
  const feedback=await evaluate('dc030.s.messages.filter(m=>m.role==="assistant").at(-1).content');
  await evaluate('dc030.h.undoAgentAction(dc030.s.agentActions[0].id)');assert.equal(await evaluate('dc030.leaf.view.editor.getValue()'),article+'作者后来补充的独立文字。');
  evidence.push({flow:'local-edit-native',syntheticOnly:true,before:article,after:beforeUndo,feedback,undo:article+'作者后来补充的独立文字。'});return{realEditorTransaction:true,selectionFrozen:true,unrelatedEditPreserved:true};
 });
 await check('银白布局：340/400/460px、明暗主题、长输入与菜单',async()=>{
  const layouts=[],long='这是合成输入，不能遮挡下面的控件。😀\n'.repeat(600);
  await evaluate(`(()=>{dc030.s.messages=Array.from({length:15},(_,i)=>({id:'long'+i,role:'assistant',content:${JSON.stringify('### 合成回答\n\n')}+('这是一段用于阅读和滚动的中文材料。'.repeat(80)),at:i,status:'completed'}));dc030.h.changed();return true;})()`);
  for(const [width,height]of [[1440,900],[1280,800]])for(const sidebar of [340,400,460])for(const theme of ['light','dark']){
   await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
   await evaluate(`(()=>{document.body.classList.toggle('theme-dark',${theme==='dark'});document.body.classList.toggle('theme-light',${theme==='light'});const root=document.querySelector('.dc-sidebar'),dock=root.closest('.workspace-split.mod-right-split');dock.style.width='${sidebar}px';dock.style.flexBasis='${sidebar}px';dock.style.minWidth='${sidebar}px';const input=root.querySelector('.dc-input');input.value=${JSON.stringify(long)};input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);await settle();
   const state=await evaluate(`(()=>{const r=document.querySelector('.dc-sidebar'),i=r.querySelector('.dc-input'),reader=r.querySelector('.dc-reader'),buttons=[...r.querySelectorAll('.dc-composer button')].filter(b=>!b.hidden&&getComputedStyle(b).display!=='none'),a=r.getBoundingClientRect();return{height:a.height,inputHeight:i.getBoundingClientRect().height,inputScrollable:i.scrollHeight>i.clientHeight,readerHeight:reader.getBoundingClientRect().height,overflow:r.scrollWidth>r.clientWidth+1,controlsInside:buttons.every(b=>{const q=b.getBoundingClientRect();return q.y>=a.y&&q.bottom<=a.bottom+1&&q.x>=a.x-1&&q.right<=a.right+1;})};})()`);
   assert(state.controlsInside&&!state.overflow&&state.inputScrollable&&state.inputHeight<=140,JSON.stringify(state));assert(state.readerHeight>=state.height/2,JSON.stringify(state));layouts.push({viewport:[width,height],sidebar,theme,...state});
   await evaluate('document.querySelector(".dc-more-button").click()');await settle();assert(await evaluate('(()=>{const r=document.querySelector(".dc-secondary-popover").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1;})()'));
   await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
   if(width===1280&&sidebar===400)await screenshot('silver-layout-'+theme);
  }
  const point=await evaluate('(()=>{const i=document.querySelector(".dc-input");i.scrollTop=0;const r=i.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');await call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:500});await wait('document.querySelector(".dc-input").scrollTop>0');
  await writeFile(resolve(output,'layouts.json'),JSON.stringify(layouts,null,2)+'\n');return{cases:layouts.length,nativeInputWheel:true};
 });
 await check('标签只改变阅读，空输入禁用，中文组词期间不发送',async()=>{
  await evaluate(`(()=>{const r=document.querySelector('.dc-sidebar'),i=r.querySelector('.dc-input');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));[...r.querySelectorAll('.dc-reader-tab')].find(b=>b.textContent.includes('批注'))?.click();return true;})()`);await settle();
  assert(await evaluate('document.querySelector(".dc-composer .mod-cta").disabled'));
  const before=mock.stats.requests;await evaluate('(()=>{const i=document.querySelector(".dc-input");i.focus();i.value="正在组词";i.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
  await call('Input.imeSetComposition',{text:'中文组词',selectionStart:4,selectionEnd:4});
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',modifiers:4,windowsVirtualKeyCode:13});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',modifiers:4,windowsVirtualKeyCode:13});await settle();assert.equal(mock.stats.requests,before);
  await call('Input.insertText',{text:'中文组词完成'});return{emptyInputDisabled:true,viewingTabDoesNotSend:true,chromiumCompositionGuard:true,physicalMacImeNotManuallyTested:true};
 });
 await writeFile(resolve(output,'operation-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 await writeFile(resolve(output,'obsidian-mock-verification.json'),JSON.stringify({version:currentManifest.version,at:new Date().toISOString(),syntheticOnly:true,checks,mockRequests:mock.stats,physicalKeyboardVerification:false},null,2)+'\n');
 console.log(JSON.stringify({passed:checks.length,screenshots:output,syntheticOnly:true}));
} finally{await mock.close();desktop.close();}
