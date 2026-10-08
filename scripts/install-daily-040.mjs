/**
 * Guarded local update using Obsidian's official CLI and actual Vault adapter.
 * Usage: node scripts/install-daily-040.mjs --vault personal_database
 * Requires CLI to already be enabled. Does not enable it, run a topic task,
 * modify any article, publish, or enable scheduling. Scheduling is a separate
 * final step after the installation evidence has been reviewed.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--vault', 'personal_database'], 'Only --vault personal_database is accepted.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vaultRoot = '/Users/chenzibo/data/project/personal_database';
const binary = '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli';
const exec = promisify(execFile);
const runtimeNames = ['main.js', 'manifest.json', 'styles.css'];
const files = Object.fromEntries(await Promise.all(runtimeNames.map(async name => [name, await readFile(resolve(root, 'dist/draft-companion', name), 'utf8')])));
const manifest = JSON.parse(files['manifest.json']);
assert(manifest.id === 'draft-companion' && manifest.version === '0.4.0' && runtimeNames.every(name => files[name].length > 0), 'A complete 0.4.0 distribution is required.');
const checksums = Object.fromEntries(runtimeNames.map(name => [name, createHash('sha256').update(files[name]).digest('hex')]));
const token = randomUUID();
const guard = `if(app.vault.getName()!=='personal_database'||app.vault.adapter.getBasePath()!==${JSON.stringify(vaultRoot)})throw new Error('Installation vault identity mismatch');`;
const output = resolve(root, 'docs/qa-0.4.0');
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function evaluate(expression) {
  const code = `(()=>{${guard}const value=(${expression});return 'DC040_INSTALL_'+btoa(unescape(encodeURIComponent(JSON.stringify(value===undefined?null:value))))+'_END';})()`;
  let response;
  try {
    response = await exec(binary, ['vault=personal_database', 'eval', `code=${code}`], { timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '', stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const timedOut = error.killed === true && error.signal === 'SIGKILL' && (error.code === null || error.code === undefined || error.code === 'ETIMEDOUT');
    if (!timedOut || !/DC040_INSTALL_[A-Za-z0-9+/=]+_END/.test(stdout) || /Command line interface is not enabled|Vault not found|Error:/i.test(stdout + stderr)) throw error;
    response = { stdout, stderr };
  }
  const { stdout, stderr } = response;
  if (/Command line interface is not enabled|Vault not found|Error:/i.test(stdout + stderr)) throw new Error((stdout + stderr).slice(0, 350));
  const payload = /DC040_INSTALL_([A-Za-z0-9+/=]+)_END/.exec(stdout)?.[1];
  assert(payload, 'Official CLI did not return the guarded installation result.');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

const installation = `async function install(){
  const q=window.dc040Install, id='draft-companion', localKey='draft-companion.daily.local.v1';
  const fail=message=>{throw new Error(message);};
  const crypto=window.require('node:crypto');
  const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:new Uint8Array(value)).digest('hex');
  const stable=value=>JSON.stringify((function sort(value){if(value instanceof Map)return [...value].map(sort);if(value instanceof Set)return [...value].map(sort);if(Array.isArray(value))return value.map(sort);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])]));return value;})(value));
  const normalized=value=>{const data=structuredClone(value);delete data.version;delete data.dailyTopics;return stable(data);};
  const busy=host=>host.running||host.editing?.size||host.daily?.pending||host.daily?.active;
  if(!q||q.token!==${JSON.stringify(token)})fail('Installation payload identity mismatch');
  for(const name of ${JSON.stringify(runtimeNames)})if(digest(q.files[name])!==q.checksums[name])fail('Runtime payload checksum mismatch');
  const previous=app.plugins.plugins[id], oldHost=previous?.controller;
  if(!oldHost||!['0.3.2','0.4.0'].includes(previous.manifest.version))fail('Expected the existing 0.3.2 or guarded 0.4.0 plugin; update cancelled');
  if(busy(oldHost))fail('Plugin is busy; finish or stop its current task before updating');
  for(const leaf of app.workspace.getLeavesOfType('draft-companion-view'))await leaf.loadIfDeferred();
  if(busy(oldHost))fail('Plugin became busy while preparing its sidebar views');
  const targetPath='Projects/选题库.md', targetFile=app.vault.getAbstractFileByPath(targetPath);
  if(!targetFile||targetFile.extension!=='md')fail('The configured topic library is unavailable');
  const adapter=app.vault.adapter, targetBytes=await adapter.readBinary(targetPath), targetHash=digest(targetBytes);
  await oldHost.saveSettings();
  const before=structuredClone(oldHost.data), previousManifest={...app.plugins.manifests[id]};
  const reinstall=previous.manifest.version==='0.4.0', previousRuns=before.dailyTopics?.runs.length||0;
  const dir=previous.manifest.dir||app.vault.configDir+'/plugins/'+id;
  const backup=dir+'/rollback-daily-'+previous.manifest.version+'-'+Date.now();
  const originals={}, oldLocal=structuredClone(app.loadLocalStorage(localKey));
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const dueDate=Date.now()<Date.parse(today+'T'+(before.dailyTopics?.settings.time||'09:00')+':00+08:00')?new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10):today;
  if(reinstall&&oldLocal?.enabled&&(typeof oldLocal.handledDate!=='string'||oldLocal.handledDate<dueDate))fail('Finish the due daily task before this same-version update');
  await adapter.mkdir(backup);
  for(const name of [...${JSON.stringify(runtimeNames)},'data.json']){
    originals[name]=await adapter.read(dir+'/'+name);
    await adapter.write(backup+'/'+name,originals[name]);
    if(await adapter.read(backup+'/'+name)!==originals[name])fail('Original runtime/data backup verification failed');
  }
  const scheduleBackup=JSON.stringify({present:oldLocal!==null,value:oldLocal});
  await adapter.write(backup+'/local-schedule.json',scheduleBackup);
  if(await adapter.read(backup+'/local-schedule.json')!==scheduleBackup)fail('Local schedule backup verification failed');
  if(stable(JSON.parse(originals['data.json']))!==stable(before))fail('Backed-up data does not match the settled plugin state');
  if(busy(oldHost)||stable(oldHost.data)!==stable(before))fail('Plugin changed while preparing its backup; update cancelled');
  if(app.vault.getAbstractFileByPath(targetPath)!==targetFile||digest(await adapter.readBinary(targetPath))!==targetHash)fail('Topic library changed while preparing the update');
  const maps=['currentTab','drafts','scrollPositions','modes','scopes','selectedSuggestions','replyDrafts','tasks','closedTabs'];
  const keys=['sessionId','composerKey','readerKey'];
  const views=app.workspace.getLeavesOfType('draft-companion-view').map(leaf=>{
    const v=leaf.view,input=v.input,reader=v.reader;
    if(v.composing)fail('Finish the current input-method composition before updating');
    if(v.composerKey)v.drafts.set(v.composerKey,input.value);
    if(v.readerKey)v.scrollPositions.set(v.readerKey,reader.scrollTop);
    return{leaf,maps:Object.fromEntries(maps.map(key=>[key,new Map(v[key]||[])])),keys:Object.fromEntries(keys.map(key=>[key,v[key]])),replyOpen:new Set(v.replyOpen),input:input.value,start:input.selectionStart,end:input.selectionEnd,inputScroll:input.scrollTop,readerScroll:reader.scrollTop,briefOpen:!!v.contentEl.querySelector('.dc-brief')?.open,focused:input.ownerDocument.activeElement===input};
  });
  const editorBuffers=app.workspace.getLeavesOfType('markdown').filter(leaf=>leaf.view.editor).map(leaf=>({view:leaf.view,file:leaf.view.file,text:leaf.view.editor.getValue(),selections:JSON.stringify(leaf.view.editor.listSelections())}));
  const handoff=new Map(oldHost.documents.files), target=oldHost.documents.target,pinned=oldHost.documents.pinnedId,selections=new Map(oldHost.documents.selections);
  const dock=document.querySelector('.dc-sidebar')?.closest('.workspace-split.mod-right-split'),dockStyle=dock?.getAttribute('style'),active=app.workspace.activeLeaf;
  let mutated=false,reloaded=false;
  const preserveEditors=()=>{
    if(editorBuffers.some(b=>b.view.file!==b.file||b.view.editor.getValue()!==b.text||JSON.stringify(b.view.editor.listSelections())!==b.selections))fail('An open editor buffer or selection changed during the update');
  };
  const preserveTarget=async()=>{
    if(app.vault.getAbstractFileByPath(targetPath)!==targetFile||digest(await adapter.readBinary(targetPath))!==targetHash)fail('Topic library bytes or identity changed during the update');
  };
  const restoreViews=async plugin=>{
    if(!plugin?.controller)fail('Cannot restore the existing view without its controller');
    const host=plugin.controller;
    host.documents.target=target;host.documents.pinnedId=pinned;host.documents.selections=new Map(selections);
    for(const saved of views){
      const leaf=saved.leaf;
      if(leaf.view.getViewType()!=='draft-companion-view')await leaf.setViewState({type:'draft-companion-view',active:false});
      await leaf.loadIfDeferred();
      const v=leaf.view;
      for(const key of maps)v[key]=new Map(saved.maps[key]);
      for(const key of keys)v[key]=saved.keys[key];
      v.replyOpen=new Set(saved.replyOpen);v.input.value=saved.input;v.refresh();
      v.contentEl.querySelector('.dc-brief').open=saved.briefOpen;
      v.reader.scrollTop=saved.readerScroll;v.input.scrollTop=saved.inputScroll;v.input.setSelectionRange(saved.start,saved.end);
      if(saved.focused)v.input.focus({preventScroll:true});
    }
    if(dock) dockStyle===null||dockStyle===undefined?dock.removeAttribute('style'):dock.setAttribute('style',dockStyle);
    if(active&&app.workspace.activeLeaf!==active)app.workspace.setActiveLeaf(active,{focus:false});
    host.changed();
  };
  const preservedDrafts=()=>views.every(saved=>{
    const v=saved.leaf.view;
    return v.input.value===saved.input&&maps.every(key=>stable([...v[key]])===stable([...saved.maps[key]]))&&stable([...v.replyOpen])===stable([...saved.replyOpen]);
  });
  try{
    // Constructor/onLayoutReady cannot enqueue a due date while this flag is off.
    const disabledLocal={...(oldLocal&&typeof oldLocal==='object'?oldLocal:{}),enabled:false,deviceId:typeof oldLocal?.deviceId==='string'?oldLocal.deviceId:crypto.randomUUID()};
    app.saveLocalStorage(localKey,disabledLocal);
    if(app.loadLocalStorage(localKey)?.enabled!==false)fail('Cannot disable scheduling before the update');
    app.__draftCompanionFileHandoff=new Map(handoff);
    mutated=true;await app.plugins.disablePlugin(id);await oldHost.store.save();
    if(stable(JSON.parse(await adapter.read(dir+'/data.json')))!==stable(before))fail('Previous data changed while unloading');
    for(const name of ${JSON.stringify(runtimeNames)}){
      await adapter.write(dir+'/'+name,q.files[name]);
      if(await adapter.read(dir+'/'+name)!==q.files[name])fail('Installed runtime file verification failed');
    }
    app.plugins.manifests[id]={...previousManifest,...q.manifest};
    await app.plugins.enablePlugin(id);reloaded=true;
    const plugin=app.plugins.plugins[id],host=plugin?.controller;
    if(!host||plugin.manifest.version!=='0.4.0'||!app.plugins.enabledPlugins.has(id))fail('Updated plugin did not load');
    if(host.data.version!==4)fail('Schema 4 migration did not complete');
    if(normalized(host.data)!==normalized(before))fail('A pre-existing configuration, session, role, annotation or action changed during migration');
    if(reinstall&&stable(host.data.dailyTopics)!==stable(before.dailyTopics))fail('Existing daily settings, records or receipts changed during reload');
    if(host.daily.scheduler.enabled()||app.loadLocalStorage(localKey)?.enabled!==false||busy(host)||host.daily.data.runs.length!==previousRuns)fail('A daily task started before installation verification');
    await restoreViews(plugin);preserveEditors();await preserveTarget();
    if(!preservedDrafts())fail('An unsent draft, task or reading position was not restored');
    const identity=host.documents.recordFor(targetFile);
    if(host.data.topicLibrary?.path===targetPath&&host.data.topicLibrary.id===identity.id&&host.data.topicLibrary.ctime===identity.ctime&&!host.data.topicLibrary.deleted){
      // Preserve the existing accurate binding, including its stable document ID.
    }else host.data.topicLibrary=identity;
    host.store.sessionFor(host.data.topicLibrary);
    const settings=host.daily.data.settings;
    if(!reinstall){settings.time='09:00';settings.timeZone='Asia/Shanghai';settings.githubFallback=true;settings.providerId=host.data.activeProviderId||'';}
    await host.saveSettings();
    if(stable(JSON.parse(await adapter.read(dir+'/data.json')))!==stable(host.data))fail('Updated configuration did not persist exactly');
    preserveEditors();await preserveTarget();
    if(!preservedDrafts())fail('An unsent draft changed while configuring the daily pipeline');
    if(host.data.topicLibrary.path!==targetPath||host.documents.resolve(host.data.topicLibrary.id)!==targetFile)fail('Topic library binding identity was not preserved');
    if(host.daily.scheduler.enabled()||app.loadLocalStorage(localKey)?.enabled!==false||busy(host)||host.daily.data.runs.length!==previousRuns)fail('Scheduling was enabled before final verification');
    const sidebar=document.querySelector('.dc-sidebar');
    if(views.length&&!sidebar?.querySelector('.dc-daily-start'))fail('The new daily button was not loaded');
    if(reinstall){
      if(stable(host.data.dailyTopics)!==stable(before.dailyTopics))fail('Daily records changed while restoring the sidebar');
      app.saveLocalStorage(localKey,oldLocal);
      if(stable(app.loadLocalStorage(localKey))!==stable(oldLocal)||host.daily.scheduler.enabled()!==!!oldLocal?.enabled)fail('The existing local schedule was not restored');
    }
    return{success:true,fromVersion:previous.manifest.version,version:plugin.manifest.version,schema:host.data.version,backup,backupVerified:true,localScheduleBackupVerified:true,runtimeVerified:true,enabled:true,configurationAndSessionsPreserved:true,dailyRecordsPreserved:reinstall,runCount:host.daily.data.runs.length,unsentDraftsPreserved:true,unsentCharacters:views.reduce((n,v)=>n+v.input.length,0),sidebarViews:views.length,editorTextAndSelectionPreserved:true,liveFileIdentityHandoff:true,topicLibrary:targetPath,topicLibraryBytesUnchanged:true,dailyButtonLoaded:!!sidebar?.querySelector('.dc-daily-start'),scheduleTime:settings.time,scheduleTimeZone:settings.timeZone,scheduleEnabled:host.daily.scheduler.enabled(),scheduleActivationDeferred:!reinstall,githubFallback:settings.githubFallback,modelRequests:0,articleWrites:0};
  }catch(error){
    if(!mutated){app.saveLocalStorage(localKey,oldLocal);throw error;}
    try{
      await app.plugins.disablePlugin(id);
      app.saveLocalStorage(localKey,{...(app.loadLocalStorage(localKey)||{}),enabled:false});
      for(const [name,value]of Object.entries(originals)){
        await adapter.write(dir+'/'+name,value);
        if(await adapter.read(dir+'/'+name)!==value)fail('Rollback file verification failed');
      }
      app.__draftCompanionFileHandoff=new Map(handoff);
      app.plugins.manifests[id]=previousManifest;await app.plugins.enablePlugin(id);
      await restoreViews(app.plugins.plugins[id]);preserveEditors();await preserveTarget();
      if(!app.plugins.enabledPlugins.has(id)||app.plugins.plugins[id]?.manifest.version!==previous.manifest.version||stable(app.plugins.plugins[id]?.controller.data)!==stable(before)||stable(JSON.parse(await adapter.read(dir+'/data.json')))!==stable(before))fail('Rollback runtime or data did not restore the original state');
      if(!preservedDrafts())fail('Rollback could not restore an unsent draft');
      app.saveLocalStorage(localKey,oldLocal);
      if(stable(app.loadLocalStorage(localKey))!==stable(oldLocal))fail('Rollback local schedule verification failed');
      return{success:false,rolledBack:true,backup,backupVerified:true,reloaded,reason:'Update checks failed; original runtime, data, local schedule and unsent drafts were restored.',check:error.message,topicLibraryBytesUnchanged:true,modelRequests:0,articleWrites:0};
    }catch(rollback){
      return{success:false,rolledBack:false,backup,reloaded,reason:'Rollback needs attention; the verified backup remains in the plugin directory.',check:error.message,rollbackCheck:rollback.message,modelRequests:0,articleWrites:0};
    }
  }
}`;

let result;
await mkdir(output, { recursive: true });
try {
  await evaluate(`(()=>{if(window.dc040Install&&!window.dc040Install.done)throw new Error('Another guarded installation is still running');window.dc040Install={token:${JSON.stringify(token)},files:{},checksums:${JSON.stringify(checksums)},manifest:${JSON.stringify(manifest)},done:true};return true;})()`);
  // Keep each UTF-8 command argument below macOS's per-argument limit. Payloads
  // stay in the selected application's memory until backup/verification finish.
  for (const name of runtimeNames) {
    await evaluate(`(()=>{const q=window.dc040Install;if(q.token!==${JSON.stringify(token)})throw new Error('Payload identity changed');q.files[${JSON.stringify(name)}]='';return true;})()`);
    for (let index = 0; index < files[name].length; index += 12_000) {
      await evaluate(`(()=>{const q=window.dc040Install;if(q.token!==${JSON.stringify(token)})throw new Error('Payload identity changed');q.files[${JSON.stringify(name)}]+=${JSON.stringify(files[name].slice(index, index + 12_000))};return true;})()`);
    }
  }
  await evaluate(`(()=>{const q=window.dc040Install;q.done=false;(${installation})().then(result=>q.result=result).catch(error=>q.result={success:false,rolledBack:false,reason:'Installation stopped before mutation or backup verification',check:error.message}).finally(()=>{q.done=true;delete q.files;});return true;})()`);
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const state = await evaluate(`(()=>{const q=window.dc040Install;if(q.token!==${JSON.stringify(token)})throw new Error('Installation result identity changed');return{done:q.done,result:q.done?q.result:undefined};})()`);
    if (state.done) { result = state.result; break; }
    await sleep(200);
  }
  assert(result, 'Installation is still running in Obsidian; do not retry or enable scheduling until its guarded result is inspected.');
} catch (error) {
  result = { success: false, outcomeUnknown: true, reason: error instanceof Error ? error.message : String(error), scheduleActivationDeferred: true };
}
await writeFile(resolve(output, result?.dailyRecordsPreserved ? 'local-ui-hotfix-install.json' : 'local-install-verification.json'), JSON.stringify({ at: new Date().toISOString(), officialCli: true, ...result }, null, 2) + '\n');
console.log(JSON.stringify(result));
if (!result.success) process.exitCode = 1;
