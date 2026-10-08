/** Developer diagnostics only. Uses the running plugin; never exports credentials or private prose. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const command = process.argv[2] ?? 'status';
const pages = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = pages.find(p => p.url === 'app://obsidian.md/index.html' && p.title.includes('personal_database'));
if (!page) throw new Error('Configured Obsidian vault is unavailable.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const value = JSON.parse(e.data), entry = pending.get(value.id);
  if (entry) { clearTimeout(entry.timer); pending.delete(value.id); value.error ? entry.reject(new Error('Desktop diagnostics failed.')) : entry.resolve(value.result); }
});
async function evaluate(expression) {
  const result = await new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject, timer: setTimeout(() => reject(new Error('Desktop diagnostics timed out.')), 60000) });
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (result.exceptionDetails) throw new Error('A controlled diagnostics assertion failed. No raw error was exported.');
  return result.result.value;
}
try {
  let result;
  if (command === 'status') {
    result = await evaluate(`(() => {
      const plugin=app.plugins.plugins['draft-companion'],h=plugin?.controller,p=h?.data.providers.find(p=>p.id===h.data.activeProviderId);
      const s=h?.currentSession(),r=s?.review?.runs.at(-1),synthetic=s?.document.path==='Projects/obsidian_side_review/fixtures/接口接入验收-0.2.2.md';
      return {version:plugin?.manifest.version,provider:p?.name,model:p?.model,stream:p?.stream,configured:!!p?.model,
        running:!!h?.running,targetIsSynthetic:synthetic,modelsStatus:p?.modelsStatus,chatStatus:p?.chatStatus,
        syntheticEditorOpen:app.workspace.getLeavesOfType('markdown').some(l=>l.view.file?.path==='Projects/obsidian_side_review/fixtures/接口接入验收-0.2.2.md'),
        syntheticViews:app.workspace.getLeavesOfType('markdown').filter(l=>l.view.file?.path==='Projects/obsidian_side_review/fixtures/接口接入验收-0.2.2.md').map(l=>({mode:l.view.getMode(),highlights:l.view.contentEl.querySelectorAll('.dc-review-highlight').length})),
        sidebarEntryPresent:!!document.querySelector('.dc-review-entry'),
        syntheticRun:synthetic&&r?{status:r.status,added:r.added,duplicates:r.duplicates,errorKind:r.errorKind,error:r.errorDiagnostic,
          snapshotMatchesBuffer:r.snapshot===h.documents.bufferText(s.document),suggestions:s.review.suggestions.filter(x=>x.runId===r.id).map(x=>({state:x.state,located:!!x.anchors?.target.valid}))}:undefined,
        highlights:synthetic?document.querySelectorAll('.dc-review-highlight').length:undefined,
        reviewView:!!document.querySelector('.dc-review-view'),modalCount:document.querySelectorAll('.modal').length};
    })()`);
  } else if (command === 'models') {
    result=await evaluate(`(async()=>{const h=app.plugins.plugins['draft-companion']?.controller,p=h?.data.providers.find(p=>p.id===h.data.activeProviderId);if(!p||h.running)throw new Error('Not idle');const started=Date.now();try{const models=await h.models(structuredClone(p));return{provider:p.name,model:p.model,status:'completed',count:models.length,selectedIncluded:models.some(m=>m.id===p.model),durationMs:Date.now()-started};}catch(error){return{provider:p.name,model:p.model,status:'failed',error:error.diagnostics};}})()`);
  } else if (command === 'linkage') {
    result=await evaluate(`(async()=>{
      const h=app.plugins.plugins['draft-companion']?.controller,q=window.__dc022Synthetic;
      if(!h||h.running||!q)throw new Error('Missing completed synthetic run');
      const s=h.reviews.session(q.documentId);if(s.document.path!=='Projects/obsidian_side_review/fixtures/接口接入验收-0.2.2.md')throw new Error('Not synthetic');
      const suggestions=s.review.suggestions.filter(x=>x.runId===q.runId&&x.state==='pending');if(suggestions.length!==2)throw new Error('Expected two genuine suggestions');
      const first=suggestions[0],second=suggestions[1],before=await h.documents.read(s.document);
      const p=await h.previewSuggestion(s.document.id,first.id);
      const previewOnly=await h.documents.read(s.document)===before;
      const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===s.document.path);
      const highlights=leaf?.view.contentEl.querySelectorAll('.dc-review-highlight').length||0;
      if(!p.valid||p.after===undefined||!previewOnly)throw new Error('Preview failed');
      await h.acceptSuggestion(s.document.id,first.id);
      const applied=await h.documents.read(s.document)===p.after,independentStillValid=(await h.previewSuggestion(s.document.id,second.id)).valid;
      if(!applied||!independentStillValid)throw new Error('Apply failed');
      await h.undoSuggestion(s.document.id,first.id);
      const exactUndo=await h.documents.read(s.document)===before;
      if(!exactUndo)throw new Error('Undo failed');
      return{provider:s.review.runs.at(-1).providerName,model:s.review.runs.at(-1).model,syntheticOnly:true,genuineSuggestions:2,
        previewOnly,appliedMatchesPreview:applied,independentStillValid,exactUndo,sourceHighlights:highlights,
        realModelCallsDuringLinkage:0,method:'Actual Obsidian plugin API assertions; physical button verification recorded separately'};
    })()`);
  } else if (command === 'review') {
    result = await evaluate(`(async () => {
      const h=app.plugins.plugins['draft-companion']?.controller;
      const path='Projects/obsidian_side_review/fixtures/接口接入验收-0.2.2.md',file=app.vault.getAbstractFileByPath(path);
      if(!h||h.running||!file||app.plugins.plugins['draft-companion'].manifest.version!=='0.2.2')throw new Error('Review preconditions failed');
      const doc=h.documents.recordFor(file),session=h.store.sessionFor(doc),before=await h.documents.read(doc);
      if(!before.includes('这是合成测试稿，不是用户的真实文章。')||!before.includes('第二处记录：再看表达是否具体。'))throw new Error('Not synthetic');
      const p=h.data.providers.find(p=>p.id===h.data.activeProviderId),started=Date.now();
      const input='这是合成验收材料。请返回两条重要的表达批注，并提供非空的原地替换句：一条审阅“这款工具非常非常方便，真的特别好用。”，另一条审阅第二处“这个方法非常非常有用。”（它紧邻第二处记录：再看表达是否具体。）。重复句必须逐字提供紧邻上下文（包括换行）来区分，第一条唯一原句的上下文请用空字符串。说明问题和修改理由，保留作者口吻，不编造新事实。只返回运行时协议规定的完整JSON。';
      let failure;
      try{await h.reviewRequest(session,input,'body');}catch(error){failure={category:error.kind||'review',diagnostic:error.diagnostics};}
      const r=session.review.runs.at(-1),suggestions=session.review.suggestions.filter(x=>x.runId===r.id);
      const unchanged=await h.documents.read(doc)===before;
      const synthetic={documentId:doc.id,runId:r.id,before};window.__dc022Synthetic=synthetic;
      const facts={version:'0.2.2',provider:p.name,model:p.model,stream:p.stream,durationMs:Date.now()-started,status:r.status,
        added:r.added,pending:suggestions.filter(x=>x.state==='pending').length,comments:suggestions.filter(x=>x.state==='comment').length,
        unlocated:suggestions.filter(x=>x.state==='unlocated').length,unchanged,snapshotMatches: r.snapshot===before,
        repeatedQuoteCorrect:suggestions.some(x=>x.quote==='这个方法非常非常有用。'&&x.anchors?.target.from===before.lastIndexOf(x.quote)),
        syntheticOnly:true,officialSecretStorage:true,failure};
      if(!unchanged)throw new Error('Review modified synthetic source');return facts;
    })()`);
  } else if (command === 'install') {
    const files = Object.fromEntries(await Promise.all(['main.js','manifest.json','styles.css'].map(async name => [name,await readFile(resolve(name),'utf8')])));
    result = await evaluate(`(async () => {
      const plugin=app.plugins.plugins['draft-companion'];if(!plugin||plugin.controller.running)throw new Error('Not idle');
      const h=plugin.controller,dir=plugin.manifest.dir,files=${JSON.stringify(files)},next=JSON.parse(files['manifest.json']);
      if(next.id!=='draft-companion'||next.version!=='0.2.2'||!dir)throw new Error('Unexpected package');
      const digest=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const before={providers:digest(h.data.providers),roles:digest(h.data.roles),sessions:digest(h.data.sessions),preferences:digest(h.data.preferences)};
      await h.saveSettings();
      const backup={};for(const name of Object.keys(files))backup[name]=await app.vault.adapter.read(dir+'/'+name);
      window.__dc022RuntimeBackup={dir,files:backup,version:plugin.manifest.version};
      await app.plugins.disablePlugin('draft-companion');
      try{
        for(const [name,content] of Object.entries(files))await app.vault.adapter.write(dir+'/'+name,content);
        app.plugins.manifests['draft-companion']={...next,dir};await app.plugins.enablePlugin('draft-companion');
        const current=app.plugins.plugins['draft-companion'];if(current?.manifest.version!==next.version)throw new Error('Reload failed');
        const data=current.controller.data;
        const preserved=Object.entries(before).every(([key,hash])=>digest(data[key])===hash);
        if(!preserved)throw new Error('State preservation failed');
        return {installed:next.version,providers: data.providers.length,roles:data.roles.length,sessions:Object.keys(data.sessions).length,preserved:true,credentialFilesRead:false};
      }catch(error){
        await app.plugins.disablePlugin('draft-companion');
        for(const [name,content] of Object.entries(backup))await app.vault.adapter.write(dir+'/'+name,content);
        app.plugins.manifests['draft-companion']={...JSON.parse(backup['manifest.json']),dir};await app.plugins.enablePlugin('draft-companion');throw error;
      }
    })()`);
  } else throw new Error('Unsupported diagnostics command.');
  console.log(JSON.stringify(result,null,2));
  if(['install','review','models','linkage'].includes(command)){
    await mkdir(resolve('docs/qa-0.2.2'),{recursive:true});
    const reports={install:'local-install-verification.json',review:'real-review-verification.json',models:'model-discovery-verification.json',linkage:'real-linkage-verification.json'};
    await writeFile(resolve('docs/qa-0.2.2',reports[command]),JSON.stringify({at:new Date().toISOString(),...result},null,2)+'\n');
  }
} finally { for (const entry of pending.values()) clearTimeout(entry.timer); ws.close(); }
