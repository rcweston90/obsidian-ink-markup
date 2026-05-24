import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  TFile,
  Notice,
  Plugin,
  setIcon,
} from 'obsidian';
import { InkCanvas } from './InkCanvas';
import { InkStore, type Stroke, type Tool, type InkVersion } from './inkStore';
import { VersionModal } from './VersionModal';
import { exportToPdf } from './exportPdf';

export const INK_VIEW_TYPE = 'ink-markup-view';

const COLORS = ['#d92020', '#222222', '#2b6cb0', '#e0a800', '#2f9e44'];

type WidthLevel = 'thin' | 'medium' | 'thick';
const WIDTHS: Record<WidthLevel, { pen: number; hl: number }> = {
  thin: { pen: 2, hl: 12 },
  medium: { pen: 4, hl: 20 },
  thick: { pen: 7, hl: 30 },
};

const AUTOSAVE_MS = 800;
const VERSION_INTERVAL_MS = 120_000; // periodic checkpoint while drawing

export class InkView extends ItemView {
  private filePath: string | null = null;
  private contentEl_!: HTMLElement;
  private inkCanvas?: InkCanvas;
  private store: InkStore;

  // toolbar state
  private tool: Tool = 'pen';
  private color = COLORS[0]!;
  private widthLevel: WidthLevel = 'medium';

  // toolbar element refs (for active/disabled styling)
  private toolButtons: Partial<Record<Tool, HTMLElement>> = {};
  private colorButtons: HTMLElement[] = [];
  private widthButtons: Partial<Record<WidthLevel, HTMLElement>> = {};
  private undoBtn?: HTMLElement;
  private redoBtn?: HTMLElement;

  private autosaveTimer: number | null = null;
  private changedSinceVersion = false;

  constructor(leaf: WorkspaceLeaf, private plugin: Plugin) {
    super(leaf);
    const dir =
      this.plugin.manifest.dir ??
      `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    this.store = new InkStore(this.app, dir);
  }

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
    // Periodic version checkpoint while the view is open.
    this.registerInterval(
      window.setInterval(() => void this.commitVersionIfChanged(), VERSION_INTERVAL_MS),
    );
  }

  async onClose() {
    await this.flushAutosave();
    await this.commitVersionIfChanged();
    this.inkCanvas?.destroy();
  }

  // ---- rendering ----
  private async render() {
    this.teardownCanvas();

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('ink-markup-root');

    this.buildToolbar(container);

    const scroll = container.createDiv({ cls: 'ink-markup-scroll' });
    const wrapper = scroll.createDiv({ cls: 'ink-wrapper' });
    this.contentEl_ = wrapper.createDiv({ cls: 'ink-content markdown-rendered' });

    let initial: Stroke[] = [];
    if (this.filePath) {
      const file = this.app.vault.getAbstractFileByPath(this.filePath);
      if (file instanceof TFile) {
        const md = await this.app.vault.cachedRead(file);
        await MarkdownRenderer.render(this.app, md, this.contentEl_, this.filePath, this);
      }
      initial = (await this.store.load(this.filePath)).current;
    }

    // Markdown layout settles asynchronously; create the canvas once height is final.
    requestAnimationFrame(() => {
      const canvasEl = wrapper.createEl('canvas', { cls: 'ink-layer' });
      this.inkCanvas = new InkCanvas(canvasEl, this.contentEl_, {
        initialStrokes: initial,
        onChange: () => this.onCanvasChange(),
      });
      this.applyToolState();
      this.refreshUndoRedo();
    });
  }

  private teardownCanvas() {
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    this.inkCanvas?.destroy();
    this.inkCanvas = undefined;
    this.toolButtons = {};
    this.colorButtons = [];
    this.widthButtons = {};
  }

  private buildToolbar(container: HTMLElement) {
    const bar = container.createDiv({ cls: 'ink-toolbar' });

    const tools = bar.createDiv({ cls: 'ink-tool-group' });
    this.toolButtons.pen = this.iconButton(tools, 'pencil', 'Pen', () => this.setTool('pen'));
    this.toolButtons.highlighter = this.iconButton(tools, 'highlighter', 'Highlighter', () =>
      this.setTool('highlighter'),
    );
    this.toolButtons.eraser = this.iconButton(tools, 'eraser', 'Eraser', () => this.setTool('eraser'));

    const colors = bar.createDiv({ cls: 'ink-tool-group ink-colors' });
    this.colorButtons = COLORS.map((c) => {
      const sw = colors.createEl('button', { cls: 'ink-swatch' });
      sw.style.setProperty('--swatch', c);
      sw.setAttr('aria-label', `Color ${c}`);
      sw.addEventListener('click', () => this.setColor(c));
      return sw;
    });

    const widths = bar.createDiv({ cls: 'ink-tool-group ink-widths' });
    (['thin', 'medium', 'thick'] as WidthLevel[]).forEach((lvl) => {
      const b = widths.createEl('button', { cls: `ink-width ink-width-${lvl}` });
      b.createDiv({ cls: 'ink-width-dot' });
      b.setAttr('aria-label', `${lvl} width`);
      b.addEventListener('click', () => this.setWidthLevel(lvl));
      this.widthButtons[lvl] = b;
    });

    const actions = bar.createDiv({ cls: 'ink-tool-group ink-actions' });
    this.undoBtn = this.iconButton(actions, 'undo-2', 'Undo', () => {
      this.inkCanvas?.undo();
      this.refreshUndoRedo();
    });
    this.redoBtn = this.iconButton(actions, 'redo-2', 'Redo', () => {
      this.inkCanvas?.redo();
      this.refreshUndoRedo();
    });
    this.iconButton(actions, 'trash-2', 'Clear all ink', () => {
      this.inkCanvas?.clear();
      this.refreshUndoRedo();
    });
    this.iconButton(actions, 'history', 'Version history', () => void this.openVersions());
    this.iconButton(actions, 'download', 'Export PDF', async () => {
      if (!this.contentEl_) return;
      new Notice('Exporting PDF…');
      await exportToPdf(this.contentEl_, this.filePath ?? 'note');
    });
  }

  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void | Promise<void>,
  ): HTMLElement {
    const b = parent.createEl('button', { cls: 'ink-btn' });
    setIcon(b, icon);
    b.setAttr('aria-label', label);
    b.addEventListener('click', () => void onClick());
    return b;
  }

  // ---- toolbar state ----
  private setTool(t: Tool) { this.tool = t; this.applyToolState(); }
  private setColor(c: string) { this.color = c; this.applyToolState(); }
  private setWidthLevel(l: WidthLevel) { this.widthLevel = l; this.applyToolState(); }

  private applyToolState() {
    const c = this.inkCanvas;
    if (c) {
      c.setTool(this.tool);
      c.setColor(this.color);
      const w = WIDTHS[this.widthLevel];
      c.setPenWidth(w.pen);
      c.setHighlighterWidth(w.hl);
    }
    (Object.keys(this.toolButtons) as Tool[]).forEach((k) =>
      this.toolButtons[k]?.toggleClass('is-active', k === this.tool),
    );
    this.colorButtons.forEach((b, i) => b.toggleClass('is-active', COLORS[i] === this.color));
    (Object.keys(this.widthButtons) as WidthLevel[]).forEach((k) =>
      this.widthButtons[k]?.toggleClass('is-active', k === this.widthLevel),
    );
    // Color is meaningless while erasing.
    const erasing = this.tool === 'eraser';
    this.colorButtons.forEach((b) => b.toggleClass('is-disabled', erasing));
  }

  private refreshUndoRedo() {
    const c = this.inkCanvas;
    this.undoBtn?.toggleClass('is-disabled', !c || !c.canUndo());
    this.redoBtn?.toggleClass('is-disabled', !c || !c.canRedo());
  }

  // ---- persistence ----
  private onCanvasChange() {
    this.changedSinceVersion = true;
    this.refreshUndoRedo();
    this.scheduleAutosave();
  }

  private scheduleAutosave() {
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => void this.flushAutosave(), AUTOSAVE_MS);
  }

  private async flushAutosave() {
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (!this.filePath || !this.inkCanvas) return;
    await this.store.saveCurrent(this.filePath, this.inkCanvas.serialize());
  }

  private async commitVersionIfChanged() {
    if (!this.changedSinceVersion || !this.filePath || !this.inkCanvas) return;
    const strokes = this.inkCanvas.serialize();
    this.changedSinceVersion = false;
    if (!strokes.length) return;
    await this.store.commitVersion(this.filePath, strokes);
  }

  private async openVersions() {
    if (!this.filePath) return;
    await this.flushAutosave();
    const doc = await this.store.load(this.filePath);
    new VersionModal(this.app, doc, (v) => void this.restoreVersion(v)).open();
  }

  private async restoreVersion(v: InkVersion) {
    if (!this.inkCanvas || !this.filePath) return;
    // Preserve the current ink as a version so a restore is never destructive.
    const cur = this.inkCanvas.serialize();
    if (cur.length) await this.store.commitVersion(this.filePath, cur);
    this.inkCanvas.load(v.strokes);
    this.refreshUndoRedo();
    await this.store.saveCurrent(this.filePath, this.inkCanvas.serialize());
    new Notice('Restored ink version.');
  }
}
