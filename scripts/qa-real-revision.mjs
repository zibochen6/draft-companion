/** Focused real revision in an explicitly isolated host. One stdin credential line. */
import { createInterface } from 'node:readline';
import { realpath, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const args=process.argv.slice(2), arg=k=>args[args.indexOf(k)+1];
const expected=await realpath(arg('--vault'));
if(!expected.includes('draft-companion-qa-')||!expected.endsWith('/TestVault'))throw new Error('Only an isolated test vault is permitted.');
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});let config;
for await(const line of lines){config=JSON.parse(line);break;}lines.close();process.stdin.pause();
let key=config.key;config.key='';
const safe=s=>String(s).split(key||'\u0000').join('[REDACTED]');
const pages=await(await fetch(`http://127.0.0.1:${Number(arg('--port')||9334)}/json/list`)).json();
const target=pages.find(p=>p.title.includes('TestVault')&&p.url==='app://obsidian.md/index.html');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let serial=0;const pending=new Map();
ws.addEventListener('message',e=>{const r=JSON.parse(e.data),p=pending.get(r.id);if(p){clearTimeout(p.timer);pending.delete(r.id);p.resolve(r);}});
async function call(method,params){const id=++serial;const promise=new Promise((resolve,reject)=>pending.set(id,{resolve,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Desktop debugging timeout'));},60000)}));ws.send(JSON.stringify({id,method,params}));const r=await promise;if(r.error)throw new Error('Desktop debugging command failed');return r.result;}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(safe(r.exceptionDetails.exception?.description||r.exceptionDetails.text).slice(0,300));return r.result.value;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={startedAt:new Date().toISOString(),baseUrl:config.baseUrl,model:config.model,checks:[]};let installed=false;
try{
 assert.equal(await realpath(await evaluate('app.vault.adapter.getBasePath()')),expected);
 await evaluate(`(async()=>{const h=app.plugins.plugins['draft-companion'].controller;if(h.running||window.dcrealrevision||window.dcrealqa)throw new Error('Busy test host');const storage=h.app.secretStorage;window.dcrealrevision={h,key:${JSON.stringify(key)},storage,descriptor:Object.getOwnPropertyDescriptor(storage,'getSecret'),originalGet:storage.getSecret,providers:structuredClone(h.data.providers),active:h.data.activeProviderId};storage.getSecret=function(ref){return ref==='dc-focused-memory'?dcrealrevision.key:dcrealrevision.originalGet.call(this,ref);};h.data.providers=[{id:'focus',name:'真实API指定改稿复验',baseUrl:${JSON.stringify(config.baseUrl)},model:${JSON.stringify(config.model)},secretRef:'dc-focused-memory',stream:true,timeoutMs:120000}];h.data.activeProviderId='focus';const leaf=app.workspace.getLeaf(false);await leaf.openFile(app.vault.getAbstractFileByPath('Workflow.md'));dcrealrevision.view=leaf.view;dcrealrevision.before=leaf.view.editor.getValue();await h.chooseRole('revision-editor');app.commands.executeCommandById('draft-companion:open-sidebar');return true;})()`);
 installed=true;
 console.log('实际指定改稿请求开始（保留既有会话与用户拒绝记录）');
 const began=performance.now();
 await evaluate(`(()=>{const q=dcrealrevision;q.done=false;q.error='';q.s=q.h.currentSession();q.promise=q.h.send('请只将正文中一处“容易”改为“可能”，其他所有正文字符逐字保留。作者判断与所有引用和代码不得删改。不增加事实；输出完整目标正文JSON。','edit','body').then(()=>q.done=true).catch(e=>{q.error=String(e.message).split(q.key).join('[REDACTED]');q.done=true;});return true;})()`);
 let last=performance.now();let state;
 for(;;){state=await evaluate('({done:dcrealrevision.done,error:dcrealrevision.error,chars:dcrealrevision.h.running?.text.length||0})');if(state.done)break;if(performance.now()-began>130000){await evaluate('dcrealrevision.h.stop();true');throw new Error('Focused request did not finish within its active-time deadline');}if(performance.now()-last>10000){console.log(JSON.stringify({phase:'revision',activeWaitSeconds:Math.round((performance.now()-began)/1000),characters:state.chars}));last=performance.now();}await sleep(300);}
 if(state.error)throw new Error(state.error);
 const generated=await evaluate(`(()=>{const q=dcrealrevision,c=q.s.candidate;return {ready:c?.state==='ready',role:q.s.messages.filter(m=>m.role==='assistant').at(-1)?.roleName,status:q.s.messages.filter(m=>m.role==='assistant').at(-1)?.status,rejectionPresent:q.s.messages.some(m=>m.role==='user'&&m.content.includes('我拒绝')),characters:c?.replacement.length};})()`);
 assert(generated.ready);assert.equal(generated.status,'completed');assert(generated.rejectionPresent);
 report.checks.push({name:'真实指定改稿JSON候选',passed:true,durationMs:Math.round(performance.now()-began),...generated});
 await evaluate(`(()=>{const q=dcrealrevision;q.c=q.s.candidate;const button=[...document.querySelectorAll('.dc-candidate-bar button')].find(b=>b.textContent==='预览差异');if(!button)throw new Error('Preview button missing');button.click();return true;})()`);
 await evaluate(`(()=>{const button=[...document.querySelectorAll('.dc-candidate-modal button')].find(b=>b.textContent==='应用整批修改');if(!button)throw new Error('Apply button missing');button.click();return true;})()`);
 const appliedStart=performance.now();while(!(await evaluate('dcrealrevision.c.state === "applied"'))){if(performance.now()-appliedStart>8000)throw new Error('Apply did not complete');await sleep(100);}
 const result=await evaluate(`(()=>{const q=dcrealrevision,after=q.view.editor.getValue();return {originalPrefixPreserved:after.slice(0,q.c.from)===q.before.slice(0,q.c.from),authorJudgmentPreserved:after.includes('作者判断：工具应保留人的判断，修改需要先预览。'),onlyIntendedChange:after===q.before.replace('容易','可能'),explanationOutsideBody:!after.includes('explanation'),appliedState:q.c.state};})()`);
 assert(result.originalPrefixPreserved);assert(result.authorJudgmentPreserved);assert(result.onlyIntendedChange);assert(result.explanationOutsideBody);
 report.checks.push({name:'实际差异弹窗应用指定改稿',passed:true,...result});
 await evaluate('dcrealrevision.h.undo()');assert.equal(await evaluate('dcrealrevision.view.editor.getValue()===dcrealrevision.before'),true);
 report.checks.push({name:'实际条件撤回恢复全文',passed:true});report.passed=true;
 console.log('指定改稿、差异应用与全文撤回通过');
}catch(error){report.passed=false;report.error=safe(error.message);console.log(JSON.stringify({passed:false,error:report.error}));process.exitCode=1;}
finally{
 try{report.memoryCleaned=await evaluate(`(async()=>{const q=window.dcrealrevision;if(!q)return true;q.h.stop();if(q.descriptor)Object.defineProperty(q.storage,'getSecret',q.descriptor);else delete q.storage.getSecret;delete q.key;q.h.data.providers=q.providers;q.h.data.activeProviderId=q.active;await q.h.saveSettings();delete window.dcrealrevision;return true;})()`);}catch{report.memoryCleaned=false;process.exitCode=1;}
 report.completedAt=new Date().toISOString();report.secretPersisted=false;await writeFile('docs/real-api-revision.json',safe(JSON.stringify(report,null,2))+'\n');key='';ws.close();
}
