# Ink Markup

An Obsidian plugin that opens a markdown note in a custom view with a freehand-ink overlay (Apple Pencil / mouse). Ink is saved per note as editable vector strokes, with automatic version history, and the annotated result exports to PDF.

> Desktop-first, with iPad support.

## Usage

1. Open any markdown note.
2. Open it for markup via the **pencil ribbon icon**, the note's **⋯ menu → "Open in Ink Markup,"** or the command **"Open current note in Ink Markup."**
3. Draw over the rendered note. On iPad, an **Apple Pencil draws** while a **finger scrolls** the note; on desktop the **mouse draws**.

### Toolbar

- **Pen / Highlighter / Eraser** (labeled) — the eraser removes whole strokes you touch.
- **Color** presets and **width** presets (thin / medium / thick).
- **Undo / redo** and **clear all**.
- **Version history** — restore an earlier autosaved state (restoring keeps your current ink as a new version).
- **Export PDF** — flatten the note + ink to a PDF.

Ink autosaves per note and re-opens where you left off. Saved data lives in the plugin's folder (`.obsidian/plugins/obsidian-ink-markup/ink/`); it syncs across devices only if your whole vault syncs (e.g. iCloud Drive).

## Install (beta, via BRAT)

This plugin isn't in the community store. To test it:

1. Install **BRAT** from Obsidian's Community Plugins.
2. BRAT → **Add Beta Plugin** → enter this repo's URL.
3. Enable **Ink Markup** in Community Plugins.

## Develop

```bash
npm install
npm run dev    # watch + rebuild main.js
npm run build  # typecheck + production bundle
```

## Known limitations

- Ink is positioned over the *rendered* note. If the note's text, theme, font, or width later changes, the layout reflows and existing strokes may no longer line up with the text.
- PDF export relies on `html2canvas`, which is sensitive to cross-origin images and some modern CSS.
