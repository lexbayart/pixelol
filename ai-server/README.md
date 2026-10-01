# pixelol-ai — MCP server for Pixelol

A real [Model Context Protocol](https://modelcontextprotocol.io) server (JSON-RPC 2.0
over stdio) that lets an AI agent read and edit a Pixelol canvas.

It is **Level 1** of the adaptation plan: a separate Node process, not part of
`index.html`. It never modifies `index.html` and never touches the `.lol` save format.
Zero dependencies — Node built-ins only, no `package.json`, no `npm install`.

---

## 1. How the AI-JSON file gets created

The server works on one file: the **AI-JSON document** produced by the app's
«Экспорт для ИИ» button.

1. Open `index.html` in a browser and draw something.
2. Press **⬇ «Экспорт для ИИ»** in the toolbar.
3. In the dialog press **«⬇ Скачать .json»**. The browser saves it as
   `<project-name>.ai.json` (e.g. `hero_prototype.ai.json`) in your downloads folder.
   «📋 Копировать» is the Level 0 alternative — paste the text straight into a chat.
4. Point this server at that file (see below).

At the end of the session press **⬆ «Импорт от ИИ»** → **«📂 Из файла»** and pick the
*same* file. That is the round trip: the agent edits the file, the human brings it home.

> This is a file exchange, not a live connection. Nothing watches the browser tab.
> If you want the agent to see edits the moment you make them, press «Экспорт для ИИ»
> again and hand the fresh file over.

## 2. Wiring it to an MCP client

The server takes one argument: `--file <path>`. Default: `canvas.ai.json` next to
`server.js`. The env var `PIXELOL_AI_FILE` works too.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pixelol": {
      "command": "node",
      "args": [
        "/absolute/path/to/pixelol/ai-server/server.js",
        "--file",
        "/Users/you/Downloads/hero_prototype.ai.json"
      ]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add pixelol -- node /absolute/path/to/pixelol/ai-server/server.js \
  --file /Users/you/Downloads/hero_prototype.ai.json
```

**Cursor** — `.cursor/mcp.json`, same `mcpServers` shape as above.

`node server.js --help` prints usage. `--version` prints the version.

## 3. Tools

| Tool | Writes? | What it does |
|---|---|---|
| `get_canvas_state` | no | Returns the whole AI-JSON document as text. Call it first, every session. |
| `draw_run` | yes | Applies a modification. Two mutually exclusive modes — a full `document`, or a list of targeted `edits`. |
| `add_layer` | yes | Inserts a layer, optionally already painted. |

### `get_canvas_state`

No arguments. Returns the document, canonicalised: `layers[0]` is the topmost layer,
every `bbox` is tight around the painted cells, all index characters are lowercase.
Use what it returns, not what you think the file says.

### `draw_run`

Exactly one of:

- **`document`** — a complete `{meta, palette, layers}` document, byte-compatible with
  what «Импорт от ИИ» accepts. Replaces the file wholesale. `get_canvas_state` → edit →
  send back. Use this for restructuring: renaming, reordering, deleting layers.
- **`edits`** — an array of patches that leave everything else alone. Each patch is
  `{target, op, bbox?, rows?}`:
  - `target`: `{"layer": "тело"}` or `{"index": 1}` (0 = topmost). Layer names must be
    unique; if not, use the index.
  - `op`: `"merge"` (default — paint over the existing art, cells you don't mention keep
    their colour), `"replace"` (discard the layer, paint only the patch), `"clear"`
    (empty the layer, no `rows` needed).
  - `bbox` + `rows`: where and what to paint. `rows[r][c]` lands at
    `col = bbox.minCol + c`, `row = bbox.minRow + r`.

Use `edits` for drawing on top of existing art — you send only the cells you change.

Optional **`palette`** (both tools): append colours so a patch can use a new index
character. Append-only — existing entries must stay identical, otherwise every already
painted character would silently repaint. To reorder or drop colours, send a full
`document` instead.

### `add_layer`

`{name?, folder?, index?, bbox?, rows?, palette?}`.
- `name` — free text, defaults to `Слой N`.
- `folder` — folder name, or omit/null for no folder.
- `index` — insert position, `0` = topmost. Default `0`.
- `rows` (+ `bbox`) — create it already painted. Omit both for an empty layer, which is
  written as `{"bbox": null, "rows": []}`.

## 4. Safety

- Every write is validated with the same rules as the app's own import, and re-validated
  once more before it touches the disk. A rejected call returns `isError: true` with a
  readable message and **the file is left exactly as it was**.
- Writes are atomic (temp file + rename), so an interrupted write cannot truncate a
  document.
- The server refuses to be pointed at a `.lol` file.

## 5. Format

The full format contract lives in the repository root `AGENTS.md`. In one line:

```json
{
  "meta":    { "project": "…", "geometry": "…", "note": "…" },
  "palette": ["#1a1a2e", "#e94560"],
  "layers":  [
    { "name": "тело", "folder": "герой",
      "bbox": { "minCol": 0, "minRow": 0, "maxCol": 6, "maxRow": 6 },
      "rows": ["..111..", ".11111.", "1222221"] }
  ]
}
```

`layers[0]` is the **topmost** layer. `"."` is an empty cell, `"0"`–`"9"` are
`palette[0..9]`, `"a"`–`"z"` are `palette[10..35]`. Maximum **36** colours.

## 6. Files here

| File | What it is |
|---|---|
| `server.js` | The whole server. Plain Node, no dependencies. |
| `canvas.ai.json` | A small example document, so the server runs out of the box. |
| `README.md` | This file. |
