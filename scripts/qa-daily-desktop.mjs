/**
 * Official-CLI desktop acceptance. Never targets the user's knowledge vault.
 * Usage: node scripts/qa-daily-desktop.mjs --vault /tmp/draft-companion-qa-040-ABC/DraftCompanion040Test
 * The plugin must already be installed and enabled in that isolated vault.
 * Synthetic pipeline injection tests the real button, queue, runner, editor,
 * persistence, undo and readable Live Preview. It does not represent a real-source/model result.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const position = process.argv.indexOf('--vault');
assert(position >= 0 && process.argv[position + 1], 'A guarded --vault path is required.');
const vault = resolve(process.argv[position + 1]);
const normalized = value => value.replace(/^\/private\/tmp\//, '/tmp/');
assert(/^\/tmp\/draft-companion-qa-040[^/]*\/DraftCompanion040Test$/.test(normalized(vault)), 'Only the separate 0.4.0 synthetic vault is writable.');
const output = resolve('docs/qa-0.4.0');
const binary = '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli';
const checks = [], screenshots = [], screenshotDetails = [];
let debuggerReady = false, frameSequence = 0;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const guard = `if(app.vault.getName()!=='DraftCompanion040Test'||app.vault.adapter.getBasePath().replace(/^\\/private\\/tmp\\//,'/tmp/')!==${JSON.stringify(normalized(vault))})throw new Error('Isolated vault mismatch');`;

async function cli(command, ...args) {
  let result;
  try {
    result = await exec(binary, ['vault=DraftCompanion040Test', command, ...args], { timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 12 * 1024 * 1024 });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '', stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const timedOut = error.killed === true && error.signal === 'SIGKILL' && (error.code === null || error.code === undefined || error.code === 'ETIMEDOUT');
    let complete = command === 'eval' && /DC040_RESULT_[A-Za-z0-9+/=]+_END/.test(stdout);
    if (command === 'dev:cdp') {
      const from = stdout.indexOf('{'), to = stdout.lastIndexOf('}');
      try {
        const response = JSON.parse(stdout.slice(from, to + 1));
        complete = from >= 0 && to >= from && response !== null && typeof response === 'object' && !Array.isArray(response)
          && !/"(?:error|exceptionDetails)"\s*:/.test(JSON.stringify(response));
      } catch { complete = false; }
    }
    // Some official helper processes finish their response but hang on exit.
    // Recover only a complete controlled response from that timeout; ordinary
    // process, protocol, buffer-limit and application errors still propagate.
    if (!timedOut || !complete || /Command line interface is not enabled|Vault not found|Error:/i.test(stdout + stderr)) throw error;
    result = { stdout, stderr };
  }
  if (/Command line interface is not enabled|Vault not found|Error:/i.test(result.stdout + result.stderr)) throw new Error((result.stdout + result.stderr).slice(0, 500));
  return result.stdout;
}
async function evaluate(expression) {
  // Return an ASCII envelope so CLI formatting and Chinese strings are harmless.
  const encoded = await cli('eval', `code=(()=>{${guard}const value=(${expression});return 'DC040_RESULT_'+btoa(unescape(encodeURIComponent(JSON.stringify(value===undefined?null:value))))+'_END';})()`);
  const payload = /DC040_RESULT_([A-Za-z0-9+/=]+)_END/.exec(encoded)?.[1];
  assert(payload, 'Official CLI did not return the controlled QA result.');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}
async function wait(expression, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(150); }
  throw new Error(`Synthetic desktop state timed out: ${expression}`);
}
async function action(body) {
  await evaluate(`(()=>{dc040.done=false;dc040.error=undefined;(async()=>{${body}})().catch(error=>dc040.error=error.message).finally(()=>dc040.done=true);return true;})()`);
  await wait('dc040.done');
  const error = await evaluate('dc040.error'); assert(!error, error);
}
async function check(name, execute) {
  const detail = await execute(); checks.push({ name, passed: true, ...detail }); console.log(name);
}
async function clickStart() {
  await evaluate(`(()=>{const button=document.querySelector('.dc-daily-start');if(!button||button.disabled)throw new Error('Daily button unavailable');button.click();return true;})()`);
}
async function idle() { await wait('!dc040.h.running&&!dc040.h.daily.status()?.status?.match(/queued|collecting|screening|reading|preparing|committing/)'); }
const note = () => evaluate('dc040.libraryLeaf.view.editor.getValue()');
async function paneSnapshot() {
  return evaluate(`(()=>{const q=dc040,run=q.h.daily.status(),receipt=q.h.daily.data.receipts.find(item=>item.id===run?.receiptId),digest=text=>require('node:crypto').createHash('sha256').update(text,'utf8').digest('hex'),panes=app.workspace.getLeavesOfType('markdown').filter(leaf=>leaf.view.file===q.libraryFile&&leaf.view.getMode()==='source'),texts=panes.map(leaf=>leaf.view.editor.getValue());return {sourcePaneCount:panes.length,allBuffersExact:texts.length>=2&&texts.every(text=>text===texts[0]),allBuffersMatchReceipt:!!receipt&&texts.every(text=>digest(text)===receipt.afterHash),allPanesSameDocument:panes.every(leaf=>q.h.documents.recordFor(leaf.view.file).id===q.h.data.topicLibrary.id),receiptState:receipt?.state,canUndo:!!receipt&&q.h.canUndoTopicBatch(receipt.id),running:!!q.h.running,editorTransactions:q.transactionCounts.reduce((count,item)=>count+item.calls,0),immediateTransactionBufferAgreement:q.transactionSnapshots.map(item=>item.equal),transientBufferDivergenceObserved:q.transactionSnapshots.some(item=>!item.equal),unrelatedBufferPreserved:q.unrelatedLeaf.view.editor.getValue()===q.unrelatedBefore,originalAuthoredContentPreserved:texts.every(text=>text.includes('- [x] **原有已选项目**')&&text.includes('作者后记：保持原文和 emoji 😀。'))};})()`);
}
async function enableDebugger() {
  if (!debuggerReady) { await cli('dev:debug', 'on'); debuggerReady = true; }
}
async function painted() {
  await enableDebugger();
  await cli('dev:cdp', 'method=Page.bringToFront', 'params={}');
  const token = `dc040-frame-${++frameSequence}-${Date.now()}`;
  await evaluate(`(()=>{window.dc040Painted=undefined;requestAnimationFrame(()=>requestAnimationFrame(()=>window.dc040Painted=${JSON.stringify(token)}));return true;})()`);
  await wait(`window.dc040Painted===${JSON.stringify(token)}`);
}
async function revealSidebar() {
  await action(`const leaf=app.workspace.getLeavesOfType('draft-companion-view')[0];if(!leaf)throw new Error('Synthetic sidebar leaf unavailable');await leaf.loadIfDeferred();await app.workspace.revealLeaf(leaf);dc040.h.changed();`);
  await wait(`(()=>{const root=document.querySelector('.dc-sidebar'),button=root?.querySelector('.dc-daily-start');return !!root&&!!button&&root.getBoundingClientRect().width>100&&root.getBoundingClientRect().height>100&&button.getBoundingClientRect().width>0;})()`);
  await painted();
}
async function appearance() {
  return evaluate(`(()=>{const root=document.querySelector('.dc-sidebar');if(!root)throw new Error('Sidebar not rendered');const style=getComputedStyle(root),body=getComputedStyle(document.body),r=root.getBoundingClientRect();return {themeDark:document.body.classList.contains('theme-dark'),themeLight:document.body.classList.contains('theme-light'),bodyThemeClasses:[...document.body.classList].filter(value=>value==='theme-dark'||value==='theme-light'),rootBackground:style.backgroundColor,rootColor:style.color,bodyBackground:body.backgroundColor,viewportWidth:innerWidth,viewportHeight:innerHeight,sidebarWidth:r.width,sidebarHeight:r.height};})()`);
}
async function screenshot(name, theme) {
  await enableDebugger(); await revealSidebar(); await painted();
  const state = await appearance();
  if (theme) assert(theme === 'dark' ? state.themeDark && !state.themeLight : state.themeLight && !state.themeDark, `Requested theme was not active: ${JSON.stringify(state)}`);
  const response = await cli('dev:cdp', 'method=Page.captureScreenshot', 'params={"format":"png","fromSurface":true,"captureBeyondViewport":false}');
  // Official CLI can prefix the JSON response with a status line. This extracts
  // only the controlled capture payload, never an independently opened socket.
  const base64 = /"data"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(response)?.[1];
  assert(base64, 'Page.captureScreenshot did not return PNG data.');
  const png = Buffer.from(base64, 'base64');
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Official capture payload is not a PNG.');
  const path = resolve(output, `${name}.png`); await writeFile(path, png); screenshots.push(path);
  const detail = { name, path, sha256: createHash('sha256').update(png).digest('hex'), pngWidth: png.readUInt32BE(16), pngHeight: png.readUInt32BE(20), captureMethod: 'official-cli:Page.captureScreenshot', fromSurface: true, doubleAnimationFrame: true, ...state };
  screenshotDetails.push(detail); return detail;
}

await mkdir(output, { recursive: true });
try {
  await evaluate(`(()=>{const plugin=app.plugins.plugins['draft-companion'],h=plugin?.controller;if(!h?.daily)throw new Error('0.4.0 runner is not installed');if(h.running||h.editing?.size||h.daily.pending||h.daily.active)throw new Error('Synthetic vault is busy');window.dc040={h,phase:'prior',calls:0,stages:[],done:false,themeDark:document.body.classList.contains('theme-dark')};return true;})()`);
  await action(`
    const q=dc040,h=q.h;
    h.daily.scheduler?.setEnabled(false);q.oldDependencies=h.daily.dependencies;
    q.oldProviders=structuredClone(h.data.providers);q.oldActiveProviderId=h.data.activeProviderId;q.oldDailySettings=structuredClone(h.daily.data.settings);
    const source='---\\ntitle: 合成选题测试\\n---\\n# 合成选题库\\n\\n- [x] **原有已选项目** — 保留作者内容。\\n\\n作者后记：保持原文和 emoji 😀。\\n'.replace(/\\\\n/g,'\\n');
    const file=app.vault.getAbstractFileByPath('合成选题库040.md')||await app.vault.create('合成选题库040.md',source);
    const other=app.vault.getAbstractFileByPath('合成文章040.md')||await app.vault.create('合成文章040.md','# 合成文章\\n\\n此文不属于选题任务。');
    const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===file)||app.workspace.getLeaf('tab');
    await leaf.openFile(file);await leaf.loadIfDeferred();await leaf.view.setState({...leaf.view.getState(),mode:'source'},{history:false});leaf.view.editor.setValue(source);
    app.workspace.setActiveLeaf(leaf,{focus:true});h.documents.focus(leaf);
    q.libraryLeaf=leaf;q.libraryFile=file;q.original=source;q.otherFile=other;
    q.rawSummary='Synthetic repository summary must not appear in the note.';
    q.readableDescription='公开说明展示将重复资料整理成可复用流程的工具，适合知识管理实践。';
    h.data.providers=[{id:'qa-daily',name:'隔离合成模型',baseUrl:'http://127.0.0.1:1/v1',secretRef:'',model:'synthetic-no-network',stream:false,timeoutMs:1000}];h.data.activeProviderId='qa-daily';
    h.daily.data.settings.providerId='qa-daily';h.daily.data.settings.roleId='';
    h.data.topicLibrary=h.documents.recordFor(file);h.daily.data.runs=[];h.daily.data.receipts=[];h.daily.data.seen={};
    h.daily.dependencies={pipeline:async options=>{
      q.calls++;q.stages=[];
      for(const stage of ['采集中','筛选中','读取材料','筛选中']){options.assertActive();q.stages.push(stage);options.onStage(stage);await new Promise(r=>setTimeout(r,20));}
      if(q.phase==='hold'){q.holdStarted=true;await new Promise((resolve,reject)=>{q.release=resolve;options.signal.addEventListener('abort',()=>reject(new Error('合成任务取消')),{once:true});});}
      options.assertActive();
      const ids=q.phase==='prior'?['prior']:q.phase==='refresh'?['tool','news','newcomer']:q.phase==='afterqueue'?['queue']:['tool','news'];
      const items=ids.map(id=>({id,canonicalId:'https://example.invalid/040/'+id,kind:'news',title:'合成项目 '+id,summary:q.rawSummary,url:'https://example.invalid/040/'+id,source:'本地合成来源',fingerprint:'fixed-fact-'+id,materials:[{url:'https://example.invalid/040/'+id,text:'公开说明展示一个可复用的工作流。',status:'verified'}]}));
      const cards=items.filter(item=>!options.existing.has(item.canonicalId)).map((item,index)=>({sourceId:item.id,selected:index===0,description:q.readableDescription,reason:'具体问题和演示价值明确。',gaps:['需要作者实际试用。'],potential:index===0?'high':'needs-materials',...(index===0?{angle:'把一个重复工作变成可复用流程',primaryTitle:'一个真实工作流如何少做重复操作',alternativeTitles:['从重复工作开始找 AI 工具','把一个步骤写清楚','这个流程适合谁','使用之前先看限制'],opening:'每天都会遇到一个需要重复处理的小步骤。',outline:['读者遇到的问题','合成材料中的工作流','演示准备与限制'],evidence:[{sourceId:item.id,quote:'公开说明展示一个可复用的工作流。'}]}:{})}));
      options.onStage('准备写入');options.assertActive();return{items,cards,sources:[{name:'本地合成来源',status:'success',message:'模拟成功，不代表真实网站或模型。',at:Date.now()}],observations:items.map(item=>({canonicalId:item.canonicalId,fingerprint:item.fingerprint})),noChanges:!cards.length,summary:'合成流程已完成'};
    }};
    await h.saveSettings();app.commands.executeCommandById('draft-companion:open-sidebar');h.changed();
  `);
  await wait('document.querySelector(".dc-daily-start")');
  await action(`const q=dc040,second=app.workspace.getLeaf('tab');q.secondLibraryLeaf=second;await second.openFile(q.libraryFile);await second.loadIfDeferred();await second.view.setState({...await second.view.getState(),mode:'source'},{history:false});const unrelated=app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file===q.otherFile)||app.workspace.getLeaf('tab');q.unrelatedLeaf=unrelated;q.createdUnrelatedLeaf=unrelated.view.file!==q.otherFile;await unrelated.openFile(q.otherFile);await unrelated.loadIfDeferred();await unrelated.view.setState({...await unrelated.view.getState(),mode:'source'},{history:false});q.unrelatedBefore=unrelated.view.editor.getValue();app.workspace.setActiveLeaf(q.libraryLeaf,{focus:true});q.h.documents.focus(q.libraryLeaf);q.h.changed();`);
  await wait(`(()=>{const q=dc040,panes=app.workspace.getLeavesOfType('markdown').filter(leaf=>leaf.view.file===q.libraryFile&&leaf.view.getMode()==='source');return panes.length>=2&&panes.every(leaf=>leaf.view.editor.getValue()===q.original);})()`);
  await evaluate(`(()=>{const q=dc040;q.transactionCounts=[];q.transactionSnapshots=[];q.savedTransactions=[];for(const [index,leaf] of app.workspace.getLeavesOfType('markdown').filter(leaf=>leaf.view.file===q.libraryFile&&leaf.view.getMode()==='source').entries()){const editor=leaf.view.editor;if(q.savedTransactions.some(saved=>saved.editor===editor))continue;const native=editor.transaction,counter={pane:index,calls:0};q.transactionCounts.push(counter);q.savedTransactions.push({editor,native});editor.transaction=function(...args){counter.calls++;const result=Reflect.apply(native,this,args),texts=app.workspace.getLeavesOfType('markdown').filter(item=>item.view.file===q.libraryFile&&item.view.getMode()==='source').map(item=>item.view.editor.getValue());q.transactionSnapshots.push({pane:index,equal:texts.every(text=>text===texts[0])});return result;};}return true;})()`);
  await check('历史日期保留，实际按钮空输入启动并将最新日期置顶', async () => {
    const yesterday = new Date(Date.now() + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10);
    await action(`await dc040.h.daily.start('manual',${JSON.stringify(yesterday)});`);
    await idle();
    const priorPanes = await paneSnapshot();
    assert(priorPanes.allBuffersExact && priorPanes.allBuffersMatchReceipt && priorPanes.receiptState === 'applied' && priorPanes.canUndo && priorPanes.editorTransactions === 1, JSON.stringify(priorPanes));
    await evaluate(`(()=>{for(const counter of dc040.transactionCounts)counter.calls=0;dc040.transactionSnapshots=[];return true;})()`);
    await evaluate(`(()=>{dc040.phase='base';const input=document.querySelector('.dc-input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await clickStart(); await idle();
    const text = await note(), today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    assert(text.indexOf(`## ${today}`) < text.indexOf(`## ${yesterday}`));
    assert(text.includes('- [x] **原有已选项目**')); assert(text.includes('作者后记：保持原文和 emoji 😀。'));
    assert.equal((text.match(/\*\*合成项目 tool\*\*/g) || []).length, 1);
    assert.deepEqual(await evaluate('dc040.stages'), ['采集中', '筛选中', '读取材料', '筛选中']);
    const panes = await paneSnapshot();
    assert(panes.sourcePaneCount >= 2 && panes.allBuffersExact && panes.allBuffersMatchReceipt && panes.allPanesSameDocument, JSON.stringify(panes));
    assert(panes.receiptState === 'applied' && panes.canUndo && !panes.running && panes.editorTransactions === 1 && panes.unrelatedBufferPreserved && panes.originalAuthoredContentPreserved, JSON.stringify(panes));
    await writeFile(resolve(output, 'daily-multiple-panes.json'), JSON.stringify({version:'0.4.0',at:new Date().toISOString(),vault,syntheticPipeline:true,officialCli:true,publicWorkspaceEditorApis:true,priorDate:priorPanes,currentDate:panes},null,2)+'\n');
    await screenshot('daily-button-completed'); return { zeroChatInput: true, realRunnerAndEditor: true, syntheticPipeline: true, twoSourceTabsExact: true, oneEditorTransaction: true, unrelatedBufferPreserved: true, receiptAppliedAndUndoAvailable: true, transientBufferDivergenceObserved: panes.transientBufferDivergenceObserved };
  });
  await check('真实编辑器中文卡片、折叠预设和仅显示层隐藏标记', async () => {
    await action(`const q=dc040,leaf=q.libraryLeaf;await leaf.loadIfDeferred();q.readabilityBefore=leaf.view.editor.getValue();await leaf.view.setState({...await leaf.view.getState(),mode:'source',source:false},{history:false});const e=leaf.view.editor,text=e.getValue(),heading='### 一个真实工作流如何少做重复操作',at=text.indexOf(heading);if(at<0)throw new Error('Synthetic human-readable heading unavailable');const pos=e.offsetToPos(at+4);e.setCursor(pos);e.scrollIntoView({from:pos,to:pos},true);app.workspace.setActiveLeaf(leaf,{focus:true});q.h.documents.focus(leaf);q.h.changed();`);
    await painted();
    await wait(`(()=>{const root=dc040.libraryLeaf.view.contentEl;return !!root.querySelector('.cm-content')&&!!root.querySelector('.callout[data-callout="example"]');})()`);
    const measured = await evaluate(`(()=>{const q=dc040,e=q.libraryLeaf.view.editor,text=e.getValue(),root=q.libraryLeaf.view.contentEl,content=root.querySelector('.cm-content');if(!content)throw new Error('Synthetic CM content unavailable');const displayed=content.innerText??content.textContent??'',callouts=[...root.querySelectorAll('.callout[data-callout="example"]')].filter(node=>node.querySelector('.callout-title')?.textContent.includes('写作预设')),visibleCallouts=callouts.filter(node=>node.getBoundingClientRect().height>0),collapsed=visibleCallouts.filter(node=>node.classList.contains('is-collapsed')&&(getComputedStyle(node.querySelector('.callout-content')).display==='none'||node.querySelector('.callout-content').getBoundingClientRect().height===0)),cursor=e.getCursor(),line=e.getLine(cursor.line),summaries=text.split(/\\r?\\n/).filter(line=>line.startsWith('> 推荐：'));return {mode:q.libraryLeaf.view.getMode(),rawMarkerLines:(text.match(/^<!-- draft-companion:(?:daily|day|topic):[^\\r\\n]+ -->$/gm)||[]).length,displayedMarkerLines:(displayed.match(/draft-companion:(?:daily|day|topic):/g)||[]).length,rawTextUnchanged:text===q.readabilityBefore,sourceContainsEnglishSummary:text.includes(q.rawSummary),sourceContainsChineseDescription:text.includes(q.readableDescription),headingOutsideCheckbox:/^### 一个真实工作流如何少做重复操作$/m.test(text)&&/^-[ ]\\[x\\] \\*\\*合成项目 tool\\*\\* · \\[来源\\]/m.test(text),shortMetadata:summaries.length>=2&&summaries.every(line=>line.length<=50)&&!text.includes('首次采集：')&&!text.includes('> 来源：'),presetSourceFolded:text.includes('> [!example]- 写作预设'),renderedPresetCallouts:callouts.length,visiblePresetCallouts:visibleCallouts.length,collapsedVisiblePresetCallouts:collapsed.length,cursorOnHumanHeading:line.startsWith('### 一个真实工作流'),cursorOnMarker:line.includes('draft-companion:'),rawNoteLength:text.length,description:q.readableDescription};})()`);
    assert.equal(measured.mode, 'source');
    assert(measured.rawMarkerLines >= 10 && measured.displayedMarkerLines === 0 && measured.rawTextUnchanged, JSON.stringify(measured));
    assert(measured.headingOutsideCheckbox && measured.shortMetadata && measured.sourceContainsChineseDescription && !measured.sourceContainsEnglishSummary, JSON.stringify(measured));
    assert(measured.presetSourceFolded && measured.visiblePresetCallouts > 0 && measured.collapsedVisiblePresetCallouts === measured.visiblePresetCallouts, JSON.stringify(measured));
    assert(measured.cursorOnHumanHeading && !measured.cursorOnMarker, JSON.stringify(measured));
    const headline = await evaluate(`(()=>{const content=dc040.libraryLeaf.view.contentEl.querySelector('.cm-content'),node=[...content.querySelectorAll('.cm-line,h3')].find(node=>node.textContent.includes('一个真实工作流如何少做重复操作')&&node.getBoundingClientRect().height>0);if(!node)return {visible:false,withoutStrike:false};let parent=node;while(parent&&content.contains(parent)){if(getComputedStyle(parent).textDecorationLine.includes('line-through'))return {visible:true,withoutStrike:false};parent=parent.parentElement;}return {visible:true,withoutStrike:true};})()`);
    assert(headline.visible && headline.withoutStrike, JSON.stringify(headline));
    const capture = await screenshot('daily-readable-editor');
    assert.equal(await evaluate('dc040.libraryLeaf.view.editor.getValue()===dc040.readabilityBefore'), true, 'Readability capture changed the source note.');
    const report = { version: '0.4.0', at: new Date().toISOString(), vault, officialCli: true, syntheticPipeline: true, realSourceVerification: false, realModelVerification: false, displayOnlyMarkerHiding: true, ...measured, headlineVisibleWithoutStrike: headline.visible && headline.withoutStrike, screenshot: capture.path };
    await writeFile(resolve(output, 'daily-readability.json'), JSON.stringify(report, null, 2) + '\n');
    return { headingOutsideCheckbox: true, headlineVisibleWithoutStrike: true, chineseDescription: true, shortMetadata: true, collapsedPresets: true, markerSourcePreserved: true, markerDisplayHidden: true, sourceUnchangedDuringCapture: true, screenshot: capture.path };
  });
  await check('同日去重、增量追加和未发送草稿保持', async () => {
    await evaluate(`(()=>{const input=document.querySelector('.dc-input');input.value='这段尚未发送的中文草稿必须保留。';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await clickStart(); await idle(); assert.equal(await evaluate('dc040.h.daily.status().status'), 'no-new');
    assert.equal((await note()).match(/\*\*合成项目 tool\*\*/g).length, 1);
    await evaluate(`(()=>{dc040.phase='refresh';return true;})()`); await clickStart(); await idle();
    const text = await note(); assert.equal((text.match(/\*\*合成项目 tool\*\*/g) || []).length, 1); assert(text.includes('**合成项目 newcomer**'));
    assert.equal(await evaluate('document.querySelector(".dc-input").value'), '这段尚未发送的中文草稿必须保留。');
    return { duplicateEntries: 0, incrementalEntry: true, draftPreserved: true };
  });
  await check('真实批次撤回只删除本次新增并保留后记', async () => {
    await action(`const q=dc040,e=q.libraryLeaf.view.editor,end=e.getValue().length;e.replaceRange('作者新增独立后记。',e.offsetToPos(end));await new Promise(r=>setTimeout(r,100));const receipt=q.h.daily.status().receiptId;if(!q.h.canUndoTopicBatch(receipt))throw new Error('Synthetic batch not safely undoable');await q.h.undoTopicBatch(receipt);`);
    const text = await note(); assert(!text.includes('**合成项目 newcomer**')); assert(text.includes('**合成项目 tool**')); assert(text.includes('作者新增独立后记。'));
    return { unrelatedEditPreserved: true, localUndo: true };
  });
  await check('聊天忙时排队，切换文章不会改变固定写入目标', async () => {
    await evaluate(`(()=>{const q=dc040;q.phase='afterqueue';q.h.running={id:'synthetic-chat',origin:'chat',documentId:q.h.data.topicLibrary.id,path:q.libraryFile.path,sessionId:'synthetic',roleName:'合成聊天',mode:'discuss',text:'',stop:()=>{}};q.h.changed();return true;})()`);
    await clickStart(); await wait('dc040.h.daily.status().status==="queued"');
    await action(`const q=dc040,leaf=q.unrelatedLeaf;await leaf.openFile(q.otherFile);await leaf.loadIfDeferred();await leaf.view.setState({...leaf.view.getState(),mode:'source'},{history:false});q.otherLeaf=leaf;q.otherBefore=leaf.view.editor.getValue();app.workspace.setActiveLeaf(leaf,{focus:true});q.h.documents.focus(leaf);q.h.running=undefined;await q.h.daily.pump();`);
    await idle(); assert((await note()).includes('**合成项目 queue**')); assert.equal(await evaluate('dc040.otherLeaf.view.editor.getValue()'), await evaluate('dc040.otherBefore'));
    return { queued: true, fixedTargetAfterSwitch: true };
  });
  await check('停止使等待中的结果失效，不提交迟到内容', async () => {
    const before = await note();
    await evaluate(`(()=>{dc040.phase='hold';dc040.holdStarted=false;return true;})()`); await clickStart(); await wait('dc040.holdStarted');
    assert.equal(await evaluate('document.querySelector(".dc-daily-start").textContent.trim()'), '停止');
    await clickStart(); await idle(); assert.equal(await evaluate('dc040.h.daily.status().status'), 'stopped'); assert.equal(await note(), before);
    return { lateWriteBlocked: true };
  });
  await check('340/400/460px、明暗主题和长输入布局', async () => {
    const layouts = [];
    // The normal-content layout is intentionally different from the compact
    // empty state. Exercise a real rendered history before measuring its share.
    await action(`const q=dc040,session=q.h.currentSession();if(!session)throw new Error('Synthetic article session unavailable');q.layoutSessionId=session.id;session.messages=Array.from({length:20},(_,index)=>({id:'synthetic-layout-'+index,role:index%2?'assistant':'user',content:index%2?'### 合成工作流建议\\n\\n这是用于长历史布局验收的中文材料，不代表实际模型回答。\\n\\n- 保留来源和证据。\\n- 清楚说明操作限制。\\n- 在正文中给出可复用步骤。':'请根据这个公开材料准备一个可复用的工作流演示。',at:Date.now()+index,status:'completed',presentation:'text'}));for(const leaf of app.workspace.getLeavesOfType('draft-companion-view'))leaf.view.currentTab.set(session.id,'chat');q.h.changed();`);
    await wait('document.querySelectorAll(".dc-message").length>=20');
    await enableDebugger(); await revealSidebar();
    const themedCaptures = new Map(), heights = process.argv.includes('--low-height') ? [800, 600] : [800];
    for (const height of heights) for (const width of [340, 400, 460]) for (const theme of ['light', 'dark']) {
      await cli('dev:cdp', 'method=Emulation.setDeviceMetricsOverride', `params=${JSON.stringify({ width: 1280, height, deviceScaleFactor: 1, mobile: false })}`);
      await evaluate(`(()=>{document.body.classList.toggle('theme-dark',${theme === 'dark'});document.body.classList.toggle('theme-light',${theme === 'light'});const root=document.querySelector('.dc-sidebar'),dock=root.closest('.workspace-split.mod-right-split');if(!dock)throw new Error('Synthetic sidebar is not in the right dock');dc040.dock=dock;if(!dc040.dockCaptured){dc040.oldDockStyle=dock.getAttribute('style');dc040.dockCaptured=true;}dock.style.width='${width}px';dock.style.flexBasis='${width}px';dock.style.minWidth='${width}px';const input=root.querySelector('.dc-input');input.value='合成中文长输入不能遮挡操作按钮。😀\\n'.repeat(200);input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      await painted();
      const state = await evaluate(`(()=>{const root=document.querySelector('.dc-sidebar'),input=root.querySelector('.dc-input'),reader=root.querySelector('.dc-reader'),button=root.querySelector('.dc-daily-start'),dock=root.closest('.workspace-split.mod-right-split'),r=root.getBoundingClientRect(),b=button.getBoundingClientRect(),controls=[...root.querySelectorAll('.dc-composer-controls button')].filter(node=>!node.hidden&&node.getClientRects().length&&getComputedStyle(node).display!=='none');return{width:r.width,height:r.height,dockWidth:dock.getBoundingClientRect().width,inputHeight:input.getBoundingClientRect().height,inputScrollable:input.scrollHeight>input.clientHeight,readerHeight:reader.getBoundingClientRect().height,overflow:root.scrollWidth>root.clientWidth+1,buttonInside:b.width>0&&b.left>=r.left-1&&b.right<=r.right+1&&b.top>=r.top&&b.bottom<=r.bottom,composerButtonsInside:controls.length>=3&&controls.every(node=>{const c=node.getBoundingClientRect();return c.width>0&&c.left>=r.left-1&&c.right<=r.right+1&&c.top>=r.top&&c.bottom<=r.bottom;})};})()`);
      const colors = await appearance();
      assert(state.buttonInside && state.composerButtonsInside && !state.overflow && state.inputScrollable && state.inputHeight <= 140, JSON.stringify({ ...state, ...colors }));
      assert(Math.abs(state.dockWidth - width) <= 2 && colors.viewportWidth === 1280 && colors.viewportHeight === height, JSON.stringify({ ...state, ...colors }));
      assert(theme === 'dark' ? colors.themeDark && !colors.themeLight : colors.themeLight && !colors.themeDark, JSON.stringify(colors));
      if (height === 800) assert(state.readerHeight >= state.height / 2, JSON.stringify(state));
      layouts.push({ requestedDockWidth: width, viewportWidth: 1280, viewportHeight: height, theme, readerHalfHeightRequired: height === 800, syntheticHistoryMessages: 20, ...state, ...colors });
      if (width === 400) themedCaptures.set(`${height}:${theme}`, await screenshot(height === 800 ? `daily-layout-${theme}` : `daily-layout-${theme}-low-height`, theme));
    }
    for (const height of heights) {
      const light = themedCaptures.get(`${height}:light`), dark = themedCaptures.get(`${height}:dark`);
      assert(light && dark && light.sha256 !== dark.sha256, `Light and dark ${height}px captures are the same frame.`);
      assert(light.rootBackground !== dark.rootBackground || light.bodyBackground !== dark.bodyBackground, `Theme backgrounds did not change at ${height}px: ${JSON.stringify({ light, dark })}`);
    }
    await writeFile(resolve(output, 'daily-layouts.json'), JSON.stringify(layouts, null, 2) + '\n'); return { cases: layouts.length };
  });
  await writeFile(resolve(output, 'daily-desktop-verification.json'), JSON.stringify({ version: '0.4.0', at: new Date().toISOString(), vault, syntheticPipeline: true, realSourceVerification: false, realModelVerification: false, officialCli: true, checks, screenshots, screenshotDetails }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, screenshots, syntheticPipeline: true }));
} catch (error) {
  await writeFile(resolve(output, 'daily-desktop-verification.json'), JSON.stringify({ version: '0.4.0', at: new Date().toISOString(), vault, syntheticPipeline: true, officialCli: true, failed: true, error: error instanceof Error ? error.message : String(error), checks, screenshots, screenshotDetails }, null, 2) + '\n');
  throw error;
} finally {
  try { await action(`const q=dc040;q.h.daily.stop();for(const saved of q.savedTransactions||[])saved.editor.transaction=saved.native;q.h.daily.dependencies=q.oldDependencies||{};if(q.oldProviders){q.h.data.providers=q.oldProviders;q.h.data.activeProviderId=q.oldActiveProviderId;q.h.daily.data.settings=q.oldDailySettings;}if(q.dock){q.oldDockStyle===null?q.dock.removeAttribute('style'):q.dock.setAttribute('style',q.oldDockStyle);}q.secondLibraryLeaf?.detach();if(q.createdUnrelatedLeaf)q.unrelatedLeaf?.detach();document.body.classList.toggle('theme-dark',q.themeDark);document.body.classList.toggle('theme-light',!q.themeDark);await q.h.saveSettings();`); } catch { /* Preserve original failure. */ }
  try { await cli('dev:cdp', 'method=Emulation.clearDeviceMetricsOverride', 'params={}'); await cli('dev:debug', 'off'); } catch { /* No debugger may have been attached. */ }
}
