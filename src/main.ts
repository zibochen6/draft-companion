import { Plugin, Modal, Notice } from 'obsidian';
import { Store } from './store';
import { Documents } from './documents';
import { Controller } from './controller';
import { DraftCompanionView, VIEW_TYPE } from './sidebar';
import { DraftCompanionSettings } from './settings';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class DraftCompanionPlugin extends Plugin {
  controller!: Controller;
  async onload(): Promise<void> {
    try {
      const store = new Store(await this.loadData(), data => this.saveData(data));
      const documents = new Documents(this.app, store.data.sessions);
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
      this.addSettingTab(new DraftCompanionSettings(this, this.controller));
      this.addRibbonIcon('pencil-line', '打开稿伴', () => { void this.openSidebar(); });
      this.addCommand({ id: 'open-sidebar', name: '打开创作侧栏', callback: () => { void this.openSidebar(); } });
      this.addCommand({ id: 'undo-last-edit', name: '撤回当前文稿最近 AI 修改', callback: () => { void this.controller.undo().catch(error => new Notice(errorMessage(error))); } });
      this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => { documents.focus(leaf); this.controller.changed(); }));
      this.registerEvent(this.app.workspace.on('layout-change', () => this.controller.changed()));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        documents.renamed(file, oldPath); this.controller.changed(); void store.save().catch(e => new Notice(String(e)));
      }));
      this.registerEvent(this.app.vault.on('delete', file => {
        documents.deleted(file);
        const running = this.controller.running;
        if (running && (running.path === file.path || running.path.startsWith(file.path + '/'))) this.controller.stop();
        this.controller.changed(); void store.save().catch(e => new Notice(String(e)));
      }));
      this.app.workspace.onLayoutReady(() => { documents.focus(this.app.workspace.getMostRecentLeaf()); this.controller.changed(); });
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
