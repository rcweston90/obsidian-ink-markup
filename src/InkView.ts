import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  Menu,
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
const DEFAULT_MARGIN_REM = 2;

export class InkView extends ItemView {
  private filePath: string | null = null;
  private contentEl_!: HTMLElement;
  private wrapperEl_!: HTMLElement;
  private scrollEl_!: HTMLElement;
  private inkCanvas?: InkCanvas;
  private store: InkStore;

  // toolbar state
  private tool: Tool = 'pen';
  private color = COLORS[0]!;
  private widthLevel: WidthLevel = 'medium';

  // page layout state
  private marginRem = DEFAULT_MARGIN_REM;
  private lineHeight: number | null = null; // null = theme default

  // toolbar element refs (for active/disabled styling)
  private toolButtons: Partial<Record<Tool, HTMLElement>> = {};
  private colorButtons: HTMLElement[] = [];
  private widthButtons: Partial<Record<WidthLevel, HTMLElement>> = {};
  private undoBtn?: HTMLElement;
  private redoBtn?: HTMLElement;

  // page-layout popover + remap session state
  private layoutPopover?: HTMLElement;
  private outsideClickHandler?: (e: MouseEvent) => void;
  private remapBlockTopsOrig: number[] | null = null;
  private remapPending = false;

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
    this.closeLayoutPopover();
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
    this.scrollEl_ = scroll;
    const wrapper = scroll.createDiv({ cls: 'ink-wrapper' });
    this.wrapperEl_ = wrapper;
    this.contentEl_ = wrapper.createDiv({ cls: 'ink-content markdown-rendered' });

    let initial: Stroke[] = [];
    if (this.filePath) {
      const doc = await this.store.load(this.filePath);
      initial = doc.current;
      this.marginRem = doc.layout?.marginRem ?? DEFAULT_MARGIN_REM;
      this.lineHeight = doc.layout?.lineHeight ?? null;
    }

    // Fix the column width / margin / line-height BEFORE rendering markdown, so the
    // text lays out at the same geometry the strokes were saved against.
    this.applyLayoutVars();

    if (this.filePath) {
      const file = this.app.vault.getAbstractFileByPath(this.filePath);
      if (file instanceof TFile) {
        const md = await this.app.vault.cachedRead(file);
        await MarkdownRenderer.render(this.app, md, this.contentEl_, this.filePath, this);
      }
    }

    // Markdown layout settles asynchronously; create the canvas once height is final.
    requestAnimationFrame(() => {
      const canvasEl = wrapper.createEl('canvas', { cls: 'ink-layer' });
      this.inkCanvas = new InkCanvas(canvasEl, this.contentEl_, this.wrapperEl_, {
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
    this.closeLayoutPopover();
    this.remapBlockTopsOrig = null;
    this.inkCanvas?.destroy();
    this.inkCanvas = undefined;
    this.toolButtons = {};
    this.colorButtons = [];
    this.widthButtons = {};
  }

  // ---- page layout (margin + line spacing) ----
  private remPx(): number {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }

  /** The text column is fixed at the pane width minus the DEFAULT margin, so the
   * margin slider never re-wraps the text and reopens align across the same pane. */
  private applyLayoutVars() {
    const measure = Math.max(240, this.scrollEl_.clientWidth - 2 * DEFAULT_MARGIN_REM * this.remPx());
    this.contentEl_.style.setProperty('--ink-measure', `${Math.round(measure)}px`);
    this.wrapperEl_.style.setProperty('--ink-margin', `${this.marginRem}rem`);
    if (this.lineHeight != null) {
      this.contentEl_.style.setProperty('--ink-line-height', String(this.lineHeight));
    } else {
      this.contentEl_.style.removeProperty('--ink-line-height');
    }
  }

  private computedLineHeight(): number {
    const cs = getComputedStyle(this.contentEl_);
    const lh = parseFloat(cs.lineHeight);
    const fs = parseFloat(cs.fontSize) || 16;
    if (!Number.isNaN(lh) && fs) return Math.min(3, Math.max(1, lh / fs));
    return 1.5;
  }

  /** Margin = pure outer padding; the wrapper ResizeObserver re-offsets the canvas. */
  private setMargin(rem: number) {
    this.marginRem = rem;
    this.wrapperEl_.style.setProperty('--ink-margin', `${rem}rem`);
  }

  private measureBlockTops(): number[] {
    if (!this.contentEl_) return [];
    const cr = this.contentEl_.getBoundingClientRect();
    return Array.from(this.contentEl_.children).map(
      (el) => (el as HTMLElement).getBoundingClientRect().top - cr.top,
    );
  }

  /** Returns the vertical displacement for a stroke whose original centroid is `cy`,
   * based on the displacement of the block it sits in (last block with top ≤ cy). */
  private buildDyForCentroid(origTops: number[], newTops: number[]): (cy: number) => number {
    const n = origTops.length;
    return (cy: number) => {
      if (n === 0) return 0;
      let idx = 0;
      for (let i = 0; i < n; i++) {
        if (origTops[i]! <= cy) idx = i;
        else break;
      }
      return newTops[idx]! - origTops[idx]!;
    };
  }

  private beginLayoutRemap() {
    if (!this.inkCanvas || this.remapBlockTopsOrig) return;
    this.remapBlockTopsOrig = this.measureBlockTops();
    this.inkCanvas.beginRemap();
  }

  private onLineSpacingInput(lineHeight: number) {
    this.lineHeight = lineHeight;
    this.contentEl_.style.setProperty('--ink-line-height', String(lineHeight));
    if (!this.remapBlockTopsOrig || !this.inkCanvas || this.remapPending) return;
    this.remapPending = true;
    requestAnimationFrame(() => {
      this.remapPending = false;
      const origTops = this.remapBlockTopsOrig;
      if (!this.inkCanvas || !origTops) return;
      const newTops = this.measureBlockTops();
      if (newTops.length !== origTops.length) return; // re-render race; skip this tick
      this.inkCanvas.applyRemap(this.buildDyForCentroid(origTops, newTops));
    });
  }

  private endLayoutRemap() {
    if (!this.remapBlockTopsOrig) return;
    this.remapBlockTopsOrig = null;
    this.inkCanvas?.endRemap(true);
    void this.persistLayout();
  }

  private async persistLayout() {
    if (!this.filePath) return;
    await this.store.saveLayout(this.filePath, {
      marginRem: this.marginRem,
      lineHeight: this.lineHeight,
    });
  }

  private buildToolbar(container: HTMLElement) {
    const bar = container.createDiv({ cls: 'ink-toolbar' });

    const tools = bar.createDiv({ cls: 'ink-tool-group' });
    this.toolButtons.pen = this.labeledToolButton(tools, 'pencil', 'Pen', () => this.setTool('pen'));
    this.toolButtons.highlighter = this.labeledToolButton(tools, 'highlighter', 'Highlighter', () =>
      this.setTool('highlighter'),
    );
    this.toolButtons.eraser = this.labeledToolButton(tools, 'eraser', 'Eraser', () =>
      this.setTool('eraser'),
    );

    // Swatches and width presets are <div role="button"> (not <button>) so that
    // Obsidian's mobile button styling can't override their color/shape/size.
    const colors = bar.createDiv({ cls: 'ink-tool-group ink-colors' });
    this.colorButtons = COLORS.map((c) => {
      const sw = this.pressable(colors, 'ink-swatch', `Color ${c}`, () => this.setColor(c));
      sw.style.setProperty('--swatch', c);
      return sw;
    });

    const widths = bar.createDiv({ cls: 'ink-tool-group ink-widths' });
    (['thin', 'medium', 'thick'] as WidthLevel[]).forEach((lvl) => {
      const b = this.pressable(widths, `ink-width ink-width-${lvl}`, `${lvl} width`, () =>
        this.setWidthLevel(lvl),
      );
      b.createDiv({ cls: 'ink-width-line' });
      this.widthButtons[lvl] = b;
    });

    const actions = bar.createDiv({ cls: 'ink-tool-group ink-actions' });
    this.undoBtn = this.iconButton(
      actions,
      'undo-2',
      'Undo',
      () => {
        this.inkCanvas?.undo();
        this.refreshUndoRedo();
      },
      'undo',
    );
    this.redoBtn = this.iconButton(
      actions,
      'redo-2',
      'Redo',
      () => {
        this.inkCanvas?.redo();
        this.refreshUndoRedo();
      },
      'redo',
    );
    this.iconButton(
      actions,
      'sliders-horizontal',
      'Page layout',
      (evt) => this.toggleLayoutPopover(evt),
      'settings',
    );
    this.iconButton(actions, 'more-horizontal', 'More actions', (evt) => this.openMoreMenu(evt), 'ellipsis');
  }

  // ---- page-layout popover ----
  private toggleLayoutPopover(evt: MouseEvent) {
    if (this.layoutPopover) {
      this.closeLayoutPopover();
      return;
    }
    if (!this.inkCanvas) return;
    const root = this.containerEl.children[1] as HTMLElement;
    const btn = evt.currentTarget as HTMLElement;
    const pop = root.createDiv({ cls: 'ink-layout-popover' });
    this.layoutPopover = pop;
    this.buildLayoutSliders(pop);

    const br = btn.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    pop.style.top = `${br.bottom - rr.top + 6}px`;
    const left = Math.min(br.left - rr.left - 120, rr.width - pop.offsetWidth - 8);
    pop.style.left = `${Math.max(8, left)}px`;

    // Dismiss on outside tap (deferred so this opening click doesn't immediately close it).
    this.outsideClickHandler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.contains(t) && t !== btn && !btn.contains(t)) this.closeLayoutPopover();
    };
    window.setTimeout(() => {
      if (this.outsideClickHandler) document.addEventListener('pointerdown', this.outsideClickHandler);
    }, 0);
  }

  private closeLayoutPopover() {
    if (this.outsideClickHandler) {
      document.removeEventListener('pointerdown', this.outsideClickHandler);
      this.outsideClickHandler = undefined;
    }
    this.layoutPopover?.remove();
    this.layoutPopover = undefined;
  }

  private buildLayoutSliders(pop: HTMLElement) {
    // Line spacing (re-anchors existing ink as it changes).
    const lhValue = this.lineHeight ?? this.computedLineHeight();
    const lsRow = pop.createDiv({ cls: 'ink-layout-row' });
    const lsHead = lsRow.createDiv({ cls: 'ink-layout-row-head' });
    lsHead.createSpan({ text: 'Line spacing' });
    const lsOut = lsHead.createSpan({ text: lhValue.toFixed(1) });
    const ls = lsRow.createEl('input', { attr: { type: 'range', min: '1', max: '3', step: '0.1' } });
    ls.value = String(lhValue);
    ls.addEventListener('pointerdown', () => this.beginLayoutRemap());
    ls.addEventListener('keydown', () => this.beginLayoutRemap());
    ls.addEventListener('input', () => {
      const v = parseFloat(ls.value);
      lsOut.setText(v.toFixed(1));
      this.onLineSpacingInput(v);
    });
    ls.addEventListener('change', () => this.endLayoutRemap());
    ls.addEventListener('blur', () => this.endLayoutRemap());

    // Margin (pure outer space; no re-anchoring needed).
    const mgRow = pop.createDiv({ cls: 'ink-layout-row' });
    const mgHead = mgRow.createDiv({ cls: 'ink-layout-row-head' });
    mgHead.createSpan({ text: 'Margin' });
    const mgOut = mgHead.createSpan({ text: `${this.marginRem.toFixed(1)} rem` });
    const mg = mgRow.createEl('input', { attr: { type: 'range', min: '2', max: '12', step: '0.5' } });
    mg.value = String(this.marginRem);
    mg.addEventListener('input', () => {
      const v = parseFloat(mg.value);
      mgOut.setText(`${v.toFixed(1)} rem`);
      this.setMargin(v);
    });
    mg.addEventListener('change', () => void this.persistLayout());

    const reset = pop.createEl('button', { cls: 'ink-layout-reset', text: 'Reset' });
    reset.addEventListener('click', () => {
      // Margin → default (no remap).
      this.setMargin(DEFAULT_MARGIN_REM);
      mg.value = String(DEFAULT_MARGIN_REM);
      mgOut.setText(`${DEFAULT_MARGIN_REM.toFixed(1)} rem`);
      // Line spacing → theme default, re-anchoring ink.
      this.beginLayoutRemap();
      this.lineHeight = null;
      this.contentEl_.style.removeProperty('--ink-line-height');
      const lh = this.computedLineHeight();
      ls.value = String(lh);
      lsOut.setText(lh.toFixed(1));
      requestAnimationFrame(() => {
        const origTops = this.remapBlockTopsOrig;
        if (this.inkCanvas && origTops) {
          const newTops = this.measureBlockTops();
          if (newTops.length === origTops.length) {
            this.inkCanvas.applyRemap(this.buildDyForCentroid(origTops, newTops));
          }
        }
        this.endLayoutRemap();
      });
    });
  }

  /** Secondary actions live in a "⋯" overflow menu to keep the bar to one row. */
  private openMoreMenu(evt: MouseEvent) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Clear all ink')
        .setIcon('trash-2')
        .onClick(() => {
          this.inkCanvas?.clear();
          this.refreshUndoRedo();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Version history')
        .setIcon('history')
        .onClick(() => void this.openVersions()),
    );
    menu.addItem((item) =>
      item
        .setTitle('Export PDF')
        .setIcon('download')
        .onClick(async () => {
          if (!this.contentEl_) return;
          new Notice('Exporting PDF…');
          await exportToPdf(this.contentEl_, this.filePath ?? 'note');
        }),
    );
    menu.showAtMouseEvent(evt);
  }

  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: (evt: MouseEvent) => void | Promise<void>,
    fallbackIcon?: string,
  ): HTMLElement {
    // Obsidian's own `clickable-icon` class is styled correctly on desktop AND
    // mobile (sizing, hover, appearance reset) — avoids the blank-icon bug.
    const b = parent.createEl('button', { cls: 'clickable-icon ink-action' });
    setIcon(b, icon);
    // Some Lucide names (e.g. the -2 variants) may be missing in older bundled
    // icon sets; fall back to a stable name so the button is never blank.
    if (fallbackIcon && !b.querySelector('svg')) setIcon(b, fallbackIcon);
    b.setAttr('aria-label', label);
    b.setAttr('title', label);
    b.addEventListener('click', (e) => void onClick(e));
    return b;
  }

  /** A non-<button> tappable control (swatch / width preset), keyboard-accessible. */
  private pressable(
    parent: HTMLElement,
    cls: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    const el = parent.createDiv({ cls });
    el.setAttr('role', 'button');
    el.setAttr('tabindex', '0');
    el.setAttr('aria-label', label);
    el.addEventListener('click', () => onClick());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    });
    return el;
  }

  private labeledToolButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    const b = parent.createEl('button', { cls: 'ink-tool-btn' });
    const ic = b.createSpan({ cls: 'ink-tool-btn-icon' });
    setIcon(ic, icon);
    b.createSpan({ cls: 'ink-tool-btn-label', text: label });
    b.setAttr('aria-label', label);
    b.addEventListener('click', () => onClick());
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
