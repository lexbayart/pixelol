# AGENTS.md — Pixelol, for AI agents

## What this project is

Pixelol is a pixel-art editor that lives in **one HTML file** with **zero dependencies**
and **zero build step**. You can download `index.html` and open it offline. Its whole
visual identity is a square rotated 45° with 1:1 symmetry, on an infinite borderless grid.

You are the **second pair of hands**. The human draws with a mouse; you read the same
layers, colours and folders and change them the same way. You are not a simplified view of
the canvas — it is exactly what the human sees in the layer panel.

> ### ⚠ Read this before you draw anything
>
> This canvas is a **45° diamond lattice**, not an ordinary pixel grid. `bbox` and `rows` are
> **logical** coordinates, **not a picture of what the screen shows**. Ordinary horizontal and
> vertical pixel art written into `rows` renders **slanted at 45°**.
>
> **You MUST read «How to draw in this medium» in this file before producing any drawing.**

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

Replaces the **pixel layers wholesale**. Reference (tracing) layers are not part of AI-JSON
and are left alone. `Ctrl+Z` undoes the whole import. Confirm with the user before you hand
them a document that deletes layers.

**The swatch panel is merged, never replaced.** The document carries only the colours it
actually used; the human's panel must keep its size. The rule the app applies
(`_aiMergePanelPalette`):

1. the document's colours first, in document order — the "used ones on top";
2. then whatever was already on the panel and is not in the document — the human's own
   colours, a `.lol` palette and colours extracted from an image are not dropped silently;
3. then any still-missing factory-default colours.

Trimmed to the panel's previous number of swatches, so a 2-colour document no longer wipes
36 cells down to 2. One exception: if the document has more colours than the panel has cells,
the panel grows to that count — otherwise document colours would vanish from it. The
36-colour cap applies to the document, never to the panel.

Never index into the panel when reasoning about a document. Characters always resolve
through the document's own `palette` array (`_aiValidateJSON` stores resolved hex into the
pixels), so a larger panel cannot repaint the drawing — this is also why the MCP `palette`
argument stays append-only.

### Why this shape

One character per cell instead of `["col,row","#hex"]` per pixel: the payload scales with a
layer's *area* rather than its pixel count, which is roughly an order of magnitude smaller.
The palette is rebuilt from the **actual** pixel values, not from the saved swatches — the
human can pick any colour with the colour picker, so the swatches lie.

---

## How to draw in this medium

**`bbox` and `rows` are the LOGICAL grid, not a picture of the canvas.** The canvas is a
diamond lattice: every cell is a square rotated 45°. `cellToScreen` (`index.html:11758`) is the
whole truth:

```js
x: vp.tx + (col - row) * step,
y: vp.ty + (col + row) * step,
```

So `+1 col` is *down-and-right* on screen and `+1 row` is *down-and-left*. On screen each cell's
four edge-sharing neighbours are its logical up/down/left/right ones — and **every visible edge
runs at 45°**. `rows[0]` is the upper-left diagonal of the drawing, not its top line.

### Screen direction → coordinate delta

| Screen direction | Δcol | Δrow | Δx | Δy |
|---|---|---|---|---|
| up    | −1 | −1 | 0 | −2·step |
| down  | +1 | +1 | 0 | +2·step |
| right | +1 | −1 | +2·step | 0 |
| left  | −1 | +1 | −2·step | 0 |

### Strokes

| On screen you want | Step in `rows` | Neighbouring cells |
|---|---|---|
| flat horizontal line | `col+1, row−1` | touch at their side tips |
| flat vertical line | `col+1, row+1` | touch at their side tips |
| 45° line, upper-left → lower-right | `col+1, row` (one flat run inside one `rows[r]`) | share a full edge |
| 45° line, upper-right → lower-left | `row+1` (one flat run down one column) | share a full edge |

### Worked example — the same 5×5 box, wrong and right

Naive — it *looks* like a sprite in the JSON; on screen it is a diamond pointing up:

```text
11111      ← on screen: rotated square, corners at top / bottom / left / right
12221
12221
12221
11111
```

Correct — the same upright box on screen, written as a ring of single cells:

```text
..1..
.1.1.
1...1
.1.1.
..1..
```

### The reliable recipe

Work in the two sums the formula actually uses, then convert back:

1. `u = col - row` is **right** on screen, `v = col + row` is **down**.
2. Draw the shape as an ordinary horizontal/vertical picture in `u,v`.
3. Keep only points where `u - v` is even — a cell centre exists only there.
4. Convert back: `col = (u+v)/2`, `row = (v-u)/2`.

Verified round-trips: screen disc `u²+v² ≤ 16` → five rows of `"11111"`;
screen disc `u²+v² ≤ 9` → `"..1.."`, `".111."`, `"11111"`, `".111."`, `"..1.."`.
Small shapes lose detail: below radius ~4 a circle reads as a diamond, because the lattice is
half as dense as an ordinary pixel grid.

### Symmetry, circles, rhombi

- Mirror across the **vertical** screen axis: `(col,row) → (row,col)` — i.e. **transpose the
  grid**. Verified: it negates `wx` and preserves `wy`.
- Mirror across the **horizontal** screen axis: `(col,row) → (−row,−col)`.
- A rhombus with its points at top/bottom/left/right on screen is a plain H/V-filled block in
  `rows`; an upright square on screen is a diamond / checker pattern there. The duality holds
  both ways.

Everything comes out straight and level (`ровно`) as long as these deltas are followed step by
step. Only tilt it when the user asks for it.

---

## Level 0 — manual exchange

Press **⬇ «Экспорт для ИИ»** → **«📋 Копировать»** → paste into a chat → paste the edited
JSON back → **⬆ «Импорт от ИИ»**. Works today, with no infrastructure at all.

## Level 1 — the MCP server

`ai-server/server.js` is a real MCP server (JSON-RPC 2.0 over stdio, no dependencies). It
edits one AI-JSON file on disk — the file «Экспорт для ИИ» → **«⬇ Скачать файл»** produces
(`<project-name>.ai.json`). See `ai-server/README.md` for client setup.

**Two forms, two destinations.** The downloaded file is pretty-printed (2-space indent,
trailing newline) so a human can read it; the **📋 Копировать** string is compact (one
line) so a chat stays clean. Both parse to the identical document.

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
- Draw for what the human **sees**, not for what the JSON looks like. `rows` is a diamond
  lattice, not a picture of the canvas: screen right is `col+1, row−1`, screen down is
  `col+1, row+1`, and a plain run of characters inside one row is a 45° line on screen. See
  «How to draw in this medium».
- Never invent fields. If `index.html` cannot read it, it does not belong in the document.
- Never shrink a bbox to fit a smaller grid — pad the rows instead. The two must agree.
- Keep the palette at 36 colours or fewer. A drawing that needs more fails the export
  rather than truncating; say so instead of quietly dropping colours.
- Ask before anything destructive: `draw_run` with a `document`, and `op` `"replace"` or
  `"clear"`, overwrite work the human cannot see from your side of the file.
- Report what you actually verified. If you could not run it, say that.
