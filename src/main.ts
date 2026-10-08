import { Plugin, Modal, Notice } from 'obsidian';
import { Store } from './store';
import { Documents } from './documents';
import { Controller } from './controller';
import { DraftCompanionView, VIEW_TYPE } from './sidebar';
import { DraftCompanionSettings } from './settings';
import { DraftReviewView, REVIEW_VIEW_TYPE } from './review-view';
import { ReviewEditorBridge } from './editor-review';
import { DailyTopicScheduler } from './daily-scheduler';
import { dailyEditorExtension } from './daily-editor';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class DraftCompanionPlugin extends Plugin {
  controller!: Controller;
  async onload(): Promise<void> {
    try {
      const raw = await this.loadData();
      const migrated = await Store.migrate(raw, async () => {
        const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        const source = await this.app.vault.adapter.read(`${dir}/data.json`);
        if(JSON.stringify(JSON.parse(source))!==JSON.stringify(raw))throw new Error('备份前配置已被其他窗口修改，请重新加载插件后迁移。');
        const backup = `${dir}/data-schema${(raw as {version?:number})?.version ?? 'unknown'}-${Date.now()}.backup.json`;
        await this.app.vault.adapter.write(backup,source);
        if (await this.app.vault.adapter.read(backup) !== source) throw new Error('旧版数据备份校验失败，迁移已取消。');
      });
      const store = new Store(migrated, data => this.saveData(data));
      if(store.data.topicLibrary)store.sessionFor(store.data.topicLibrary);
      const handoffApp=this.app as typeof this.app & {__draftCompanionFileHandoff?:Map<string,import('obsidian').TFile>};
      const documents = new Documents(this.app, store.data.sessions,handoffApp.__draftCompanionFileHandoff);
      delete handoffApp.__draftCompanionFileHandoff;
      this.controller = new Controller(this.app, store, documents, () => {
        const modal = new Modal(this.app);
        modal.titleEl.setText('稿伴设置');
        const settings = new DraftCompanionSettings(this, this.controller);
        settings.containerEl = modal.contentEl;
        modal.onOpen = () => settings.display();
        modal.onClose = () => { settings.dispose(); modal.contentEl.empty(); };
        modal.open();
      });
      this.registerView(VIEW_TYPE, leaf => new DraftCompanionView(leaf, this.controller));
      const scheduler = new DailyTopicScheduler({
        load: key => this.app.loadLocalStorage(key), save: (key, value) => this.app.saveLocalStorage(key, value),
        settings: () => this.controller.daily.data.settings,
        enqueue: date => this.controller.daily.start('scheduled', date), changed: () => this.controller.changed(),
        error: error => new Notice(`每日选题未启动：${errorMessage(error)}。可在设置中检查并手动重试。`, 8000),
      });
      this.controller.daily.scheduler = scheduler;
      this.registerInterval(window.setInterval(() => { scheduler.renew(); void scheduler.tick(); }, 30_000));
      this.registerView(REVIEW_VIEW_TYPE, leaf => new DraftReviewView(leaf, this.controller));
      this.controller.openReviewView = async (documentId,suggestionId) => {
        let leaf=this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
        if(!leaf) leaf=this.app.workspace.getLeaf('tab');
        await leaf.setViewState({type:REVIEW_VIEW_TYPE,state:{documentId,suggestionId},active:true});
        await this.app.workspace.revealLeaf(leaf);this.controller.bindReview(documentId);
      };
      const bridge = new ReviewEditorBridge(documents,id=>store.data.sessions[id]?.review,
        ()=>this.controller.changed(),(id,ids)=>{
          const choose=(suggestionId:string)=>{this.controller.bindReview(id);this.controller.selectSuggestion(id,suggestionId);void this.openSidebar();};
          if(ids.length===1)choose(ids[0]!);
          else {
            const modal=new Modal(this.app);modal.titleEl.setText('此处有多条批注');
            for(const suggestionId of ids){
              const s=store.data.sessions[id]?.review?.suggestions.find(s=>s.id===suggestionId);if(!s)continue;
              modal.contentEl.createEl('button',{text:`${s.number} · ${s.title}`}).addEventListener('click',()=>{modal.close();choose(suggestionId);});
            }
            modal.open();
          }
        });
      this.registerEditorExtension(bridge.extension);
      this.registerEditorExtension(dailyEditorExtension);
      this.register(this.controller.subscribe(()=>bridge.refresh()));
      this.register(()=>bridge.destroy());
      this.addSettingTab(new DraftCompanionSettings(this, this.controller));
      this.addRibbonIcon('pencil-line', '打开稿伴', () => { void this.openSidebar(); });
      this.addCommand({ id: 'open-sidebar', name: '打开创作侧栏', callback: () => { void this.openSidebar(); } });
      this.addCommand({ id: 'daily-topics-now', name: '立即采集并生成选题', callback: () => { void this.controller.startDailyTopics().catch(error => new Notice(errorMessage(error))); } });
      this.addCommand({ id: 'undo-last-edit', name: '撤回当前文稿最近 AI 修改', callback: () => { void this.controller.undo().catch(error => new Notice(errorMessage(error))); } });
      this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
        if(leaf?.view instanceof DraftReviewView && leaf.view.documentId)this.controller.bindReview(leaf.view.documentId);
        else {documents.focus(leaf);this.controller.changed();const target=documents.current();if(target)void this.controller.validateDocumentActions(target.id).catch(()=>undefined);}
      }));
      this.registerEvent(this.app.workspace.on('layout-change', () => this.controller.changed()));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        documents.renamed(file, oldPath);
        this.controller.daily.renamed(oldPath,file.path);
        const binding=store.data.topicLibrary;if(binding && (binding.path===oldPath || binding.path.startsWith(oldPath+'/')))binding.path=file.path+binding.path.slice(oldPath.length);
        for (const item of [...this.controller.daily.data.runs, ...this.controller.daily.data.receipts])
          if (item.path && (item.path===oldPath || item.path.startsWith(oldPath+'/'))) item.path=file.path+item.path.slice(oldPath.length);
        this.controller.changed(); void store.save().catch(e => new Notice(String(e)));
      }));
      this.registerEvent(this.app.vault.on('delete', file => {
        documents.deleted(file);
        const binding=store.data.topicLibrary;if(binding && (binding.path===file.path || binding.path.startsWith(file.path+'/')))binding.deleted=true;
        for (const receipt of this.controller.daily.data.receipts) if(receipt.path===file.path || receipt.path.startsWith(file.path+'/')) {
          receipt.state='needs-check';receipt.invalidReason='选题库已删除，不会关联同路径的新文件。';
        }
        const running = this.controller.running;
        if (running && (running.path === file.path || running.path.startsWith(file.path + '/'))) this.controller.stop();
        this.controller.changed(); void store.save().catch(e => new Notice(String(e)));
      }));
      this.registerEvent(this.app.vault.on('modify',file=>{
        const session=Object.values(store.data.sessions).find(s=>s.document.path===file.path&&!s.document.deleted);
        if(!session || (!session.review && !session.agentActions?.length && !this.controller.daily.data.receipts.some(r=>r.documentId===session.document.id)))return;
        // A known source-buffer flush is an echo. Unknown external text is conservatively invalidated.
        void (async()=>{if(session.review)await this.controller.reviews.latest(session.document.id);await this.controller.validateDocumentActions(session.document.id);this.controller.changed();await store.save();})().catch(()=>undefined);
      }));
      this.app.workspace.onLayoutReady(() => { documents.focus(this.app.workspace.getMostRecentLeaf()); this.controller.changed(); void scheduler.tick(); });
      await store.save();
    } catch (error) {
      new Notice(`稿伴无法启动：${error instanceof Error ? error.message : String(error)}。原有数据未重置。`, 10000);
      throw error;
    }
  }
  private async openSidebar(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false) ?? undefined; if (!leaf) throw new Error('无法打开右侧栏。'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  onunload(): void { this.controller?.close(); }
}
