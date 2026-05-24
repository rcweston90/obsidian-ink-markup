type Pt = { x: number; y: number; p: number };
type Stroke = { points: Pt[]; color: string; width: number };

export class InkCanvas {
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private current: Stroke | null = null;

  constructor(private canvas: HTMLCanvasElement, private content: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(content);

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
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
    // TODO for iPad: if (e.pointerType !== 'pen') return;
    this.canvas.setPointerCapture(e.pointerId);
    this.current = { points: [this.localPt(e)], color: '#d33', width: 2 };
  };

  private onMove = (e: PointerEvent) => {
    if (!this.current) return;
    this.current.points.push(this.localPt(e));
    this.redraw();
  };

  private onUp = () => {
    if (this.current) this.strokes.push(this.current);
    this.current = null;
  };

  private redraw() {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    const all = [...this.strokes, ...(this.current ? [this.current] : [])];
    for (const s of all) {
      this.ctx.strokeStyle = s.color;
      this.ctx.lineWidth = s.width;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      s.points.forEach((p, i) => i === 0 ? this.ctx.moveTo(p.x, p.y) : this.ctx.lineTo(p.x, p.y));
      this.ctx.stroke();
    }
  }

  clear() { this.strokes = []; this.redraw(); }
}
