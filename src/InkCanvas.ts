import type { Pt, Stroke, Tool } from './inkStore';

const HL_ALPHA = 0.35; // highlighter translucency
const ERASE_BASE_RADIUS = 8; // hit slop in px, on top of half the stroke width
const MAX_UNDO = 100;

export type InkCanvasOptions = {
  initialStrokes?: Stroke[];
  onChange?: () => void;
};

/**
 * Freehand-ink surface over the rendered note. Strokes are stored as vector
 * data (so they persist, re-render crisply, and support undo/redo + erase).
 * Every committed mutation produces a fresh `strokes` array, so undo/redo
 * stacks can hold cheap array references rather than deep copies.
 */
export class InkCanvas {
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[];
  private current: Stroke | null = null;
  private undoStack: Stroke[][] = [];
  private redoStack: Stroke[][] = [];

  private tool: Tool = 'pen';
  private color = '#d92020';
  private penWidth = 4;
  private hlWidth = 20;

  // eraser gesture state
  private erasing = false;
  private erasedAny = false;
  private eraseBefore: Stroke[] = [];

  private onChange?: () => void;
  private ro: ResizeObserver;
  private rafId: number | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private content: HTMLElement,
    opts: InkCanvasOptions = {},
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.strokes = (opts.initialStrokes ?? []).map(cloneStroke);
    this.onChange = opts.onChange;

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(content);

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);

    // iPad: the Apple Pencil also emits touch events (touchType 'stylus').
    // Cancel those at the start so the browser never begins a scroll for pen
    // input (the "jump" before a stroke registers). Finger touches ('direct')
    // are left untouched so they keep scrolling natively, with momentum.
    canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
  }

  // ---- public API ----
  setTool(t: Tool) { this.tool = t; }
  setColor(c: string) { this.color = c; }
  setPenWidth(w: number) { this.penWidth = w; }
  setHighlighterWidth(w: number) { this.hlWidth = w; }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.strokes);
    this.strokes = prev;
    this.redraw();
    this.onChange?.();
  }

  redo() {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.strokes);
    this.strokes = next;
    this.redraw();
    this.onChange?.();
  }

  clear() {
    if (!this.strokes.length) return;
    this.pushUndo();
    this.strokes = [];
    this.redraw();
    this.onChange?.();
  }

  serialize(): Stroke[] {
    return this.strokes.map(cloneStroke);
  }

  /** Replace all strokes (e.g. restoring a version); resets undo/redo history. */
  load(strokes: Stroke[]) {
    this.strokes = strokes.map(cloneStroke);
    this.undoStack = [];
    this.redoStack = [];
    this.current = null;
    this.redraw();
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('touchstart', this.onTouchStart);
    this.canvas.removeEventListener('touchmove', this.onTouchMove);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
  }

  // ---- internals ----
  private pushUndo() {
    this.undoStack.push(this.strokes);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  private resize() {
    const w = this.content.scrollWidth;
    const h = this.content.scrollHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.redraw();
  }

  private localPt(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
  }

  private onDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // let a finger scroll the note natively
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.toggleClass('is-drawing', true); // block scroll while a stroke is in progress
    const pt = this.localPt(e);

    if (this.tool === 'eraser') {
      this.erasing = true;
      this.erasedAny = false;
      this.eraseBefore = this.strokes;
      this.eraseAt(pt);
      return;
    }

    const drawTool: 'pen' | 'highlighter' = this.tool === 'highlighter' ? 'highlighter' : 'pen';
    this.current = {
      points: [pt],
      color: this.color,
      width: drawTool === 'highlighter' ? this.hlWidth : this.penWidth,
      tool: drawTool,
    };
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (this.tool === 'eraser') {
      if (this.erasing) this.eraseAt(this.localPt(e));
      return;
    }
    if (!this.current) return;
    this.current.points.push(this.localPt(e));
    // Pen: draw just the new segment (cheap). Highlighter: throttled full repaint.
    if (this.current.tool === 'pen') this.drawLastSegment();
    else this.scheduleRepaint();
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.canvas.toggleClass('is-drawing', false); // restore finger-scroll
    if (this.tool === 'eraser') {
      if (this.erasing && this.erasedAny) {
        this.undoStack.push(this.eraseBefore);
        if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
        this.redoStack = [];
        this.onChange?.();
      }
      this.erasing = false;
      this.erasedAny = false;
      return;
    }
    if (this.current) {
      this.pushUndo();
      this.strokes = [...this.strokes, this.current];
      this.current = null;
      this.redraw();
      this.onChange?.();
    }
  };

  private onTouchStart = (e: TouchEvent) => {
    if (this.hasStylusTouch(e)) e.preventDefault();
  };

  private onTouchMove = (e: TouchEvent) => {
    if (this.hasStylusTouch(e)) e.preventDefault();
  };

  // WebKit (iPad) tags each touch as 'direct' (finger) or 'stylus' (Apple Pencil).
  private hasStylusTouch(e: TouchEvent): boolean {
    const list = e.touches.length ? e.touches : e.changedTouches;
    for (let i = 0; i < list.length; i++) {
      const t = list.item(i) as (Touch & { touchType?: string }) | null;
      if (t && t.touchType === 'stylus') return true;
    }
    return false;
  }

  private eraseAt(pt: Pt) {
    const toRemove = new Set<Stroke>();
    for (const s of this.strokes) {
      const r = ERASE_BASE_RADIUS + s.width / 2;
      const pts = s.points;
      if (pts.length === 1) {
        const a = pts[0]!;
        if (Math.hypot(pt.x - a.x, pt.y - a.y) <= r) toRemove.add(s);
        continue;
      }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        if (distToSeg(pt.x, pt.y, a.x, a.y, b.x, b.y) <= r) {
          toRemove.add(s);
          break;
        }
      }
    }
    if (toRemove.size) {
      this.erasedAny = true;
      this.strokes = this.strokes.filter((s) => !toRemove.has(s));
      this.scheduleRepaint();
    }
  }

  /** Repaint every stroke from scratch. Used for committed changes. */
  private paint() {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    const all = this.current ? [...this.strokes, this.current] : this.strokes;
    for (const s of all) {
      this.ctx.save();
      this.ctx.strokeStyle = s.color;
      this.ctx.lineWidth = s.width;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.globalAlpha = s.tool === 'highlighter' ? HL_ALPHA : 1;
      this.ctx.beginPath();
      const pts = s.points;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        if (i === 0) this.ctx.moveTo(p.x, p.y);
        else this.ctx.lineTo(p.x, p.y);
      }
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  /** Synchronous full repaint (undo/redo/clear/load/resize/commit). */
  private redraw() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.paint();
  }

  /** Coalesce per-move full repaints (highlighter/eraser) to one per frame. */
  private scheduleRepaint() {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.paint();
    });
  }

  /**
   * Pen ink is opaque, so during a stroke we draw only the newest segment on top
   * of what's already on the canvas — O(1) per move instead of repainting every
   * stroke, which is what caused draw latency on long notes.
   */
  private drawLastSegment() {
    if (!this.current) return;
    const pts = this.current.points;
    if (pts.length < 2) return;
    const a = pts[pts.length - 2]!;
    const b = pts[pts.length - 1]!;
    this.ctx.save();
    this.ctx.strokeStyle = this.current.color;
    this.ctx.lineWidth = this.current.width;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
    this.ctx.stroke();
    this.ctx.restore();
  }
}

function cloneStroke(s: Stroke): Stroke {
  return {
    color: s.color,
    width: s.width,
    tool: s.tool,
    points: s.points.map((p) => ({ x: p.x, y: p.y, p: p.p })),
  };
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
