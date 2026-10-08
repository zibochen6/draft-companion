/** Real-source/model dry run. Secrets stay inside Obsidian SecretStorage.
 * This script never writes a vault note or changes a service/profile setting.
 * Requires the user's already-enabled official Obsidian CLI and 0.4.0 preview().
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const exec = promisify(execFile);
const binary = '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli';
const position = process.argv.indexOf('--vault');
assert(position >= 0 && process.argv[position + 1], 'A guarded --vault path is required.');
const vault = resolve(process.argv[position + 1]);
const normalized = value => value.replace(/^\/private\/tmp\//, '/tmp/');
assert(vault === '/Users/chenzibo/data/project/personal_database' || /^\/tmp\/draft-companion-qa-040[^/]*\/DraftCompanion040Test$/.test(normalized(vault)), 'Only the configured personal vault or the separate 0.4.0 synthetic vault can run this no-write validation.');
const vaultName = basename(vault);
const output = resolve('docs/qa-0.4.0/real-model-readable.json');
const guard = `if(app.vault.getName()!==${JSON.stringify(vaultName)}||app.vault.adapter.getBasePath().replace(/^\\/private\\/tmp\\//,'/tmp/')!==${JSON.stringify(normalized(vault))})throw new Error('Real-model dry run must use the explicitly configured vault');`;
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function evaluate(expression) {
  const code = `(()=>{${guard}const value=(${expression});return 'DC040_REAL_'+btoa(unescape(encodeURIComponent(JSON.stringify(value===undefined?null:value))))+'_END';})()`;
  let response;
  try {
    response = await exec(binary, [`vault=${vaultName}`, 'eval', `code=${code}`], { timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '', stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const timedOut = error.killed === true && error.signal === 'SIGKILL' && (error.code === null || error.code === undefined || error.code === 'ETIMEDOUT');
    const complete = /DC040_REAL_[A-Za-z0-9+/=]+_END/.test(stdout);
    // Recover a completed guarded response only when the official helper
    // hangs while exiting. Partial output, ordinary process failures,
    // buffer-limit failures and application errors must still fail.
    if (!timedOut || !complete || /Command line interface is not enabled|Vault not found|Error:/i.test(stdout + stderr)) throw error;
    response = { stdout, stderr };
  }
  const { stdout, stderr } = response;
  if (/Command line interface is not enabled|Vault not found|Error:/i.test(stdout + stderr)) throw new Error('Official Obsidian CLI reported an application error; the controlled result was not accepted.');
  const match = /DC040_REAL_([A-Za-z0-9+/=]+)_END/.exec(stdout);
  if (!match) throw new Error('Official Obsidian CLI did not return the guarded dry-run result. Enable it in Obsidian settings before running this script.');
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

let started = false;
try {
  const configuration = await evaluate(`(()=>{const h=app.plugins.plugins['draft-companion']?.controller;if(!h?.daily||typeof h.daily.preview!=='function')throw new Error('0.4.0 no-write preview is unavailable');if(h.running)throw new Error('Wait for the current chat or selection task');const p=h.data.providers.find(p=>p.id===h.daily.data.settings.providerId)||h.data.providers.find(p=>p.id===h.data.activeProviderId);if(!p?.model)throw new Error('Select a configured model first');window.dc040Real={h,startedAt:Date.now(),done:false,stages:[],provider:p.name,model:p.model,beforeData:JSON.stringify(h.data)};return{provider:p.name,model:p.model,version:app.plugins.plugins['draft-companion'].manifest.version};})()`);
  assert.equal(configuration.version, '0.4.0');
  await evaluate(`(()=>{const q=dc040Real;q.writes=0;q.targetWrites=0;q.targetPath=q.h.data.topicLibrary?.path;q.eventRefs=['modify','create','delete','rename'].map(event=>app.vault.on(event,(file,oldPath)=>{q.writes++;if(q.targetPath&&(file?.path===q.targetPath||oldPath===q.targetPath))q.targetWrites++;}));(async()=>{const promise=q.h.daily.preview();q.requestId=q.h.running?.id;const result=await promise;q.result={at:new Date().toISOString(),mode:'real public sources and configured model; no vault note read or write',provider:q.provider,model:q.model,durationMs:Date.now()-q.startedAt,sourceCount:result.items.length,sources:result.sources,summary:result.summary,noChanges:result.noChanges,cards:result.cards.map(card=>({title:result.items.find(item=>item.id===card.sourceId)?.title,source:result.items.find(item=>item.id===card.sourceId)?.source,primaryUrl:result.items.find(item=>item.id===card.sourceId)?.primaryUrl,sourceId:card.sourceId,selected:card.selected,description:card.description,reason:card.reason,potential:card.potential,angle:card.angle,primaryTitle:card.primaryTitle,alternativeTitles:card.alternativeTitles,opening:card.opening,outline:card.outline,gaps:card.gaps,evidence:card.evidence})),zeroTargetNoteWrite:q.targetWrites===0,zeroWholeVaultWriteEvents:q.writes===0,totalVaultWriteEvents:q.writes,targetWriteEvents:q.targetWrites,zeroPersistedDataChange:JSON.stringify(q.h.data)===q.beforeData,officialSecretStorage:true,secretExported:false};})().catch(error=>{q.error={message:error.message,category:error.kind,sources:error.sources};}).finally(()=>{q.eventRefs.forEach(ref=>app.vault.offref(ref));q.eventRefs=[];q.done=true;});return true;})()`);
  started = true;
  const end = Date.now() + 900_000;
  let previousStage;
  while (Date.now() < end) {
    const state = await evaluate(`({done:dc040Real.done,stage:dc040Real.h.running?.stage})`);
    if (state.stage && state.stage !== previousStage) {
      previousStage = state.stage;
      process.stdout.write(`Public-source dry run: ${state.stage}\n`);
      await evaluate(`(()=>{dc040Real.stages.push({stage:${JSON.stringify(state.stage)},at:new Date().toISOString()});return true;})()`);
    }
    if (state.done) break;
    await sleep(1_000);
  }
  const state = await evaluate('({done:dc040Real.done,error:dc040Real.error,result:dc040Real.result,stages:dc040Real.stages})');
  assert(state.done, 'Real-model dry run exceeded the bounded deadline.');
  const report = state.result ? { ...state.result, stages: state.stages, status: 'completed' } : { ...configuration, at: new Date().toISOString(), status: 'failed', ...state.error, stages: state.stages, officialSecretStorage: true, secretExported: false };
  await mkdir(resolve('docs/qa-0.4.0'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (state.error) throw new Error(`Real-model dry run failed: ${state.error.message}`);
  assert.equal(report.zeroTargetNoteWrite, true);
  assert.equal(report.zeroPersistedDataChange, true);
  process.stdout.write(JSON.stringify({ status: report.status, provider: report.provider, model: report.model, candidates: report.cards.length, selected: report.cards.filter(card => card.selected).length, zeroTargetNoteWrite: report.zeroTargetNoteWrite, report: output }) + '\n');
} finally {
  try {
    await evaluate(`(()=>{const q=window.dc040Real;if(q&&!q.done&&q.requestId&&q.h.running?.id===q.requestId)q.h.daily.stop();q?.eventRefs?.forEach(ref=>app.vault.offref(ref));delete window.dc040Real;return true;})()`);
  } catch { /* Preserve the original diagnostic; never print raw private app state. */ }
  if (!started) process.stdout.write('No source/model pipeline was started.\n');
}
