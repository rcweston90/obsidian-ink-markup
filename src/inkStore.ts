import { App, normalizePath } from 'obsidian';

export type Tool = 'pen' | 'highlighter' | 'eraser';

export type Pt = { x: number; y: number; p: number };

export type Stroke = {
  points: Pt[];
  color: string;
  width: number;
  tool: 'pen' | 'highlighter';
};

export type InkVersion = {
  id: string;
  ts: number; // epoch ms
  strokes: Stroke[];
};

export type InkDoc = {
  notePath: string;
  current: Stroke[];
  versions: InkVersion[];
};

const MAX_VERSIONS = 20;

/**
 * Reads and writes per-note ink documents under the plugin's own folder
 * (e.g. `.obsidian/plugins/obsidian-ink-markup/ink/<note>.json`).
 * Each doc holds the live `current` strokes plus a capped list of timestamped
 * `versions` for restore.
 */
export class InkStore {
  private dir: string;

  constructor(private app: App, pluginDir: string) {
    this.dir = normalizePath(`${pluginDir}/ink`);
  }

  private pathFor(notePath: string): string {
    const safe = notePath.replace(/[^a-zA-Z0-9._-]/g, '_');
    return normalizePath(`${this.dir}/${safe}.json`);
  }

  async load(notePath: string): Promise<InkDoc> {
    const path = this.pathFor(notePath);
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(path)) {
      try {
        const doc = JSON.parse(await adapter.read(path)) as Partial<InkDoc>;
        return {
          notePath,
          current: doc.current ?? [],
          versions: doc.versions ?? [],
        };
      } catch (e) {
        console.error('Ink Markup: failed to parse ink doc', path, e);
      }
    }
    return { notePath, current: [], versions: [] };
  }

  private async write(doc: InkDoc): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
    await adapter.write(this.pathFor(doc.notePath), JSON.stringify(doc));
  }

  /** Debounced live-state save — overwrites `current`, leaves versions untouched. */
  async saveCurrent(notePath: string, strokes: Stroke[]): Promise<void> {
    const doc = await this.load(notePath);
    doc.current = strokes;
    await this.write(doc);
  }

  /** Commit a timestamped checkpoint, pruning to the most recent MAX_VERSIONS. */
  async commitVersion(notePath: string, strokes: Stroke[]): Promise<void> {
    if (strokes.length === 0) return; // never snapshot an empty canvas
    const doc = await this.load(notePath);
    doc.current = strokes;
    doc.versions.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      strokes,
    });
    if (doc.versions.length > MAX_VERSIONS) doc.versions = doc.versions.slice(0, MAX_VERSIONS);
    await this.write(doc);
  }
}
