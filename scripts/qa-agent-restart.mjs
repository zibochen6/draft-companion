/** Native undo/redo and restart receipt verification in the isolated synthetic Vault only. */
import {readFile,writeFile,realpath, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-qa-client.mjs';
import {createMockAgentProvider} from './mock-agent-provider.mjs';
const paths=JSON.parse(await readFile('/tmp/draft-companion-qa-020-path.json','utf8'));
const c=await connectDesktop(9334,'TestVault'),mock=await createMockAgentProvider();
const source='# 合成重启选题库\n\n- [ ] **synthetic-restart** — 合成材料，仅验证操作回执。\n- [ ] **synthetic-other** — 独立的另一条。\n';
const wait=async(expression)=>{const end=Date.now()+10000;while(Date.now()<end){if(await c.evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Controlled restart state unavailable');};
try{
 assert.equal(await realpath(await c.evaluate('app.vault.adapter.getBasePath()')),await realpath(paths.vault));
 await c.evaluate(`(async()=>{const h=app.plugins.plugins['draft-companion'].controller;if(h.running)throw new Error('Busy');const file=app.vault.getAbstractFileByPath('0.3合成重启选题库.md')||await app.vault.create('0.3合成重启选题库.md',${JSON.stringify(source)});const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===file)||app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.loadIfDeferred();await leaf.view.setState({...leaf.view.getState(),mode:'source'},{history:false});leaf.view.editor.setValue(${JSON.stringify(source)});app.workspace.setActiveLeaf(leaf,{focus:true});h.documents.focus(leaf);const s=h.currentSession();s.messages=[];s.agentActions=[];h.data.providers=[{id:'mock-restart',name:'隔离模拟服务',baseUrl:'http://127.0.0.1:${mock.port}/v1',secretRef:'',model:'synthetic-model',stream:true,timeoutMs:10000,toolMode:'native'}];h.data.activeProviderId='mock-restart';window.dcRestart030={h,s,leaf,file,before:${JSON.stringify(source)},done:false};h.sendAgent('帮我选一个并勾选。',{task:'topic'}).then(()=>dcRestart030.done=true,e=>{dcRestart030.error=e.message;dcRestart030.done=true;});return true;})()`);
 await wait('dcRestart030.done');assert(!await c.evaluate('dcRestart030.error'));
 const after=source.replace('- [ ] **synthetic-restart**','- [x] **synthetic-restart**');
 assert.equal(await c.evaluate('dcRestart030.leaf.view.editor.getValue()'),after);
 await c.evaluate('(()=>{app.workspace.setActiveLeaf(dcRestart030.leaf,{focus:true});dcRestart030.leaf.view.editor.focus();return true;})()');
 await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:4,windowsVirtualKeyCode:90});await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:4,windowsVirtualKeyCode:90});
 await wait('dcRestart030.leaf.view.editor.getValue()===dcRestart030.before');assert.equal(await c.evaluate('dcRestart030.s.agentActions[0].state'),'undone');
 await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:12,windowsVirtualKeyCode:90});await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:12,windowsVirtualKeyCode:90});
 await wait('dcRestart030.s.agentActions[0].state==="applied"');assert.equal(await c.evaluate('dcRestart030.leaf.view.editor.getValue()'),after);
 await wait(`(async()=>await app.vault.read(dcRestart030.file)===${JSON.stringify(after)})()`);
 const requestCount=mock.stats.requests;
 await c.evaluate(`(async()=>{const q=dcRestart030;q.documentId=q.s.document.id;q.actionId=q.s.agentActions[0].id;await q.h.saveSettings();await app.plugins.disablePlugin('draft-companion');await q.h.store.save();await app.plugins.enablePlugin('draft-companion');q.h=app.plugins.plugins['draft-companion'].controller;q.h.documents.focus(q.leaf);q.s=q.h.currentSession();await q.h.validateDocumentActions(q.documentId);return true;})()`);
 assert.equal(mock.stats.requests,requestCount);assert.equal(await c.evaluate('dcRestart030.h.data.version'),3);assert.equal(await c.evaluate('dcRestart030.leaf.view.editor.getValue()'),after);
 assert(await c.evaluate('dcRestart030.h.canUndoAgentAction(dcRestart030.actionId)'));
 await c.evaluate('dcRestart030.h.undoAgentAction(dcRestart030.actionId)');assert.equal(await c.evaluate('dcRestart030.leaf.view.editor.getValue()'),source);
 const result={at:new Date().toISOString(),version:'0.3.0',syntheticOnly:true,actualObsidian:true,nativeUndoStateVerified:true,nativeRedoStateVerified:true,restartNoReplay:true,strongIdentityRestored:true,exactUndoAfterRestart:true,modelProtocol:'native',modelIsMock:true,passed:true};
 await mkdir(resolve('docs/qa-0.3.0'),{recursive:true});await writeFile(resolve('docs/qa-0.3.0/restart-verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await mock.close();c.close();}
