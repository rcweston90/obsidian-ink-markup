import { Plugin, TFile } from 'obsidian';
import { InkView, INK_VIEW_TYPE } from './InkView';

export default class InkMarkupPlugin extends Plugin {
  async onload() {
    this.registerView(INK_VIEW_TYPE, (leaf) => new InkView(leaf));

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
