# Ink Markup

An Obsidian plugin that opens a markdown note in a custom view with a freehand-ink overlay (Apple Pencil / mouse), and exports the annotated result as a PDF.

> v1 — desktop-first, with iPad support. Ink is ephemeral (not saved between sessions); it lives only until you export.

## Usage

1. Open any markdown note.
2. Run the command **"Open current note in Ink Markup."**
3. Draw over the rendered note with a mouse or Apple Pencil — strokes appear in red.
4. Use the **eraser** action to clear all ink.
5. Use the **download** action to export an annotated PDF.

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

## Known limitations (v1)

- Ink is not persisted — it's cleared when the view closes.
- PDF export relies on `html2canvas`, which is sensitive to cross-origin images and some modern CSS.
