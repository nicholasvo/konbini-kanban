# Konbini Kanban

A Linear-style kanban board rendered as a **custom [Obsidian Bases](https://help.obsidian.md/bases) view**. Each task is a note; the board reads and writes the note's frontmatter — with a little convenience-store pixel art for company.

![board](https://img.shields.io/badge/obsidian-1.10%2B-7c3aed)

## Features

- **Status columns** — Backlog · Todo · In Progress · Done · Canceled (Linear glyphs). Drag a card between columns to rewrite its `status`, with a springy animation.
- **Global columns (Settings)** — add, hide, or delete columns plugin-wide. New Kanban views inherit this set automatically.
- **Per-view column override** — optionally redefine columns on a single Bases view without changing the global set.
- **Priority** — No priority · Urgent · High · Medium · Low, with Linear's signal-bar icons.
- **Labels** — multi-value, with on-the-fly creation; the picker suggests labels already used across the base.
- **Sub-tasks** — created as separate notes linked by a `parent` property; they nest visually under the parent card, which shows a `done/total` rollup.
- **Start & end dates** — pick dates in the create modal or on a card; overdue due dates turn red.
- **Attachments** — attach images and other files via the create modal (paperclip, drag-drop, or paste); they're imported into the vault and embedded.
- **Quick create** — a Linear-style "New task" modal (`+` on any column header, or the branch icon on a card for a sub-task).
- **Templates** — define reusable description bodies in plugin settings, then drop one into a new task from the **Template** pill in the create modal.
- **Konbini pixel art** — a delightful animated convenience-store scene along the bottom of the board. Toggle it off in plugin settings.
- **Configurable** — property names are remappable in the view's options; defaults match the screenshots out of the box.

## How it works

Obsidian's `BasesView` API is **read-only**: it hands the view the filtered set of notes and their evaluated property values. All mutations (drag-to-restatus, priority, labels, create) are written back through `app.fileManager.processFrontMatter()` / `vault.create()`. Frontmatter is read directly via the metadata cache, so the board stays in sync whenever a note changes.

### Columns

Column definitions live in **plugin Settings** and apply to every Kanban view that does not set its own override.

1. **Global Settings** — manage the default column list (add / hide / delete).
2. **View option override** — if a view's "Columns override" field is non-empty (`key:Label, key:Label, …`), that string wins for that view only. Global Settings changes do not rewrite it.
3. **Empty / absent override** — the view uses the global Settings columns.

Hide toggles in Settings (and "Hide column" on the board) are global visibility flags shared across boards.

### Data model

One task = one note. Example frontmatter:

```yaml
---
title: Wire up the auth callback
status: in progress
priority: high
labels:
  - backend
  - bug
parent: "[[Epic — Authentication]]"
---
Body text becomes the task description.
```

## Install (manual, for development)

1. `npm install`
2. `npm run build` (or `npm run dev` to watch)
3. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<vault>/.obsidian/plugins/konbini-kanban/`
4. Enable **Konbini Kanban** in Settings → Community plugins.
5. Make sure the core **Bases** plugin is enabled.

## Use

1. Create a base (`.base`) whose filter selects your task notes.
2. Add a view and choose **Kanban** as the view type.
3. (Optional) Open plugin Settings → Columns to customize the global column set.
4. (Optional) Open the view options to remap property names, or set a Columns override for this view only.

## View options

| Option | Default | Notes |
|---|---|---|
| Status property | `status` | frontmatter key holding the status value |
| Priority property | `priority` | |
| Labels property | `labels` | list-valued |
| Parent property | `parent` | wikilink/path to the parent task |
| Title property | `title` | falls back to the filename |
| Start/End date property | `startDate` / `endDate` | |
| Default status | `todo` | applied to new tasks |
| Columns override | _(empty)_ | optional `key:Label, …` — when set, overrides global Settings for this view |

## License

MIT
