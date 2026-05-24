import { Notice, Plugin, TFile } from 'obsidian';
import { InkView, INK_VIEW_TYPE } from './InkView';

export default class InkMarkupPlugin extends Plugin {
  async onload() {
    this.registerView(INK_VIEW_TYPE, (leaf) => new InkView(leaf));

    // Left-ribbon button (also shows on mobile) — opens the active note for markup.
    this.addRibbonIcon('pencil', 'Open current note in Ink Markup', () => {
      const file = this.app.workspace.getActiveFile();
      if (file && file.extension === 'md') this.openInkView(file);
      else new Notice('Open a markdown note first.');
    });

    this.addCommand({
      id: 'open-in-ink-markup',
      name: 'Open current note in Ink Markup',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) this.openInkView(file);
        return true;
      },
    });

    // Add "Open in Ink Markup" to a note's ⋯ menu (and file-explorer right-click).
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) =>
          item
            .setTitle('Open in Ink Markup')
            .setIcon('pencil')
            .onClick(() => this.openInkView(file)),
        );
      }),
    );
  }

  async openInkView(file: TFile) {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: INK_VIEW_TYPE, state: { filePath: file.path } });
    this.app.workspace.revealLeaf(leaf);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(INK_VIEW_TYPE);
  }
}
