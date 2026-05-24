import { ItemView, WorkspaceLeaf, MarkdownRenderer, TFile, Notice } from 'obsidian';
import { InkCanvas } from './InkCanvas';
import { exportToPdf } from './exportPdf';

export const INK_VIEW_TYPE = 'ink-markup-view';

export class InkView extends ItemView {
  private filePath: string | null = null;
  private contentEl_!: HTMLElement;
  private inkCanvas!: InkCanvas;

  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return INK_VIEW_TYPE; }
  getDisplayText() { return this.filePath ? `Ink: ${this.filePath}` : 'Ink Markup'; }
  getIcon() { return 'pencil'; }

  async setState(state: any, result: any) {
    this.filePath = state?.filePath ?? null;
    await this.render();
    return super.setState(state, result);
  }

  getState() { return { filePath: this.filePath }; }

  async onOpen() {
    this.addAction('download', 'Export PDF', async () => {
      if (!this.contentEl_) return;
      new Notice('Exporting PDF…');
      await exportToPdf(this.contentEl_, this.filePath ?? 'note');
    });
    this.addAction('eraser', 'Clear ink', () => this.inkCanvas?.clear());
  }

  private async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('ink-markup-root');

    const wrapper = container.createDiv({ cls: 'ink-wrapper' });
    this.contentEl_ = wrapper.createDiv({ cls: 'ink-content markdown-rendered' });

    if (this.filePath) {
      const file = this.app.vault.getAbstractFileByPath(this.filePath);
      if (file instanceof TFile) {
        const md = await this.app.vault.cachedRead(file);
        await MarkdownRenderer.render(this.app, md, this.contentEl_, this.filePath, this);
      }
    }

    requestAnimationFrame(() => {
      const canvasEl = wrapper.createEl('canvas', { cls: 'ink-layer' });
      this.inkCanvas = new InkCanvas(canvasEl, this.contentEl_);
    });
  }
}
