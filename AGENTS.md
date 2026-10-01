# AGENTS.md — Pixelol, for AI agents

## What this project is

Pixelol is a pixel-art editor that lives in **one HTML file** with **zero dependencies**
and **zero build step**. You can download `index.html` and open it offline. Its whole
visual identity is a square rotated 45° with 1:1 symmetry, on an infinite borderless grid.

You are the **second pair of hands**. The human draws with a mouse; you read the same
layers, colours and folders and change them the same way. You are not a simplified view of
the canvas — it is exactly what the human sees in the layer panel.

## What you must not break

- **The single-file promise.** New app code goes into the one marked block at the end of
  `index.html` (the `╔═╗ AI-АГЕНТ` banner, ~lines 15436–16062). Do not create `.js` files
  for the app itself.
- **The `.lol` save format.** Untouched. AI-JSON is a separate, on-demand export and is
  never fed to `loadLOLFromInput`.
- **The 45° symmetric diamond.** That is the product, not an implementation detail.
- `index.html` is read-only for agents working through the MCP server. Report bugs in it
  instead of editing it.

---

## The exchange format ("AI-JSON")

Produced by **⬇ «Экспорт для ИИ»** (`exportForAI`), consumed by **⬆ «Импорт от ИИ»**
(`importFromAI`). A derived export, not a save file.

```json
{
  "meta": {
    "project": "hero_prototype",
    "geometry": "45deg-rotated-square, symmetric 1:1; wx=(col-row)*step; wy=(col+row)*step",
    "note": "col/row — логические координаты сетки; холст без границ, хранится только bbox каждого слоя"
  },
  "palette": ["#1a1a2e", "#e94560", "#f5d0a9", "#3a2a1e"],
  "layers": [
    {
      "name": "тело",
      "folder": "персонаж_1",
      "bbox": { "minCol": 0, "minRow": 0, "maxCol": 4, "maxRow": 6 },
      "rows": ["11111", "12221", "12221", "12221", "11111", ".111.", ".111."]
    }
  ]
}
```

### The rules — all of them enforced by the app

| Rule | Detail |
|---|---|
| **Layer order** | `layers[0]` is the **topmost** layer. Same order as the layer panel, top to bottom. |
| **Palette** | Flat array of `"#rgb"` / `"#rrggbb"` strings. **Maximum 36.** |
| **Grid characters** | `"."` = empty cell. `"0"`–`"9"` = `palette[0..9]`. `"a"`–`"z"` = `palette[10..35]`. |
| **Case** | Import accepts `A` as `a` (index 10). Export always writes lowercase. |
| **Coordinates** | `rows[r][c]` is the cell at `col = bbox.minCol + c`, `row = bbox.minRow + r`. `col`/`row` are integer **grid** coordinates, not screen pixels. |
| **bbox ↔ rows math** | `maxCol - minCol + 1 == rows[0].length` and `maxRow - minRow + 1 == rows.length`. Always. |
| **bbox is tight** | On export every edge row and column holds at least one painted cell. Build bboxes around what you actually paint. |
| **All rows equal length** | Otherwise the import is rejected. |
| **Empty layer** | `{"bbox": null, "rows": []}`. |
| **`folder`** | Folder name as a string, or `null` for no folder. Free text. |
| **`name`** | Free text. Missing or blank becomes `Слой N`. |
| **Size cap** | 1024 × 1024 cells per layer. |
| **`meta`** | **Informational only.** The app reads only `palette` and `layers` on import. |

If a `bbox` is well-formed but disagrees with `rows`, the app trusts `rows`, anchors the
grid at `0,0`, and says so in an import note. Do not rely on that — make it agree.

### What import actually does

Replaces the **pixel layers and the palette wholesale**. Reference (tracing) layers are not
part of AI-JSON and are left alone. `Ctrl+Z` undoes the whole import. Confirm with the
user before you hand them a document that deletes layers.

### Why this shape

One character per cell instead of `["col,row","#hex"]` per pixel: the payload scales with a
layer's *area* rather than its pixel count, which is roughly an order of magnitude smaller.
The palette is rebuilt from the **actual** pixel values, not from the saved swatches — the
human can pick any colour with the colour picker, so the swatches lie.

---

## Level 0 — manual exchange

Press **⬇ «Экспорт для ИИ»** → **«📋 Копировать»** → paste into a chat → paste the edited
JSON back → **⬆ «Импорт от ИИ»**. Works today, with no infrastructure at all.

## Level 1 — the MCP server

`ai-server/server.js` is a real MCP server (JSON-RPC 2.0 over stdio, no dependencies). It
edits one AI-JSON file on disk — the file «Экспорт для ИИ» → **«⬇ Скачать .json»** produces
(`<project-name>.ai.json`). See `ai-server/README.md` for client setup.

| Tool | Input | Output |
|---|---|---|
| `get_canvas_state` | none | The canonical AI-JSON document as text. Read-only. Call it first, every session. |
| `draw_run` | `{document}` **or** `{edits, palette?}` | Confirmation text plus the changed layers as a grid. |
| `add_layer` | `{name?, folder?, index?, bbox?, rows?, palette?}` | Confirmation text plus the new layer's grid. |

**`draw_run` has two modes — pick exactly one:**

- `document` — a whole `{meta, palette, layers}` document, the same shape «Импорт от ИИ»
  accepts. Replaces the file. Use it to rename, reorder or delete layers.
- `edits` — `[{target, op, bbox?, rows?}]` patches that leave the rest untouched.
  `target` is `{"layer":"name"}` or `{"index":0}` (0 = topmost). `op` is `"merge"` (default,
  paint over the existing art), `"replace"` (discard the layer first) or `"clear"` (empty
  it). `rows[r][c]` lands at `col = bbox.minCol + c`, `row = bbox.minRow + r`.

Prefer `edits` when drawing on top of existing art: you send only the cells that change.
The optional `palette` is **append-only** — a new colour must be appended, never inserted,
or every already-painted index character silently repaints.

Any call that fails validation returns `isError: true` with a readable message and leaves
the file **byte-for-byte unchanged**. Writes are atomic.

### Example session

```jsonc
// → get_canvas_state  (abridged)
{ "meta": { "project": "hero_prototype" },
  "palette": ["#1a1a2e", "#e94560", "#f5d0a9", "#3a2a1e"],
  "layers": [ { "name": "тело", "folder": "персонаж_1",
                "bbox": { "minCol": 0, "minRow": 0, "maxCol": 4, "maxRow": 6 },
                "rows": ["11111", "12221", "12221", "12221", "11111", ".111.", ".111."] } ] }

// → draw_run: paint a 3×2 highlight at col 6..8, row 2..3, colour index 2 (#f5d0a9)
{ "edits": [ { "target": { "layer": "тело" }, "op": "merge",
              "bbox": { "minCol": 6, "minRow": 2, "maxCol": 8, "maxRow": 3 },
              "rows": [ "222", "222" ] } ] }

// → add_layer: a new topmost layer, already painted
{ "name": "блик", "folder": "персонаж_1", "index": 0, "rows": [ "1", "1" ] }
```

Then the human presses **⬆ «Импорт от ИИ»** → **«📂 Из файла»** and picks the file.

---

## Working rules

- Read before you write. `get_canvas_state` first, always.
- Never invent fields. If `index.html` cannot read it, it does not belong in the document.
- Never shrink a bbox to fit a smaller grid — pad the rows instead. The two must agree.
- Keep the palette at 36 colours or fewer. A drawing that needs more fails the export
  rather than truncating; say so instead of quietly dropping colours.
- Ask before anything destructive: `draw_run` with a `document`, and `op` `"replace"` or
  `"clear"`, overwrite work the human cannot see from your side of the file.
- Report what you actually verified. If you could not run it, say that.
