# Keyboard Mind Map

A mind map plugin for Obsidian that you drive from the keyboard. Each map is an
ordinary note, so search, backlinks and the graph see its contents, and the
note still reads as an outline without the plugin.

## Install

From Obsidian: Settings → Community plugins → Browse, search for "Keyboard Mind
Map", then Install and Enable. (Until the plugin is listed there, use the manual
install below.)

By hand: download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/jamiesobczyk-home/obsidian-mindmap-markdown/releases/latest)
into `<your vault>/.obsidian/plugins/mindmap-markdown/`, then reload Obsidian
and enable Keyboard Mind Map under Settings → Community plugins.

It works on desktop and mobile.

## A map is a note

```markdown
---
mindmap-plugin: basic
---

# Kitchen remodel

- Budget
	- Cabinets
- Contractors
	- [[Smith Carpentry]]
```

The heading is the centre of the map and the bullet list is the tree. Any note
with `mindmap-plugin` in its frontmatter opens as a map. View settings, such as
the layout and which branches are folded, are saved in a hidden `%%` comment at
the end of the note.

Opening a map never rewrites the note. The first change you make saves it in
a standard form: one bullet style, no blank lines between items, and
single spaces after bullets.

Each further `#` heading is another central topic with its own tree, drawn
beside the first. Relationship lines between any two topics are saved in the
same hidden comment, as are boundaries and summary brackets.

A topic's note is ordinary Markdown: lines indented under its bullet, or for a
central topic, the text between its heading and its first bullet. Images in
topics are ordinary embeds, `![[photo.png]]`.

If a note has something the map can't show, such as a paragraph after the
list that isn't indented under a topic, the map opens read-only and names the
line. That way saving from the
map can never drop text.

## Making and opening maps

- **New map:** the ribbon icon, the command "Create new mind map", or
  right-click a folder.
- **Existing note:** the command "Turn this note into a mind map", or the note's
  menu. Either one adds the frontmatter flag.
- **Back to the text:** the page icon in the view header, or the command
  "Switch between mind map and Markdown".
- **From a note's headings:** the command "Make a mind map from this note's
  headings", or the note's menu. It makes a new map beside the note, one topic
  per heading, each linking to its section; the note itself is untouched.
- **Outline:** the command "Show mind map outline" opens a sidebar list of the
  open map. Click a row to jump to it, double-click or F2 to rename, and click a
  triangle to fold. It follows whichever map is open and updates as you edit.

## Keys and gestures

| Key or gesture | Action |
|---|---|
| Tab | Add a child topic |
| Enter | Add a topic after this one (Shift+Enter: before) |
| Start typing, F2, or double-click | Edit the topic |
| Enter or Escape while editing | Keep or discard the edit |
| Arrow keys | Move between topics (Shift+arrow: extend the selection) |
| Shift-, Ctrl- or Cmd-click | Add or remove a topic from the selection |
| Drag a topic | Drop on a topic to make it a child, or between topics to reorder. Long-press first on touch screens |
| Alt+Up / Alt+Down | Reorder among siblings |
| Space | Fold or unfold the selected branches |
| Delete or Backspace | Delete the selected topics and their branches |
| Alt+F | Show only the selected branch (Escape or "Back to whole map" returns) |
| Right-click a topic | Edit, add a child, focus, turn it into a note (or open its note), link to another topic, make it a separate central topic, or set the branch colour |
| Right-click the background | New central topic |
| Right-click a topic: note, image, boundary, summary | Add or edit a note (Alt+N), add an image from the vault, add or label a boundary around the branch, or add a summary bracket over the selected sibling topics |
| Note icon on a topic | Hover or tap to read the note; links in it work |
| Click a summary bracket | Select it; Enter edits its text, Delete removes it |
| Alt+L | Link the selected topic to another: arrow to it and press Enter, or click it |
| Click a relationship line | Select it; Enter edits the label, Delete removes it, right-click to reverse |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo, redo |

On a phone or tablet, select a topic or line and tap the "…" button in the
toolbar for the same menu right-click gives: add, fold, delete, link, central
topics and colours.

Drag the background or scroll to pan. Use Ctrl+scroll or pinch to zoom. The
toolbar in the corner has focus, zoom, fit-to-window and a layout switch that
cycles through balanced, right-facing, org chart (top-down) and outline. Topics
can hold links, bold text and other inline Markdown, and wiki-links show hover
previews. Changes glide into place unless the system asks for reduced motion.

## Settings

Settings → Community plugins → Keyboard Mind Map. A change applies at once to every
open map. Settings are kept in the plugin's `data.json`, so they travel with
the vault; when a sync brings in settings changed on another device, open maps
pick them up without a restart. With nothing saved, the plugin behaves as it
did before it had settings.

| Setting | Choices | What it does |
|---|---|---|
| Default layout for new maps | Balanced, right-facing, org chart, outline | The layout of maps made by "Create new mind map", "Turn this note into a mind map" and "Make a mind map from this note's headings". Existing maps keep their own. |
| Spacing | Compact, normal, roomy | Room between topics, on screen and in SVG and PNG exports. |
| Topic width | Narrow (200 px), normal (320 px), wide (480 px) | How wide a topic grows before its text wraps. |
| Animation | On, off | Whether topics glide to their new places. Always off when the system asks for reduced motion. |
| Colour theme | Obsidian, Pastel, Vivid, Earth, Monochrome, High contrast | Colours for branches you haven't coloured yourself, each with light and dark versions. A colour you pick for a branch always wins. Exports use the theme too. |
| New maps go in | Obsidian's default location for new notes, the current note's folder, or a folder you choose | Where "Create new mind map" puts a map. Right-clicking a folder still puts it there, and a map made from headings still goes beside its note. |

## Export

The command palette has "Export map as SVG", "Export map as PNG" and "Export
map as OPML", which save next to the note, and "Copy map as Markdown outline".
The SVG and PNG show the map as laid out on screen, in the current theme's
colours.

## Development

To work on the plugin, clone this repository into a test vault's
`.obsidian/plugins/mindmap-markdown/` folder, so the vault loads the build
directly. Each release attaches `main.js`, `manifest.json` and `styles.css`.

```sh
npm install
npm test        # unit tests under Node
npm run smoke   # the view in headless Chromium against an Obsidian stand-in
npm run real    # the plugin in the real Obsidian app (Linux; downloads it once)
npm run build   # type-check, then write main.js
npm run dev     # rebuild on save
```

The pure modules are covered by unit tests under plain Node:

- `src/model.ts` handles the Markdown round trip.
- `src/ops.ts` holds tree edits.
- `src/layout.ts` covers the four layouts, line geometry and arrow-key movement.
- `src/interaction.ts` covers drop targets, selection and animation.
- `src/export.ts` produces SVG, OPML and outline output.
- `src/settings.ts` holds the settings, their defaults and how saved data is read.

None of them imports Obsidian. `src/view.ts` is the map view and `src/main.ts`
registers it. `tests/smoke/run.mjs` drives the real view in a browser and saves
screenshots to `.test-build/smoke/`. The stand-in only imitates Obsidian, so
`tests/real/run.mjs` also runs the plugin inside the real app, in a throwaway
vault and settings folder; run it before merging anything that touches the view. `main.js` is generated, so after merging
branches rebuild it rather than merge it.

## Licence

MIT. See `LICENSE`.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Open notes as maps, render, pan and zoom | Done |
| 2 | Keyboard editing, undo and redo, lossless save | Done |
| 3 | Drag to reparent, multi-select, animated relayout, focus on a branch | Done |
| 4 | Org-chart and outline layouts, branch colours, colour themes | Done |
| 5 | Turn a topic into a note, map from headings, outline pane kept in sync | Done |
| 6 | Relationship lines, multiple central topics, summary brackets, boundaries, notes and images on topics | Done |
| 7 | Export with images, phones, settings and colour themes, large-map performance, room for boundaries | Done. Very large maps (1,000+ topics) are still slow on a phone to add a child with Tab, fold a branch, or pan and zoom at 3,000 topics |
| 8 | Release to the community plugin directory | In progress |
