#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * pixelol-ai — MCP server for the Pixelol pixel-art editor (Level 1, file mode)
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 *   A real Model Context Protocol server (JSON-RPC 2.0 over stdio) that lets any
 *   MCP client (Claude Code, Claude Desktop, Cursor, ...) read and edit a Pixelol
 *   canvas through three tools: get_canvas_state, draw_run, add_layer.
 *   Spec: pixelol-ai-adaptation.md §6.1 ("Уровень 1 — локальный MCP-сервер").
 *
 * TRANSPORT
 *   stdio, newline-delimited JSON-RPC 2.0 messages, exactly as the MCP stdio
 *   transport requires: one JSON object per line, no embedded newlines, nothing
 *   on stdout except protocol messages (all logging goes to stderr).
 *
 * TWO TRANSPORTS, ONE SET OF TOOLS (--live)
 *   File mode (default): the tools read and write the AI-JSON file below, and
 *   the human brings it home by hand.
 *   Live mode (--live): the same three tools additionally talk to an OPEN
 *   Pixelol tab over a local WebSocket (see live.js, protocol v1). What the
 *   agent sees is what the human sees, and every write is pushed to the tab as
 *   it is made, so the strokes appear on the canvas while they are drawn.
 *   In live mode the page is the authority: the server reads the current
 *   document from the tab before each call and asks the tab whether it applied
 *   the result. A tab that rejects the document makes the server roll its file
 *   back byte-for-byte, so file and canvas can never drift apart silently.
 *
 * STATE FILE
 *   One plain JSON file on disk — the very same document the «Экспорт для ИИ»
 *   button in index.html downloads. The user presses that button once per
 *   session, points this server at the downloaded file, works through the agent,
 *   then presses «Импорт от ИИ» and picks the same file. index.html is never
 *   touched at runtime, so the "single HTML file, zero dependencies" promise of
 *   the app stays intact.
 *
 * FORMAT CONTRACT (byte-for-byte the format implemented in index.html)
 *   Document = { meta:{project,geometry,note}, palette:[hex,...], layers:[...] }
 *     palette : array of "#rgb" / "#rrggbb" strings, MAX 36 entries.
 *               Index 0 is the character '0', index 35 is the character 'z'.
 *     layers  : array, TOPMOST FIRST (layers[0] is the top layer, exactly like
 *               the layer panel and exactly like the app's export).
 *     layer   : { name, folder, bbox:{minCol,minRow,maxCol,maxRow}|null, rows:[...] }
 *               folder = folder name or null. Empty layer => bbox null, rows [].
 *               rows[r][c] is the character at (col = bbox.minCol + c,
 *               row = bbox.minRow + r). All rows have equal length.
 *     grid characters: '.' = empty cell, '0'-'9' = palette[0..9],
 *               'a'-'z' = palette[10..35]. Import is case-insensitive
 *               ('A' reads as index 10); export is always lowercase.
 *   validateDocumentText() below mirrors _aiValidateJSON() in index.html
 *   condition for condition, including its notes, so a document this server
 *   accepts is exactly a document «Импорт от ИИ» accepts.
 *
 * HARD RULES
 *   - Never writes a document that failed validation.
 *   - Never touches .lol files and never invents fields index.html cannot read.
 *   - Zero dependencies: Node built-ins only, no package.json, no npm install.
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const { startLiveServer } = require('./live.js');

const SERVER_NAME = 'pixelol-ai';
const SERVER_VERSION = '1.1.0';   // 1.1.0 adds the live WebSocket transport (--live)

// MCP protocol revisions this server speaks. On initialize we echo the client's
// revision when we know it, otherwise we answer with our own latest.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

// ─── Format constants (must stay identical to the AI block in index.html) ─────
const AI_INDEX_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'; // base-36, always lowercase
const AI_INDEX_MAX = AI_INDEX_ALPHABET.length;                    // 36
const AI_CELL_EMPTY = '.';
const AI_MAX_GRID_SIDE = 1024;
const AI_HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const AI_NOTE = 'col/row — логические координаты сетки; холст без границ, хранится только bbox каждого слоя';
const DEFAULT_GEOMETRY = '45deg-rotated-square, symmetric 1:1; wx=(col-row)*step; wy=(col+row)*step';
const DEFAULT_PROJECT = 'pixelol_project';

function aiIndexValue(ch) {
  return AI_INDEX_ALPHABET.indexOf(String(ch).toLowerCase());
}

// ─── Errors ──────────────────────────────────────────────────────────────────
// ToolError = the call failed in a way the agent can fix (bad arguments, bad
// document, missing file). It is reported as a tool result with isError:true,
// per the MCP tools specification — not as a JSON-RPC protocol error.
class ToolError extends Error {}

function toolFail(msg) { return { ok: false, error: msg }; }

// ─── Validation (mirror of _aiValidateJSON in index.html) ─────────────────────
function validatePalette(rawPalette) {
  if (!Array.isArray(rawPalette)) return toolFail('Missing "palette" array (list of "#rgb" or "#rrggbb" strings).');
  if (rawPalette.length > AI_INDEX_MAX) {
    return toolFail('Palette has ' + rawPalette.length + ' colors, maximum is ' + AI_INDEX_MAX + '.');
  }
  const palette = [];
  for (let i = 0; i < rawPalette.length; i++) {
    const c = rawPalette[i];
    if (typeof c !== 'string' || !AI_HEX_RE.test(c.trim())) {
      return toolFail('palette[' + i + '] = ' + JSON.stringify(c) + ' — expected a color like #rgb or #rrggbb.');
    }
    palette.push(c.trim());
  }
  return { ok: true, palette: palette };
}

// Validates one index grid and returns its cells as Map<"col,row", paletteIndex>.
// `label` is only used in error messages. Mirrors the layer half of
// _aiValidateJSON, including its bbox notes (a bbox that disagrees with rows is
// a NOTE, not an error: rows win and the grid is anchored at 0,0 — same as the app).
// `strictBbox` is used by the patch paths (draw_run edits, add_layer): there a
// bbox is an instruction ("paint at this origin"), so a malformed or disagreeing
// bbox is a hard error instead of a silent relocation of the pixels.
function validateGrid(rowsRaw, bboxRaw, paletteLen, label, strictBbox) {
  const notes = [];
  if (!Array.isArray(rowsRaw)) return toolFail('Layer ' + label + ': missing "rows" array.');
  for (let r = 0; r < rowsRaw.length; r++) {
    if (typeof rowsRaw[r] !== 'string') return toolFail('Layer ' + label + ': rows[' + r + '] is not a string.');
  }
  if (rowsRaw.length === 0) {
    // The app ignores bbox on an empty layer and writes bbox:null, rows:[].
    // In a patch a bbox is an instruction ("paint at this origin"), so silently
    // dropping it would be the one case where the agent gets a different answer
    // than it asked for — say so instead.
    if (strictBbox && bboxRaw !== undefined && bboxRaw !== null) {
      return toolFail('Layer ' + label + ': rows is empty, so there is nothing to anchor — an empty layer is ' +
        '{"bbox":null,"rows":[]}. Omit "bbox", or paint with a non-empty "rows".');
    }
    return { ok: true, empty: true, cells: new Map(), notes: notes };
  }

  const w = rowsRaw[0].length;
  if (w === 0) return toolFail('Layer ' + label + ': rows are empty strings.');
  for (let r = 1; r < rowsRaw.length; r++) {
    if (rowsRaw[r].length !== w) {
      return toolFail('Layer ' + label + ': all rows must have the same length (row ' + r + ' is ' +
        rowsRaw[r].length + ' characters, expected ' + w + ').');
    }
  }
  if (w > AI_MAX_GRID_SIDE || rowsRaw.length > AI_MAX_GRID_SIDE) {
    return toolFail('Layer ' + label + ': grid ' + w + '×' + rowsRaw.length + ' is too large (limit ' +
      AI_MAX_GRID_SIDE + '×' + AI_MAX_GRID_SIDE + ').');
  }

  let minCol = 0, minRow = 0;
  const bb = bboxRaw;
  if (bb && typeof bb === 'object' && !Array.isArray(bb)) {
    const nums = ['minCol', 'minRow', 'maxCol', 'maxRow'].map(k => {
      const v = bb[k];
      return (typeof v === 'number') ? v : ((typeof v === 'string' && v.trim() !== '') ? +v : NaN);
    });
    const whole = nums.every(n => Number.isFinite(n) && Math.abs(n - Math.trunc(n)) < 1e-9);
    const ordered = nums[2] >= nums[0] && nums[3] >= nums[1];
    const fits = nums[2] - nums[0] + 1 === w && nums[3] - nums[1] + 1 === rowsRaw.length;
    if (whole && ordered && fits) {
      minCol = nums[0]; minRow = nums[1];
    } else if (strictBbox) {
      if (!whole || !ordered) {
        return toolFail('Layer ' + label + ': malformed bbox ' + JSON.stringify(bb) +
          ' — minCol/minRow/maxCol/maxRow must be integers with maxCol >= minCol and maxRow >= minRow, ' +
          'or omit bbox entirely to anchor the grid at 0,0.');
      }
      return toolFail('Layer ' + label + ': bbox ' + JSON.stringify(bb) + ' does not match the ' + w + '×' +
        rowsRaw.length + ' rows (expected maxCol = minCol + ' + (w - 1) + ', maxRow = minRow + ' +
        (rowsRaw.length - 1) + '). Paint the padding into the rows, or drop the bbox to anchor at 0,0.');
    } else if (whole && ordered) {
      // Same note the app produces for a well-formed bbox that disagrees with rows.
      notes.push('Layer ' + label + ': bbox does not match the ' + w + '×' + rowsRaw.length +
        ' grid — original coordinates {minCol:' + nums[0] + ', minRow:' + nums[1] +
        ', maxCol:' + nums[2] + ', maxRow:' + nums[3] + '} were ignored, grid anchored at 0,0.');
    } else {
      notes.push('Layer ' + label + ': bbox is malformed — coordinates derived from rows (origin 0,0).');
    }
  } else if (bb !== undefined && bb !== null) {
    if (strictBbox) {
      return toolFail('Layer ' + label + ': bbox must be an object with minCol/minRow/maxCol/maxRow ' +
        '(or omit it to anchor the grid at 0,0).');
    }
    notes.push('Layer ' + label + ': bbox is not an object — coordinates derived from rows (origin 0,0).');
  } else if (bb === null && strictBbox) {
    return toolFail('Layer ' + label + ': bbox is null but rows is not empty — a painted layer needs a bbox ' +
      '(a null bbox means an empty layer, whose rows must be []).');
  }

  const cells = new Map();
  for (let r = 0; r < rowsRaw.length; r++) {
    const line = rowsRaw[r];
    for (let c = 0; c < w; c++) {
      const ch = line[c];
      if (ch === AI_CELL_EMPTY) continue;
      const idx = aiIndexValue(ch);
      if (idx < 0) {
        return toolFail('Layer ' + label + ', row ' + r + ', column ' + c + ': character "' + ch +
          '" is not allowed — only "." or digits 0-9 and letters a-z.');
      }
      if (idx >= paletteLen) {
        return toolFail('Layer ' + label + ', row ' + r + ', column ' + c + ': index ' + idx +
          ' is outside the palette (palette has ' + paletteLen + ' colors).');
      }
      cells.set((c + minCol) + ',' + (r + minRow), idx);
    }
  }
  return { ok: true, empty: false, cells: cells, notes: notes, width: w, height: rowsRaw.length,
           minCol: minCol, minRow: minRow };
}

// Full-document validation. Returns {ok, doc, notes} with doc already canonical:
// meta filled in, layers rebuilt as {name, folder, bbox, rows} with a bbox that
// always agrees with rows, so the file the server writes imports 1:1.
function validateDocumentText(text) {
  if (typeof text !== 'string' || !text.trim()) return toolFail('Empty document.');
  let raw;
  try { raw = JSON.parse(text); }
  catch (err) { return toolFail('Could not parse JSON: ' + (err && err.message ? err.message : err)); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return toolFail('Expected a JSON object with keys meta / palette / layers.');
  }

  const pal = validatePalette(raw.palette);
  if (!pal.ok) return pal;
  const palette = pal.palette;

  if (raw.layers !== undefined && !Array.isArray(raw.layers)) return toolFail('Field "layers" must be an array.');
  const rawLayers = Array.isArray(raw.layers) ? raw.layers : [];
  const notes = [];
  const layers = [];
  for (let li = 0; li < rawLayers.length; li++) {
    const ld = rawLayers[li];
    if (!ld || typeof ld !== 'object' || Array.isArray(ld)) return toolFail('layers[' + li + '] — expected a layer object.');
    const name = (typeof ld.name === 'string' && ld.name.trim()) ? ld.name.trim() : ('Слой ' + (li + 1));
    const folder = (typeof ld.folder === 'string' && ld.folder.trim()) ? ld.folder.trim() : null;
    const label = '"' + name + '"';

    const g = validateGrid(ld.rows, ld.bbox, palette.length, label);
    if (!g.ok) return g;
    for (const n of g.notes) notes.push(n);
    layers.push(encodeLayer(name, folder, g.cells));
  }

  return { ok: true, doc: { meta: canonicalMeta(raw.meta), palette: palette, layers: layers }, notes: notes };
}

function canonicalMeta(meta) {
  const m = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : {};
  return {
    project: (typeof m.project === 'string' && m.project.trim()) ? m.project : DEFAULT_PROJECT,
    geometry: (typeof m.geometry === 'string' && m.geometry.trim()) ? m.geometry : DEFAULT_GEOMETRY,
    note: (typeof m.note === 'string' && m.note.trim()) ? m.note : AI_NOTE,
  };
}

// cells (Map<"col,row", paletteIndex>) -> the app's layer shape, with the same
// tight bbox _aiSerializeLayer computes in index.html.
function encodeLayer(name, folder, cells) {
  if (cells.size === 0) return { name: name, folder: folder, bbox: null, rows: [] };
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const key of cells.keys()) {
    const comma = key.indexOf(',');
    const col = +key.slice(0, comma), row = +key.slice(comma + 1);
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
  }
  const w = maxCol - minCol + 1, h = maxRow - minRow + 1;
  if (w > AI_MAX_GRID_SIDE || h > AI_MAX_GRID_SIDE) {
    throw new ToolError('Layer "' + name + '" grew to ' + w + '×' + h + ' cells (limit ' +
      AI_MAX_GRID_SIDE + '×' + AI_MAX_GRID_SIDE + ').');
  }
  const grid = new Array(h);
  for (let r = 0; r < h; r++) grid[r] = new Array(w).fill(AI_CELL_EMPTY);
  for (const entry of cells) {
    const comma = entry[0].indexOf(',');
    grid[+entry[0].slice(comma + 1) - minRow][+entry[0].slice(0, comma) - minCol] = AI_INDEX_ALPHABET[entry[1]];
  }
  return {
    name: name, folder: folder,
    bbox: { minCol: minCol, minRow: minRow, maxCol: maxCol, maxRow: maxRow },
    rows: grid.map(r => r.join('')),
  };
}

function decodeLayerCells(layer, paletteLen, label) {
  const g = validateGrid(layer.rows, layer.bbox, paletteLen, label);
  if (!g.ok) throw new ToolError(g.error);
  return g;
}

// ─── File I/O ────────────────────────────────────────────────────────────────
function readCanvasFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ToolError('File not found: ' + file + '. Create it first: open Pixelol, press «Экспорт для ИИ» ' +
        '(⬇ button), click «⬇ Скачать .json», save the file to that path, then call get_canvas_state again.');
    }
    throw new ToolError('Cannot read ' + file + ': ' + err.message);
  }
  const v = validateDocumentText(text);
  if (!v.ok) {
    throw new ToolError('The file ' + file + ' is not a valid Pixelol AI-JSON document: ' + v.error +
      ' Nothing was written. Fix the document (re-export it from Pixelol with «Экспорт для ИИ») and retry.');
  }
  return v;
}

function writeCanvasFile(file, doc) {
  const text = JSON.stringify(doc, null, 2) + '\n';
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);   // atomic: a crash never leaves half a document behind
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    throw new ToolError('Cannot write ' + file + ': ' + err.message);
  }
}

// Raw bytes of the file, or null when it does not exist. Used only to restore
// the exact previous content if the attached page rejects what we wrote.
function readFileRaw(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw new ToolError('Cannot read ' + file + ': ' + err.message); }
}

function writeFileRaw(file, text) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    throw new ToolError('Cannot restore ' + file + ': ' + err.message);
  }
}

function countPixels(layers) {
  let n = 0;
  for (const l of layers) {
    if (!l.rows.length) continue;
    for (const row of l.rows) for (const ch of row) if (ch !== AI_CELL_EMPTY) n++;
  }
  return n;
}

function layerSummary(layers) {
  return layers.map((l, i) => i + ':' + l.name).join(', ');
}

// ─── Tools ───────────────────────────────────────────────────────────────────
async function toolGetCanvasState() {
  const v = await loadCanvasState();
  if (v.notes.length) log('notes: ' + v.notes.join(' | '));
  let out = JSON.stringify(v.doc, null, 2);
  if (v.source === 'page') {
    out += '\n\n// read live from the attached Pixelol tab — this is exactly what the human sees right now.';
  }
  return textResult(out);
}

async function toolDrawRun(args) {
  const hasDocument = args.document !== undefined;
  const hasEdits = args.edits !== undefined;
  if (hasDocument === hasEdits) {
    throw new ToolError('Provide exactly one of "document" (a full AI-JSON document, same shape «Импорт от ИИ» ' +
      'accepts) or "edits" (an array of targeted layer patches).');
  }
  if (args.palette !== undefined && hasDocument) {
    throw new ToolError('"palette" alongside "document" is redundant: a full document already carries its own palette.');
  }

  if (hasDocument) {
    const docText = typeof args.document === 'string' ? args.document : JSON.stringify(args.document);
    const v = validateDocumentText(docText);
    if (!v.ok) throw new ToolError('Document rejected, file left untouched: ' + v.error);
    const beforeText = readFileRaw(STATE_FILE);
    writeCanvasFile(STATE_FILE, v.doc);
    const live = await pushToTab(v.doc, 'draw_run');
    if (live.status === 'rejected') {
      rollbackFile(beforeText, 'draw_run');
      throw new ToolError('The open Pixelol tab rejected this document, so nothing was changed anywhere: ' +
        live.message + '\nThe file was restored to its previous content. Ask the human what the tab says, or ' +
        'reconnect it (reload the page) and retry with a smaller, correct document.');
    }
    return textResult('✓ draw_run: full document written.' + notesBlock(v.notes) +
      summaryBlock(v.doc, 'whole canvas') + liveStatusLine(live, 'draw_run'));
  }

  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    throw new ToolError('"edits" must be a non-empty array of patch objects.');
  }
  const current = await loadCanvasState();
  const doc = current.doc;
  const notes = current.notes.slice();
  applyPaletteExtension(doc, args.palette);
  const before = countPixels(doc.layers);

  const changed = [];
  args.edits.forEach((edit, ei) => {
    const where = 'edits[' + ei + ']';
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new ToolError(where + ' — expected an object.');
    const op = edit.op === undefined ? 'merge' : edit.op;
    if (['merge', 'replace', 'clear'].indexOf(op) < 0) {
      throw new ToolError(where + '.op must be "merge", "replace" or "clear" (got ' + JSON.stringify(edit.op) + ').');
    }
    const { layer, index } = resolveLayer(doc, edit.target, where + '.target');
    const label = '"' + layer.name + '"';

    if (op === 'clear') {
      doc.layers[index] = encodeLayer(layer.name, layer.folder, new Map());
      changed.push({ index: index, name: layer.name, op: op });
      return;
    }
    if (edit.rows === undefined) throw new ToolError(where + '.rows is required for op "' + op + '".');
    const g = validateGrid(edit.rows, edit.bbox, doc.palette.length, label + ' (patch)', true);
    if (!g.ok) throw new ToolError(where + ' rejected, file left untouched: ' + g.error);
    for (const n of g.notes) notes.push(where + ': ' + n);

    const cells = (op === 'replace') ? new Map() : decodeLayerCells(layer, doc.palette.length, label + ' (existing)').cells;
    g.cells.forEach((idx, key) => { cells.set(key, idx); });
    doc.layers[index] = encodeLayer(layer.name, layer.folder, cells);
    changed.push({ index: index, name: layer.name, op: op, painted: g.cells.size });
  });

  // Final guard: what we are about to write must still be a valid document.
  const finalCheck = validateDocumentText(JSON.stringify(doc));
  if (!finalCheck.ok) throw new ToolError('Internal check failed, file left untouched: ' + finalCheck.error);
  const beforeText = readFileRaw(STATE_FILE);
  writeCanvasFile(STATE_FILE, finalCheck.doc);
  const live = await pushToTab(finalCheck.doc, 'draw_run');
  if (live.status === 'rejected') {
    rollbackFile(beforeText, 'draw_run');
    throw new ToolError('The open Pixelol tab rejected the result of these edits, so nothing was changed anywhere: ' +
      live.message + '\nThe file was restored to its previous content. Reconnect the tab (reload the page) and retry.');
  }

  const lines = changed.map(c => '  · [' + c.index + '] ' + c.name + ' — ' + c.op +
    (c.painted === undefined ? '' : ', ' + c.painted + ' cells painted') + '\n' + indentRows(finalCheck.doc.layers[c.index].rows, 4));
  return textResult('✓ draw_run: ' + args.edits.length + ' edit(s) applied.\n' + lines.join('\n') +
    summaryBlock(finalCheck.doc, 'pixels ' + before + ' → ' + countPixels(finalCheck.doc.layers)) +
    notesBlock(notes) + liveStatusLine(live, 'draw_run'));
}

async function toolAddLayer(args) {
  const current = await loadCanvasState();
  const doc = current.doc;
  const notes = current.notes.slice();
  applyPaletteExtension(doc, args.palette);

  const pos = (args.index === undefined || args.index === null) ? 0 : args.index;
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.layers.length) {
    throw new ToolError('"index" must be an integer between 0 and ' + doc.layers.length +
      ' (0 = topmost layer, as in the document).');
  }
  const name = (typeof args.name === 'string' && args.name.trim()) ? args.name.trim()
    : ('Слой ' + (doc.layers.length + 1));
  let folder = null;
  if (typeof args.folder === 'string' && args.folder.trim()) folder = args.folder.trim();

  let cells = new Map();
  if (args.rows !== undefined) {
    const g = validateGrid(args.rows, args.bbox, doc.palette.length, '"' + name + '" (new layer)', true);
    if (!g.ok) throw new ToolError('New layer rejected, file left untouched: ' + g.error);
    for (const n of g.notes) notes.push(n);
    cells = g.cells;
  } else if (args.bbox !== undefined) {
    throw new ToolError('"bbox" without "rows" makes no sense — an empty layer is bbox:null, rows:[] in this format.');
  }

  doc.layers.splice(pos, 0, encodeLayer(name, folder, cells));
  const finalCheck = validateDocumentText(JSON.stringify(doc));
  if (!finalCheck.ok) throw new ToolError('Internal check failed, file left untouched: ' + finalCheck.error);
  const beforeText = readFileRaw(STATE_FILE);
  writeCanvasFile(STATE_FILE, finalCheck.doc);
  const live = await pushToTab(finalCheck.doc, 'add_layer');
  if (live.status === 'rejected') {
    rollbackFile(beforeText, 'add_layer');
    throw new ToolError('The open Pixelol tab rejected the new layer, so nothing was changed anywhere: ' +
      live.message + '\nThe file was restored to its previous content. Reconnect the tab and retry.');
  }

  return textResult('✓ add_layer: created "' + name + '"' + (folder ? ' in folder "' + folder + '"' : ' (no folder)') +
    ' at index ' + pos + ' (0 = topmost).\n' + indentRows(finalCheck.doc.layers[pos].rows, 2) +
    summaryBlock(finalCheck.doc, 'new layer') + notesBlock(notes) + liveStatusLine(live, 'add_layer'));
}

// Optional palette extension: append-only. Existing indices must keep their
// colour, otherwise every already-painted index character would silently
// repaint — for that case the agent must send a full "document" instead.
function applyPaletteExtension(doc, paletteArg) {
  if (paletteArg === undefined) return;
  const v = validatePalette(paletteArg);
  if (!v.ok) throw new ToolError('"palette" rejected: ' + v.error);
  if (v.palette.length < doc.palette.length) {
    throw new ToolError('"palette" must not shrink (file has ' + doc.palette.length +
      ' colors). Send a full "document" if you want to remove colors.');
  }
  for (let i = 0; i < doc.palette.length; i++) {
    if (v.palette[i].toLowerCase() !== doc.palette[i].toLowerCase()) {
      throw new ToolError('"palette" may only append: entry ' + i + ' is "' + v.palette[i] +
        '" but the file already uses "' + doc.palette[i] + '". Send a full "document" to reorder colors.');
    }
  }
  doc.palette = v.palette;
}

function resolveLayer(doc, target, where) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new ToolError(where + ' is required: {"layer":"name"} or {"index":0}.');
  }
  const byName = target.layer, byIndex = target.index;
  if (byName !== undefined && byIndex !== undefined) {
    throw new ToolError(where + ': use either "layer" or "index", not both.');
  }
  if (byIndex !== undefined) {
    if (!Number.isInteger(byIndex) || byIndex < 0 || byIndex >= doc.layers.length) {
      throw new ToolError(where + '.index ' + JSON.stringify(byIndex) + ' is out of range — the document has ' +
        doc.layers.length + ' layer(s) (indices 0..' + (doc.layers.length - 1) + ').');
    }
    return { layer: doc.layers[byIndex], index: byIndex };
  }
  if (typeof byName === 'string' && byName.trim()) {
    const hits = doc.layers.map((l, i) => ({ l: l, i: i })).filter(x => x.l.name === byName.trim());
    if (hits.length === 1) return { layer: hits[0].l, index: hits[0].i };
    if (hits.length === 0) {
      throw new ToolError(where + '.layer: no layer named "' + byName + '". Available layers: ' +
        (layerSummary(doc.layers) || '(none)') + '.');
    }
    throw new ToolError(where + '.layer: "' + byName + '" is ambiguous — found at indices ' +
      hits.map(h => h.i).join(', ') + '. Use "index" instead.');
  }
  throw new ToolError(where + ' must be {"layer":"name"} or {"index":0}.');
}

function indentRows(rows, indent) {
  if (!rows || rows.length === 0) return '    (empty layer — bbox: null, rows: [])';
  const pad = ' '.repeat(indent);
  return rows.map(r => pad + r).join('\n');
}

function summaryBlock(doc, extra) {
  return '\nDocument: ' + doc.layers.length + ' layer(s), ' + doc.palette.length + ' color(s), ' +
    countPixels(doc.layers) + ' painted cell(s). ' + (extra || '') + '\n' +
    'Layers (index:name, 0 = topmost): ' + (layerSummary(doc.layers) || '(none)') + '\n' +
    'File: ' + STATE_FILE;
}

function notesBlock(notes) {
  if (!notes || notes.length === 0) return '';
  return '\nNotes:\n' + notes.map(n => '  ! ' + n).join('\n');
}

// ─── Live bridge: where the document comes from, and where it goes ───────────
// File mode (the default, and always when no tab is attached): the file, exactly
// as before. Live mode: the open tab, because the human has been drawing with
// the mouse and the file cannot know about that. If the tab does not answer in
// time we fall back to the file rather than guessing.
async function loadCanvasState() {
  if (LIVE && LIVE.hub.attached()) {
    const text = await LIVE.hub.pull();
    if (text !== null && String(text).trim() !== '') {
      const v = validateDocumentText(String(text));
      if (!v.ok) {
        throw new ToolError('The attached Pixelol tab returned something that is not a valid AI-JSON document ' +
          '(' + v.error + '). Nothing was changed. Reconnect the tab (reload the page) and try again.');
      }
      v.source = 'page';
      return v;
    }
    log('live: the attached tab did not answer, using the file instead');
  }
  const v = readCanvasFile(STATE_FILE);
  v.source = 'file';
  return v;
}

// Hand a finished document to the open tab and wait for its verdict.
// Returns {status, message} — see live.js. Never throws: a live problem must
// not take the file-mode tool with it, except that a REJECTION is reported to
// the caller so it can restore the file.
async function pushToTab(doc, origin) {
  if (!LIVE) return { status: 'no-live', message: '' };
  try {
    return await LIVE.hub.push(doc, origin);
  } catch (err) {
    log('live push failed: ' + (err && err.message ? err.message : err));
    return { status: 'error', message: 'live push failed: ' + (err && err.message ? err.message : err) };
  }
}

function liveStatusLine(result, toolName) {
  switch (result.status) {
    case 'applied':
      return '\nLive: the open tab applied it — the human is watching it appear on the canvas.';
    case 'proposed':
      return '\nLive: the tab validated the document but is NOT applying changes automatically. The human has to ' +
        'confirm it there. Tell them to look at the Pixelol window.';
    case 'no-page':
      return '\nLive: no Pixelol tab is attached, so only the file changed. The human presses «Импорт от ИИ» to see it.';
    case 'no-live':
      return '\nLive: this server runs in file mode (it was started without --live), so only the file changed — the ' +
        'human presses «Импорт от ИИ» to see it. Start it with --live to drive an open tab instead.';
    case 'rejected':
      return '\nLive: THE TAB REFUSED the document — ' + (result.message || 'no reason given');
    case 'timeout':
      return '\nLive: the tab did not answer in time — the file changed, but the canvas may not have. Ask the human ' +
        'to check the window, or reload it.';
    case 'detached':
      return '\nLive: the tab closed while the change was in flight — the file changed, the canvas may not have.';
    default:
      return '\nLive: ' + (result.message || result.status);
  }
}

// Restore the file byte-for-byte after the attached tab refused the document.
function rollbackFile(beforeText, toolName) {
  if (beforeText === null) {
    // The file did not exist before this call and we created it; removing it
    // restores the previous state exactly. Nothing of the user's is lost.
    try { fs.unlinkSync(STATE_FILE); } catch (e) { /* already gone */ }
    return;
  }
  writeFileRaw(STATE_FILE, beforeText);
}

function textResult(text) {
  return { content: [{ type: 'text', text: text }], isError: false };
}
function errorResult(text) {
  return { content: [{ type: 'text', text: '✗ ' + text }], isError: true };
}

// ─── Tool declarations for tools/list ────────────────────────────────────────
const BBOX_SCHEMA = {
  type: 'object',
  description: 'Origin of the rows grid. Must agree with the rows size: (maxCol-minCol+1) = rows[0].length ' +
    'and (maxRow-minRow+1) = rows.length. If it disagrees, rows win and the grid is anchored at 0,0.',
  properties: {
    minCol: { type: 'integer' }, minRow: { type: 'integer' },
    maxCol: { type: 'integer' }, maxRow: { type: 'integer' },
  },
  required: ['minCol', 'minRow', 'maxCol', 'maxRow'],
  additionalProperties: false,
};
const ROWS_SCHEMA = {
  type: 'array',
  description: 'Index grid, one string per row, all strings the same length. "." = empty cell, "0".."9" = ' +
    'palette[0..9], "a".."z" = palette[10..35] (uppercase is accepted on import). rows[r][c] is the cell at ' +
    'col = bbox.minCol + c, row = bbox.minRow + r. Empty array = empty layer.',
  items: { type: 'string' },
};
const PALETTE_SCHEMA = {
  type: 'array',
  description: 'Optional append-only palette: existing entries must stay identical, new colors are appended ' +
    '(their index characters follow the base-36 scheme, e.g. 4 colours + 1 new = "4"). To reorder or remove ' +
    'colors, send a full "document" to draw_run instead.',
  items: { type: 'string', description: 'CSS hex color, #rgb or #rrggbb.' },
  maxItems: AI_INDEX_MAX,
};

const TOOLS = [
  {
    name: 'get_canvas_state',
    title: 'Get canvas state',
    description: 'Read-only. Returns the current Pixelol AI-JSON document exactly as «Импорт от ИИ» expects it: ' +
      '{meta, palette, layers}. Layers are topmost first (layers[0] = top layer). Grid characters: "." = empty, ' +
      '"0".."9" = palette[0..9], "a".."z" = palette[10..35] (max 36 colors). Call this first in every session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'draw_run',
    title: 'Draw / modify the canvas',
    description: 'Writes a modification into the AI-JSON file. Two mutually exclusive modes:\n' +
      '(1) "document" — a full AI-JSON document ({meta, palette, layers}) in the exact shape «Импорт от ИИ» accepts; ' +
      'the file is replaced wholesale. Take get_canvas_state, edit it, send it back.\n' +
      '(2) "edits" — targeted patches that keep everything else untouched: [{target:{layer|index}, op:"merge"|' +
      '"replace"|"clear", bbox?, rows?}]. "merge" paints every non-"." cell of the patch onto the layer (cells not ' +
      'mentioned keep their colour); "replace" discards the layer and paints the patch only; "clear" empties the ' +
      'layer. Prefer "merge" when drawing on top of existing art.\n' +
      'Optionally append "palette" colors (append-only) so the patch can use a new index character.\n' +
      'The result is validated with the same rules as the app before anything is written; on any error the file on ' +
      'disk is left exactly as it was.',
    inputSchema: {
      type: 'object',
      properties: {
        document: {
          type: 'object',
          description: 'Mode 1. Full AI-JSON document to write to the file.',
          properties: {
            meta: { type: 'object', description: 'Informational only; the app ignores it on import. ' +
              '{project, geometry, note}.', additionalProperties: true },
            palette: { type: 'array', description: 'Colors, max 36, "#rgb" or "#rrggbb".',
              items: { type: 'string' }, maxItems: AI_INDEX_MAX },
            layers: { type: 'array', description: 'Layers, TOPMOST FIRST (layers[0] = top layer).',
              items: { type: 'object',
                properties: {
                  name: { type: 'string' },
                  folder: { type: ['string', 'null'], description: 'Folder name, or null for no folder.' },
                  bbox: { oneOf: [BBOX_SCHEMA, { type: 'null' }], description: 'null for an empty layer.' },
                  rows: ROWS_SCHEMA,
                },
                required: ['rows'],
                additionalProperties: false } },
          },
          required: ['palette'],
          additionalProperties: false,
        },
        edits: {
          type: 'array',
          description: 'Mode 2. Ordered list of layer patches, applied in sequence.',
          items: {
            type: 'object',
            properties: {
              target: { type: 'object', description: 'Which layer to patch: {"index":0} or {"layer":"тело"}. ' +
                'Exactly one of the two.',
                properties: { layer: { type: 'string' }, index: { type: 'integer', minimum: 0 } },
                additionalProperties: false },
              op: { type: 'string', enum: ['merge', 'replace', 'clear'],
                description: 'merge = paint the patch over the existing art (default); replace = discard the ' +
                  'layer first; clear = empty the layer (rows not needed).' },
              bbox: BBOX_SCHEMA,
              rows: ROWS_SCHEMA,
            },
            required: ['target'],
            additionalProperties: false,
          },
        },
        palette: PALETTE_SCHEMA,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'add_layer',
    title: 'Add a layer',
    description: 'Inserts a new layer into the document, optionally already painted. "name" defaults to "Слой N", ' +
      '"folder" to no folder, "index" to 0 (the new layer becomes the topmost one, matching the document order). ' +
      'Pass "rows"/"bbox" to create it with pixels; omit them for an empty layer (written as bbox:null, rows:[]). ' +
      'Optionally append "palette" colors so the rows can use a new index character.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Layer name, free text (e.g. "тело", "волосы").' },
        folder: { type: ['string', 'null'], description: 'Folder name, or null / omit for no folder.' },
        index: { type: 'integer', minimum: 0, description: 'Insert position; 0 = topmost. Default 0.' },
        bbox: BBOX_SCHEMA,
        rows: ROWS_SCHEMA,
        palette: PALETTE_SCHEMA,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

// tools/list answers with the static declarations plus one honest line about the
// transport the server is actually in right now. The declarations themselves
// never change, so a client can cache the schemas.
function toolList() {
  const liveNote = LIVE
    ? '\n\nLIVE MODE IS ON (ws://127.0.0.1:' + LIVE.port + '): get_canvas_state reads the attached Pixelol tab, and ' +
      'draw_run / add_layer are pushed to that tab and reported as applied / proposed / rejected. A rejected ' +
      'document is not written anywhere.'
    : '\n\nThis server runs in FILE mode: it edits ' + STATE_FILE + ' and waits for the human to press ' +
      '«Импорт от ИИ». Start it with --live to drive an open Pixelol tab instead.';
  return TOOLS.map(t => Object.assign({}, t, { description: t.description + liveNote }));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function usage() {
  return [
    'pixelol-ai ' + SERVER_VERSION + ' — MCP server for Pixelol (Level 1: file mode, or live mode)',
    '',
    'Usage: node server.js [--file <path/to/canvas.ai.json>] [--live [--port <n>] [--serve [dir]]]',
    '',
    'Options:',
    '  --file <path>   AI-JSON file to read and write. Default: ./canvas.ai.json next to this script.',
    '                  Also settable with the PIXELOL_AI_FILE environment variable.',
    '  --live          Also listen for an open Pixelol tab on a local WebSocket (ws://127.0.0.1:8765),',
    '                  so the same tools drive the canvas live and the human watches every stroke.',
    '  --port <n>      WebSocket / HTTP port for --live. Default: 8765. 127.0.0.1 only, never 0.0.0.0.',
    '  --serve [dir]   With --live: also serve that folder over http://127.0.0.1:<port>/ so the page can',
    '                  be opened over http (a file:// tab may be blocked from opening a WebSocket).',
    '                  Default folder: the repository root (the parent of this script).',
    '  --help          Print this help and exit.',
    '  --version       Print the version and exit.',
    '',
    'The file is the document produced by «Экспорт для ИИ» in Pixelol (⬇ button → «⬇ Скачать .json»).',
    'Point your MCP client at this script; see README.md in this folder.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { file: null, live: false, port: null, serve: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') {
      const v = argv[++i];
      if (!v) { fail('--file needs a path'); }
      out.file = v;
    } else if (a.startsWith('--file=')) {
      out.file = a.slice('--file='.length);
    } else if (a === '--live') {
      out.live = true;
    } else if (a === '--port' || a === '-p') {
      const v = argv[++i];
      if (!v) { fail('--port needs a number'); }
      out.port = v;
    } else if (a.startsWith('--port=')) {
      out.port = a.slice('--port='.length);
    } else if (a === '--serve') {
      out.serve = true;
      // Optional value: "--serve" alone serves the repository root, "--serve DIR" serves DIR.
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) { out.serve = argv[++i]; }
    } else if (a.startsWith('--serve=')) {
      out.serve = a.slice('--serve='.length);
      if (out.serve === '') out.serve = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(usage() + '\n'); process.exit(0);
    } else if (a === '--version' || a === '-v') {
      process.stdout.write(SERVER_VERSION + '\n'); process.exit(0);
    } else {
      fail('Unknown argument: ' + a);
    }
  }
  if (out.port !== null) {
    const n = Number(out.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) fail('--port must be an integer between 1 and 65535, got ' + out.port);
    out.port = n;
  }
  if (out.serve && !out.live) {
    fail('--serve only makes sense together with --live (it serves the page that attaches over WebSocket).');
  }
  return out;
}

function fail(msg) {
  process.stderr.write('pixelol-ai: ' + msg + '\n');
  process.exit(2);
}

const ARGS = parseArgs(process.argv.slice(2));
let STATE_FILE = path.resolve(ARGS.file || process.env.PIXELOL_AI_FILE || path.join(__dirname, 'canvas.ai.json'));
if (/\.lol$/i.test(STATE_FILE)) {
  fail('refusing to use a .lol file (' + STATE_FILE + '): this server only handles the AI-JSON exchange format. ' +
    'Point --file at a *.ai.json file.');
}

// ─── Live transport (--live) ─────────────────────────────────────────────────
// LIVE is null in file mode: every tool below then behaves exactly as it did
// before, with no socket, no timeout and no page.
let LIVE = null;

// ─── JSON-RPC / MCP plumbing ─────────────────────────────────────────────────
function log(msg) {
  process.stderr.write('[' + SERVER_NAME + '] ' + msg + '\n');
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result });
}
function replyError(id, code, message, data) {
  const err = { code: code, message: message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: '2.0', id: id === undefined ? null : id, error: err });
}

const INSTRUCTIONS = [
  'Pixelol AI-JSON document: ' + STATE_FILE,
  (LIVE && LIVE.hub.attached())
    ? 'Workflow (LIVE): a Pixelol tab is attached. get_canvas_state reads that tab, so you see exactly what the ' +
      'human sees; draw_run / add_layer are pushed to the canvas as they are made and the human watches them appear. ' +
      'If a tool reports "proposed", the human has not confirmed the change yet in their window.'
    : (LIVE
      ? 'Workflow (live ready, no tab attached): start the Pixelol tab over http://127.0.0.1:' + LIVE.port + ' and ' +
        'press the «🤖 Агент» button there to attach. Until then every call edits the file only.'
      : 'Workflow: the human presses «Экспорт для ИИ» in Pixelol once per session and saves that file; you edit it ' +
        'through get_canvas_state / draw_run / add_layer; the human then presses «Импорт от ИИ» and picks the same file.'),
  'Format: {meta:{project,geometry,note}, palette:["#rrggbb", ...] (max 36), layers:[{name, folder|null, ' +
  'bbox:{minCol,minRow,maxCol,maxRow}|null, rows:[...]}]}. layers[0] is the TOPMOST layer. rows[r][c] is the cell ' +
  'at col=bbox.minCol+c, row=bbox.minRow+r; "." = empty, "0".."9" = palette[0..9], "a".."z" = palette[10..35].',
].join(' ');

let INITIALIZED = false;

function handleRequest(msg) {
  const method = msg.method;
  switch (method) {
    case 'initialize': {
      const asked = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : null;
      const version = (asked && SUPPORTED_PROTOCOL_VERSIONS.indexOf(asked) >= 0) ? asked : LATEST_PROTOCOL_VERSION;
      INITIALIZED = true;
      reply(msg.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
      log('initialize (protocol ' + version + ', file ' + STATE_FILE + ')');
      return;
    }
    case 'ping':
      reply(msg.id, {});
      return;
    case 'tools/list':
      reply(msg.id, { tools: toolList() });
      return;
    case 'tools/call': {
      const params = msg.params || {};
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) {
        replyError(msg.id, -32602, 'Unknown tool: ' + JSON.stringify(params.name) + '. Available: ' +
          TOOLS.map(t => t.name).join(', ') + '.');
        return;
      }
      const args = (params.arguments === undefined || params.arguments === null) ? {} : params.arguments;
      if (typeof args !== 'object' || Array.isArray(args)) {
        replyError(msg.id, -32602, '"arguments" must be an object.');
        return;
      }
      // The tools are async because live mode asks the attached tab for the
      // current canvas and waits for its verdict. In file mode the promises
      // resolve immediately, so nothing about that behaviour changes.
      Promise.resolve()
        .then(() => {
          if (tool.name === 'get_canvas_state') return toolGetCanvasState();
          if (tool.name === 'draw_run') return toolDrawRun(args);
          return toolAddLayer(args);
        })
        .then(result => reply(msg.id, result))
        .catch(err => {
          if (err instanceof ToolError) {
            log('tool ' + tool.name + ' failed: ' + err.message);
            reply(msg.id, errorResult(err.message));
          } else {
            log('tool ' + tool.name + ' crashed: ' + (err && err.stack ? err.stack : err));
            reply(msg.id, errorResult('Internal server error: ' + (err && err.message ? err.message : String(err))));
          }
        });
      return;
    }
    default:
      // Notifications (no id) must never get a response.
      if (msg.id !== undefined && msg.id !== null) {
        replyError(msg.id, -32601, 'Method not found: ' + method +
          '. This server implements initialize, ping, tools/list and tools/call.');
      }
  }
}

function onLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch (err) {
    replyError(undefined, -32700, 'Parse error: ' + err.message);
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    replyError(undefined, -32600, 'Invalid Request: expected a single JSON-RPC 2.0 object (batches are not supported).');
    return;
  }
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg.id !== undefined) replyError(msg.id, -32600, 'Invalid Request: jsonrpc must be "2.0" and method must be a string.');
    return;
  }
  if (msg.id === undefined) {
    log('notification: ' + msg.method);
    return;   // notifications/initialized, notifications/cancelled, ...
  }
  try {
    handleRequest(msg);
  } catch (err) {
    log('crash while handling ' + msg.method + ': ' + (err && err.stack ? err.stack : err));
    replyError(msg.id, -32603, 'Internal error: ' + (err && err.message ? err.message : String(err)));
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    onLine(line);
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) onLine(buffer);
  process.exit(0);
});
process.stdin.on('error', err => log('stdin error: ' + err.message));
process.stdout.on('error', err => log('stdout error: ' + err.message));

// ─── Boot ────────────────────────────────────────────────────────────────────
log(SERVER_NAME + ' ' + SERVER_VERSION + ' ready — MCP over stdio, file: ' + STATE_FILE);

if (ARGS.live) {
  const serveDir = ARGS.serve === true ? path.join(__dirname, '..')
    : (typeof ARGS.serve === 'string' ? path.resolve(ARGS.serve) : null);
  startLiveServer({
    port: ARGS.port || 8765,
    serveDir: serveDir,
    log: log,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, file: STATE_FILE },
  }).then(handle => {
    LIVE = handle;
    log('live mode ON — WebSocket on ' + handle.url + ' (bound to ' + handle.host + ' only)');
    log('live mode: waiting for a Pixelol tab. Attach it from the «🤖 Агент» button inside the app.');
    if (serveDir) {
      log('live mode: serving ' + serveDir);
      log('Open this in your browser:  ' + handle.httpUrl + 'index.html');
      log('(a tab opened as a plain file — file:// — may be blocked from connecting; use the address above)');
    } else {
      log('live mode: no --serve, so serve the folder yourself, e.g.  python3 -m http.server 8080');
    }
  }).catch(err => {
    if (err && err.code === 'EADDRINUSE') {
      log('live mode FAILED: port ' + (ARGS.port || 8765) + ' is already in use. Another pixelol-ai (probably one ' +
        'launched by an MCP client) is already running. Close it, or start this one with --port <other>.');
    } else {
      log('live mode FAILED: ' + (err && err.message ? err.message : err));
    }
    // MCP over stdio keeps working in file mode: a busy port must not take the
    // whole server down, because that would break the agent's only channel.
  });
}

process.on('uncaughtException', err => log('uncaught: ' + (err && err.stack ? err.stack : err)));

log(SERVER_NAME + ' ' + SERVER_VERSION + ' ready — MCP over stdio, file: ' + STATE_FILE);