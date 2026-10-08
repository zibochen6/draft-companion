/** One configured model, synthetic material only, credentials only through official SecretStorage. */
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-qa-client.mjs';
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
const output=resolve('docs/qa-'+manifest.version);await mkdir(output,{recursive:true});
const topicInput='帮我选择一些适合的选题来创作公众号。以及同时给我合适的爆款标题参考。';
const stages=[];
const real=await connectDesktop(9333,'personal_database'),test=await connectDesktop(9334,'TestVault');
const paths=JSON.parse(await readFile('/tmp/draft-companion-qa-020-path.json','utf8'));
const source='# 合成选题库（非真实项目）\n\n以下只是合成验收素材，所有链接均为保留测试域名，不能声称读过网页。\n\n- [ ] **synthetic-doc-checker** — 帮助内容作者按自己提供的核对清单标记文案缺项。材料只有这句描述。｜ https://example.invalid/checker\n- [ ] **synthetic-cost-notes** — 把作者自己填写的用量记录列为费用表，不会自动取得账户费用。材料只有这句描述。｜ https://example.invalid/cost\n- [ ] **synthetic-idea-box** — 为已提供的想法按目标读者整理标签，读者判断由作者完成。材料只有这句描述。｜ https://example.invalid/ideas\n\n作者声明：这是合成测试库，不是用户的真实文章。\n'+Array.from({length:12},(_,i)=>`\n- [ ] **synthetic-writing-note-${i+1}** — 这也是合成项目，只把作者提供的写作笔记按场景归档：记录一个具体问题、已有材料和缺少证据，不会联网抓取内容，也不能代替作者的判断。｜ https://example.invalid/notes/${i+1}`).join('')+'\n';
let credential;
try {
 assert.equal(await real.evaluate('app.vault.adapter.getBasePath()'),'/Users/chenzibo/data/project/personal_database');assert.equal(await realpath(await test.evaluate('app.vault.adapter.getBasePath()')),await realpath(paths.vault));
 credential=await real.evaluate(`(()=>{const h=app.plugins.plugins['draft-companion']?.controller,p=h?.data.providers.find(p=>p.id===h.data.activeProviderId);if(!p?.model||h.running)throw new Error('Configured model unavailable');return{provider:{...p},secret:p.secretRef?app.secretStorage.getSecret(p.secretRef):undefined};})()`);
 assert(!credential.provider.secretRef || credential.secret,'Configured official key reference must resolve');
 await test.evaluate(`(async()=>{const h=app.plugins.plugins['draft-companion'].controller;if(h.running)throw new Error('Busy');const file=app.vault.getAbstractFileByPath('0.3真实模型合成选题库.md')||await app.vault.create('0.3真实模型合成选题库.md',${JSON.stringify(source)});const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===file)||app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.loadIfDeferred();await leaf.view.setState({...leaf.view.getState(),mode:'source'},{history:false});leaf.view.editor.setValue(${JSON.stringify(source)});app.workspace.setActiveLeaf(leaf,{focus:true});h.documents.focus(leaf);const s=h.currentSession();s.messages=[];s.agentActions=[];delete s.candidate;delete s.review;const p=${JSON.stringify(credential.provider)};p.id='qa-real-model';p.toolMode='auto';p.secretRef=${JSON.stringify(credential.secret?'dc030-synthetic-validation':'')};${credential.secret?`app.secretStorage.setSecret(p.secretRef,${JSON.stringify(credential.secret)});`:''}h.data.providers=[p];h.data.activeProviderId=p.id;h.data.toolCapabilities={};await h.saveSettings();app.commands.executeCommandById('draft-companion:open-sidebar');window.dcReal030={h,s,leaf,before:${JSON.stringify(source)},started:Date.now(),done:false};h.sendAgent(${JSON.stringify(topicInput)},{task:'auto'}).catch(e=>{dcReal030.error=e.message;}).finally(()=>{dcReal030.done=true;});return{started:true,model:p.model,provider:p.name};})()`);
 // The secret remains only in memory and the isolated official secret store, never in reports or ordinary plugin data.
 credential.secret=undefined;
 const end=Date.now()+240000;while(Date.now()<end){const state=await test.evaluate('({done:dcReal030.done,stage:dcReal030.h.running?.stage,running:!!dcReal030.h.running})');if(state.stage&&stages.at(-1)?.stage!==state.stage)stages.push({stage:state.stage,at:new Date().toISOString()});if(state.done)break;await new Promise(r=>setTimeout(r,2000));}
 const result=await test.evaluate(`(()=>{const q=dcReal030,text=q.leaf.view.editor.getValue(),changed=[];for(let i=0;i<Math.max(text.length,q.before.length);i++)if(text[i]!==q.before[i])changed.push(i);return{done:q.done,error:q.error,version:app.plugins.plugins['draft-companion'].manifest.version,provider:q.h.data.providers[0].name,model:q.h.data.providers[0].model,protocol:Object.values(q.h.data.toolCapabilities)[0],durationMs:Date.now()-q.started,source:q.before,after:text,changedOffsets:changed,feedback:q.s.messages.filter(m=>m.role==='assistant').at(-1)?.content,receipts:q.s.agentActions.map(r=>({kind:r.kind,state:r.state,before:r.before,replacement:r.replacement,label:r.label})),syntheticOnly:true,officialSecretStorage:true,dailyVaultModelRequests:0,dailyVaultArticleWrites:0};})()`);
 result.input=topicInput;result.explicitTask='auto';result.stages=stages;result.documentCharacters=source.length;
 await writeFile(resolve(output,'real-model-verification.json'),JSON.stringify({at:new Date().toISOString(),...result},null,2)+'\n');
 if(result.done&&!result.error&&result.changedOffsets.length===1&&result.receipts.length===1&&result.receipts[0].state==='applied'){
  const shot=await test.call('Page.captureScreenshot',{format:'png'});await writeFile(resolve(output,'real-model-topic.png'),Buffer.from(shot.data,'base64'));
  await test.evaluate('dcReal030.h.undoAgentAction(dcReal030.s.agentActions[0].id)');assert.equal(await test.evaluate('dcReal030.leaf.view.editor.getValue()'),source);
  result.exactLocalUndo=true;
  result.passed=true;
  await test.evaluate(`(()=>{const q=dcReal030;q.s.messages=[];q.h.changed();q.recommendDone=false;q.h.sendAgent('帮我选择一些适合的选题并给出标题，但只推荐，不要勾选。',{task:'auto'}).catch(e=>q.recommendError=e.message).finally(()=>q.recommendDone=true);return true;})()`);
  const recommendEnd=Date.now()+180000;while(Date.now()<recommendEnd){if(await test.evaluate('dcReal030.recommendDone'))break;await new Promise(r=>setTimeout(r,1000));}
  result.recommendation=await test.evaluate(`(()=>{const q=dcReal030;return{done:q.recommendDone,error:q.recommendError,zeroWrites:q.leaf.view.editor.getValue()===q.before,appliedReceipts:q.s.agentActions.filter(r=>r.state==='applied').length,feedback:q.s.messages.filter(m=>m.role==='assistant').at(-1)?.content};})()`);
  assert(result.recommendation.done&&!result.recommendation.error&&result.recommendation.zeroWrites&&result.recommendation.appliedReceipts===0,'Read-only synthetic recommendation must not write');
  result.recommendation.passed=true;
  const article='---\ntitle: 合成局部执行\n---\n# 合成文稿\n\n这段合成表达需要更直接一些。😀\n\n'+('独立段落保持原样。\n'.repeat(8));
  const original='这段合成表达需要更直接一些。😀',replacement='先核对材料，再写出建议。😀';
  await test.evaluate(`(async()=>{const q=dcReal030,file=app.vault.getAbstractFileByPath('0.3真实模型合成改稿.md')||await app.vault.create('0.3真实模型合成改稿.md',${JSON.stringify(article)}),leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===file)||app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.loadIfDeferred();await leaf.view.setState({...leaf.view.getState(),mode:'source'},{history:false});leaf.view.editor.setValue(${JSON.stringify(article)});app.workspace.setActiveLeaf(leaf,{focus:true});q.h.documents.focus(leaf);const e=leaf.view.editor,from=e.getValue().indexOf(${JSON.stringify(original)});e.setSelection(e.offsetToPos(from),e.offsetToPos(from+${original.length}));q.h.documents.cacheSelection(file,e,true);q.editSession=q.h.currentSession();q.editSession.messages=[];q.editSession.agentActions=[];q.editLeaf=leaf;q.editDone=false;delete q.editError;q.h.sendAgent(${JSON.stringify('把选中的段落直接改成“'+replacement+'”，其他内容逐字保持。')},{task:'execute',scope:'selection'}).catch(e=>q.editError=e.message).finally(()=>q.editDone=true);return true;})()`);
  const editEnd=Date.now()+180000;while(Date.now()<editEnd){if(await test.evaluate('dcReal030.editDone'))break;await new Promise(r=>setTimeout(r,1000));}
  const edit=await test.evaluate(`(()=>{const q=dcReal030;return{done:q.editDone,error:q.editError,after:q.editLeaf.view.editor.getValue(),feedback:q.editSession.messages.filter(m=>m.role==='assistant').at(-1)?.content,receipts:q.editSession.agentActions.map(r=>({kind:r.kind,state:r.state,label:r.label}))};})()`);
  edit.before=article;edit.syntheticOnly=true;edit.onlyFrozenSelectionChanged=edit.after===article.replace(original,replacement);
  if(edit.done&&!edit.error&&edit.onlyFrozenSelectionChanged&&edit.receipts.length===1&&edit.receipts[0].state==='applied'){
   const shot=await test.call('Page.captureScreenshot',{format:'png'});await writeFile(resolve(output,'real-model-local-edit.png'),Buffer.from(shot.data,'base64'));
   await test.evaluate(`(()=>{const q=dcReal030,e=q.editLeaf.view.editor,end=e.getValue().length;e.replaceRange('作者后来追加的独立文字。',e.offsetToPos(end));return true;})()`);
   await test.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
   await test.evaluate('dcReal030.h.undoAgentAction(dcReal030.editSession.agentActions[0].id)');
   edit.undo=await test.evaluate('dcReal030.editLeaf.view.editor.getValue()');edit.undoPreservesUnrelatedEdit=edit.undo===article+'作者后来追加的独立文字。';
   assert(edit.undoPreservesUnrelatedEdit);edit.passed=true;
  }else edit.passed=false;
  result.localEdit=edit;result.passed=edit.passed;
  await writeFile(resolve(output,'real-operation-evidence.json'),JSON.stringify([{flow:'real-model-topic',source:result.source,after:result.after,feedback:result.feedback,receipts:result.receipts,exactLocalUndo:true}, {flow:'real-model-local-edit',...edit}],null,2)+'\n');
 } else {result.passed=false;}
 await writeFile(resolve(output,'real-model-verification.json'),JSON.stringify({at:new Date().toISOString(),...result},null,2)+'\n');
 console.log(JSON.stringify({version:result.version,provider:result.provider,model:result.model,protocol:result.protocol,done:result.done,error:result.error,oneCharacterChanged:result.changedOffsets.length===1,receipts:result.receipts.length,exactLocalUndo:result.exactLocalUndo,localEditPassed:result.localEdit?.passed,durationMs:result.durationMs,syntheticOnly:true}));
 if(result.passed===false)process.exitCode=1;
} finally {
 credential=undefined;
 await test.evaluate(`(()=>{if(window.dcReal030?.h.running)dcReal030.h.stop();app.secretStorage.setSecret('dc030-synthetic-validation','');return true;})()`).catch(()=>undefined);
 real.close();test.close();
}
