import { App, Modal } from 'obsidian';
import type { InkDoc, InkVersion } from './inkStore';

/** Lists timestamped ink versions and restores the one the user picks. */
export class VersionModal extends Modal {
  constructor(
    app: App,
    private doc: InkDoc,
    private onRestore: (v: InkVersion) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText('Ink version history');

    if (!this.doc.versions.length) {
      contentEl.createEl('p', {
        text: 'No saved versions yet. Versions are captured automatically as you draw.',
      });
      return;
    }

    contentEl.createEl('p', {
      cls: 'ink-version-hint',
      text: 'Restoring keeps your current ink as a new version, so nothing is lost.',
    });

    const list = contentEl.createDiv({ cls: 'ink-version-list' });
    this.doc.versions.forEach((v) => {
      const row = list.createDiv({ cls: 'ink-version-row' });
      const meta = row.createDiv({ cls: 'ink-version-meta' });
      meta.createEl('div', { cls: 'ink-version-time', text: new Date(v.ts).toLocaleString() });
      meta.createEl('div', {
        cls: 'ink-version-sub',
        text: `${v.strokes.length} stroke${v.strokes.length === 1 ? '' : 's'}`,
      });
      const btn = row.createEl('button', { cls: 'mod-cta', text: 'Restore' });
      btn.addEventListener('click', () => {
        this.onRestore(v);
        this.close();
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
