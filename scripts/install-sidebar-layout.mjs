/** Update the already installed plugin through Obsidian's adapter, retaining drafts in app memory. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const files = {};
for (const name of ['main.js', 'manifest.json', 'styles.css']) files[name] = await readFile(resolve('dist/draft-companion', name), 'utf8');
const pages = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = pages.find(p => p.url === 'app://obsidian.md/index.html' && p.title.includes('personal_database'));
if (!page) throw new Error('The configured daily Vault is unavailable.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => {
  const result = JSON.parse(e.data), item = pending.get(result.id);
  if (!item) return;
  pending.delete(result.id); clearTimeout(item.timer);
  if (result.error || result.result?.exceptionDetails) item.reject(new Error('Local update failed; inspect the in-app rollback result.'));
  else item.resolve(result.result?.result?.value);
});
const evaluate = expression => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject, timer: setTimeout(() => { pending.delete(n); reject(new Error('Local update timed out.')); }, 30000) });
  ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});
try {
  const result = await evaluate(`(async()=>{
    const id='draft-companion', expectedRoot='/Users/chenzibo/data/project/personal_database';
    const fail=message=>{throw new Error(message);};
    if(app.vault.adapter.getBasePath()!==expectedRoot)fail('Vault identity mismatch');
    const previous=app.plugins.plugins[id], oldHost=previous?.controller;
    if(!oldHost||oldHost.running||oldHost.editing.size)fail('Plugin is busy or unavailable');
    await oldHost.saveSettings();
    const before=structuredClone(oldHost.data), previousManifest={...app.plugins.manifests[id]};
    const dir=previous.manifest.dir||app.vault.configDir+'/plugins/'+id;
    const backup=dir+'/rollback-layout-'+previous.manifest.version+'-'+Date.now();
    const adapter=app.vault.adapter, originals={};
    await adapter.mkdir(backup);
    for(const name of ['main.js','manifest.json','styles.css','data.json']){
      originals[name]=await adapter.read(dir+'/'+name);
      await adapter.write(backup+'/'+name,originals[name]);
      if(await adapter.read(backup+'/'+name)!==originals[name])fail('Backup verification failed');
    }
    if(oldHost.running||oldHost.editing.size)fail('Plugin became busy; update cancelled');
    const maps=['currentTab','drafts','scrollPositions','modes','scopes','selectedSuggestions','replyDrafts'];
    const keys=['sessionId','composerKey','readerKey'];
    const views=app.workspace.getLeavesOfType('draft-companion-view').map(leaf=>{
      const v=leaf.view, input=v.input, reader=v.reader;
      if(v.composerKey)v.drafts.set(v.composerKey,input.value);
      if(v.readerKey)v.scrollPositions.set(v.readerKey,reader.scrollTop);
      return {leaf,maps:Object.fromEntries(maps.map(key=>[key,new Map(v[key])])),keys:Object.fromEntries(keys.map(key=>[key,v[key]])),replyOpen:new Set(v.replyOpen),input:input.value,start:input.selectionStart,end:input.selectionEnd,inputScroll:input.scrollTop,readerScroll:reader.scrollTop,briefOpen:v.contentEl.querySelector('.dc-brief').open,focused:input.ownerDocument.activeElement===input};
    });
    const editorBuffers=app.workspace.getLeavesOfType('markdown').filter(l=>l.view.editor).map(l=>({view:l.view,text:l.view.editor.getValue(),selections:JSON.stringify(l.view.editor.listSelections())}));
    const target=oldHost.documents.target, pinned=oldHost.documents.pinnedId, selections=new Map(oldHost.documents.selections);
    const dock=document.querySelector('.dc-sidebar')?.closest('.workspace-split.mod-right-split');
    const dockStyle=dock?.getAttribute('style'), active=app.workspace.activeLeaf;
    let reloaded=false;
    const restoreViews=async plugin=>{
      const host=plugin.controller;
      host.documents.target=target;host.documents.pinnedId=pinned;host.documents.selections=selections;
      for(const saved of views){
        let leaf=saved.leaf;
        if(leaf.view.getViewType()!=='draft-companion-view')await leaf.setViewState({type:'draft-companion-view',active:false});
        await leaf.loadIfDeferred();
        const v=leaf.view;
        for(const key of maps)v[key]=new Map(saved.maps[key]);
        for(const key of keys)v[key]=saved.keys[key];
        v.replyOpen=new Set(saved.replyOpen);v.input.value=saved.input;
        v.refresh();v.contentEl.querySelector('.dc-brief').open=saved.briefOpen;
        v.reader.scrollTop=saved.readerScroll;v.input.scrollTop=saved.inputScroll;
        v.input.setSelectionRange(saved.start,saved.end);
        if(saved.focused)v.input.focus({preventScroll:true});
      }
      if(dock&&dockStyle!==null&&dockStyle!==undefined)dock.setAttribute('style',dockStyle);
      if(active&&app.workspace.activeLeaf!==active)app.workspace.setActiveLeaf(active,{focus:false});
      host.changed();
    };
    try{
      await app.plugins.disablePlugin(id);
      for(const [name,value]of Object.entries(${JSON.stringify(files)})){
        await adapter.write(dir+'/'+name,value);
        if(await adapter.read(dir+'/'+name)!==value)fail('Runtime file verification failed');
      }
      app.plugins.manifests[id]={...previousManifest,...${JSON.stringify(manifest)}};
      await app.plugins.enablePlugin(id);reloaded=true;
      const plugin=app.plugins.plugins[id];
      if(!plugin?.controller||plugin.manifest.version!==${JSON.stringify(manifest.version)}||!app.plugins.enabledPlugins.has(id))fail('Plugin did not load');
      await restoreViews(plugin);
      if(JSON.stringify(plugin.controller.data)!==JSON.stringify(before))fail('Configuration or session changed unexpectedly');
      if(editorBuffers.some(b=>b.view.editor.getValue()!==b.text||JSON.stringify(b.view.editor.listSelections())!==b.selections))fail('Editor state changed unexpectedly');
      const current=app.workspace.getLeavesOfType('draft-companion-view');
      const draftsPreserved=views.every(saved=>current.some(l=>{
        const v=l.view;return v.input.value===saved.input&&maps.every(key=>JSON.stringify([...v[key]])===JSON.stringify([...saved.maps[key]]))&&JSON.stringify([...v.replyOpen])===JSON.stringify([...saved.replyOpen]);
      }));
      if(!draftsPreserved)fail('An unsent draft was not restored');
      const root=document.querySelector('.dc-sidebar'), controls=root?.querySelector('.dc-composer-controls');
      const visible=!!root&&root.getBoundingClientRect().height>0;
      const r=root?.getBoundingClientRect();
      const controlsInside=!visible||[...controls.querySelectorAll('button')].filter(b=>!b.hidden).every(b=>{const q=b.getBoundingClientRect();return q.bottom<=r.bottom+1&&q.y>=r.y;});
      return {success:true,fromVersion:previous.manifest.version,version:plugin.manifest.version,backup,backupVerified:true,runtimeVerified:true,enabled:true,configurationAndSessionsPreserved:true,unsentDraftsPreserved:draftsPreserved,sidebarViews:views.length,unsentCharacters:views.reduce((n,v)=>n+v.input.length,0),editorTextAndSelectionPreserved:true,sidebarVisible:visible,controlsInside,moreUsesPopover:!!root?.querySelector('.dc-more-button'),modelRequests:0,articleWrites:0};
    }catch(error){
      await app.plugins.disablePlugin(id);
      for(const [name,value]of Object.entries(originals))await adapter.write(dir+'/'+name,value);
      app.plugins.manifests[id]=previousManifest;await app.plugins.enablePlugin(id);
      await restoreViews(app.plugins.plugins[id]);
      return {success:false,rolledBack:true,backup,reloaded,reason:'Update checks failed; previous runtime and data were restored.'};
    }
  })()`);
  const output=resolve('docs/qa-'+manifest.version);await mkdir(output,{recursive:true});
  await writeFile(resolve(output,'layout-local-install-verification.json'),JSON.stringify({date:new Date().toISOString(),...result},null,2)+'\n');
  console.log(result);
  if(!result?.success)process.exitCode=1;
} finally { for(const item of pending.values())clearTimeout(item.timer);ws.close(); }
