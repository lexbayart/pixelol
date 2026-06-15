You are given the source code of a pixel-art editor as a single HTML file. Your task is to audit the layer management system for bugs. Read the entire codebase, then work through every check listed below. Do not propose new features, new buttons, new layer modes, or architectural changes — your only job is to find defects in the current implementation and report them.

## Context

The layer system includes three entity types:
- **Pixel layers** — drawn pixel art, may carry stroke, sketch (Alt-mode overlay), clipping, opacity, lock
- **Reference layers (refLayers)** — bitmap images, may carry crop, opacity, lock, rotation
- **Folders** — containers; hold any mix of pixel and reference layers

All three types share one **float/drag system** driven by `_startFloat` / `_startRefFloat` / `_startFolderFloat`, `_attachFloatListeners` / `_attachRefFloatListeners` / `_attachFolderFloatListeners`, and `_commitFloat` / `_commitRefFloat` / `_commitFolderFloat`. Placement preview is rendered by `_updateDropLine` / `_updateRefDropLine`. Global order is maintained in `state.layerOrder` (array of `{type, idx}` entries) alongside per-layer `folderIdx` fields and per-folder `orderPos` fields kept in sync by `_recomputeAllFolderOrderPos`, `_shiftFolderOrderPos`, `_unshiftFolderOrderPos`.

The panel is rebuilt from scratch on every `renderLayersPanel()` call. State snapshots for undo/redo are produced by `_snapshotLayers()` / `_restoreLayersSnapshot()` and managed by `saveHistory()` / `undo()` / `redo()`.

---

Perform every check below. All sections are tests only — do not write any fixes or code while working through them. Record every defect you find and report everything at the end in the format specified there.

---

### 1. Drop-preview / placement consistency

**Goal:** The visual drop-line shown during drag must always match the exact position where `_commitFloat` / `_commitRefFloat` / `_commitFolderFloat` will insert the layer.

1.1 Drag a pixel layer **from root to root** — verify the blue wave line (`layer-drop-preview`) matches the final inserted position after drop.

1.2 Drag a pixel layer **from root into an open folder** (via the bottom-60 % zone of the folder header). Verify the green folder highlight (`drop-target-folder`) appears and the layer lands inside, at the position the preview indicated.

1.3 Drag a pixel layer **from inside a folder to root level** (cursor above the folder header's top-40 % zone or completely outside all folders). Verify the wave appears at root level and the layer's `folderIdx` becomes `-1` after drop.

1.4 Drag a pixel layer **between two children inside the same folder**. Verify ordering inside `state.layerOrder` matches the visual preview.

1.5 Repeat 1.1–1.4 for **reference layers** (uses `_floatRefDropTargetFolderIdx`, `_commitRefFloat`).

1.6 Repeat 1.1–1.4 for **folders** (uses `_commitFolderFloat`, `_floatFolderDropFolderPos`). Verify that moving a folder containing mixed-type children preserves all `folderIdx` values and `orderPos` sync.

1.7 Check the **edge case**: dragging a folder to a position immediately adjacent to another folder — `_updateDropLine` calls `_recomputeAllFolderOrderPos()` at entry; verify this does not produce an off-by-one in `folder.orderPos` that shifts the preview one slot away from the commit position.

---

### 2. Drag state isolation — no cross-contamination between float sessions

2.1 Start dragging a pixel layer, then press **Escape**. Verify `_cancelFloat` restores `layer.anchored = true`, clears `_floatingLayerIdx`, removes the ghost element and drop-line from DOM, calls `_detachFloatListeners`, and calls `renderLayersPanel()`.

2.2 Start dragging a pixel layer, then **click a button on a different panel** (e.g. toolbar, topbar) without releasing over the layer list. Verify the float session is not left dangling (ghost orphaned in DOM, event listeners leaked).

2.3 While a pixel layer is floating, verify that starting another float (pixel, ref, or folder) is blocked by the early-return guards in `_startFloat`, `_startRefFloat`, `_startFolderFloat`.

2.4 Perform 30+ consecutive drag operations mixing all three layer types without page reload. Inspect for accumulated ghost elements in DOM (`floating-ghost` class orphans), leaked `mousemove` listeners, or `_floatingLayerIdx` / `_floatingRefIdx` / `_floatingFolderIdx` not returning to `null` after each drop.

---

### 3. Button functionality and float-mode conflicts

For each button on a layer card (`🔒 lock`, `🔘/⭕ clipping`, `💾 save`, `⚓/⛵ anchor`, `🫥 sketch-toggle`):

3.1 Verify each button fires its intended action when the layer is **anchored** (normal state).

3.2 Verify each button is **disabled (greyed, cursor:pointer, `_applyFloatDisable`)** when its own layer is the one currently floating (`_isFloatingNow === true`). Clicking a disabled button must call `_commitFloat(_floatingDropIdx)` and not trigger the button's own action.

3.3 Verify that clicking a button on a **different, anchored layer** while another layer is floating calls `_commitFloat` (placement commit) before running any action — not the reverse.

3.4 The `🫥` sketch-toggle button is only rendered when `_layerHasSketch(layer)` is true. Verify it does not appear on layers with empty `sketch` Map and `sketchFree: []`.

3.5 Verify the **lock button** (`🔒`) on a folder header and on ref-layer cards works identically — locked layers emit `layer-locked-shake` CSS animation when user attempts to drag them (`_startFloat` / `_startRefFloat` early-return path).

---

### 4. Folder-level controls

4.1 Folder **collapse/expand** toggle: verify toggling collapse re-renders children correctly; verify that a collapsed folder's children are absent from the DOM (not merely hidden) so they cannot be accidentally hovered as drop targets.

4.2 Folder **opacity drag** (`_attachFolderOpacityDrag`): verify that starting an opacity drag on a folder header does not trigger folder float (`_folderOpacityDragActive` flag must block `_startFolderFloat`).

4.3 Folder **delete** (`_deleteFolder`): verify that deleting a folder removes it from `state.folders`, sets all child layers' `folderIdx` to `-1`, removes the folder entry from `state.layerOrder`, and calls `_recomputeAllFolderOrderPos()` before `renderLayersPanel()`.

4.4 Verify the folder opacity drag can be started and completed **while another layer (not the folder) is floating** — the opacity drag must be blocked (or safely deferred) to prevent simultaneous mutations.

---

### 5. Merge zones

5.1 Hovering over the **yellow merge zone** between two pixel layers must highlight both adjacent layer cards and trigger `_attachMergeZoneDelay`. Verify the highlight (`merge-zone-pulse` or equivalent class) is applied to the correct pair regardless of whether layers are at root or inside a folder.

5.2 Hovering over a **red (forbidden) merge zone** between a pixel layer and a reference layer must show the red indicator. Verify it does not accidentally trigger a merge.

5.3 Verify merge zones are **absent** during any active float session (`anyFloating === true` in `renderLayersPanel` should suppress merge-zone elements or their hover handlers).

5.4 After a merge (`mergePixelLayers` / `mergeRefLayers`), verify `state.layerOrder` contains no dangling entry for the consumed layer index, and `_recomputeAllFolderOrderPos()` is called.

---

### 6. Layer visibility, opacity, and sketch mode during drag

6.1 Drag a **hidden layer** (`visible: false`, `🙈` overlay on thumb). Verify `layer.visible` is preserved after `_commitFloat`; verify `layer-thumb-hidden-overlay` reappears correctly in `renderLayersPanel`.

6.2 Drag a layer with **opacity < 100 %** (`_opacityTouched: true`). Verify opacity fill bar width and `layer-opacity-label` text are correct in the re-rendered panel after drop.

6.3 Drag a layer that has an active **sketch** (`_layerHasSketch` returns true). Verify `_sketchHidden` flag and the `🫥` button survive the move without reset.

6.4 Drag a layer with **stroke active** (`layer.stroke.active === true`). Verify `layer.stroke` object is not modified or lost during the `_commitFloat` → `renderLayersPanel` → `render` cycle.

6.5 Drag a layer that is currently set as **clipping** (`layer.clipping === true`). Verify `clipping-thumb` class re-appears after drop.

---

### 7. History (undo/redo) integrity

7.1 Perform a drag-drop (commit). Call `undo()`. Verify `_restoreLayersSnapshot` is called, all float globals are reset to null (lines ~10973–11010), and the layer panel reflects the previous order without ghost elements.

7.2 Call `redo()` after the undo in 7.1. Verify the layer returns to the dragged position.

7.3 Perform 10 drag-drops in sequence, then undo all 10 one by one. Verify `state.layerOrder`, `state.layers[*].folderIdx`, and `state.folders[*].orderPos` are consistent at every step (no orphan entries).

7.4 Trigger undo **while a float session is active** (layer is floating). Verify `_restoreLayersSnapshot` cancels the float first (`_floatingLayerIdx` reset, listeners detached) before mutating state.

7.5 Verify `saveHistory` is called exactly **once** per `_commitFloat` / `_commitRefFloat` / `_commitFolderFloat` invocation, not inside `renderLayersPanel` or inside per-frame loops.

---

### 8. Panel switches and viewport changes

8.1 Switch to a different editor panel (e.g. palette, history, stroke panel) while a float session is **not** active. Switch back to the layers panel. Verify `renderLayersPanel()` re-renders correctly; verify no layer card is missing or duplicated.

8.2 Switch panels **while a float is active**. Verify the float is cancelled or safely preserved when returning to the layers panel (no orphan ghost elements, no stuck `_floatingLayerIdx`).

8.3 Change canvas **cell size** (`setCellSizeLive` / `setCellSizeCommit`). Verify layer thumbnails (`drawLayerThumb`) re-render at the new resolution without corrupting layer state.

8.4 Change canvas **zoom** (pan/zoom on the main canvas). Verify layer panel is unaffected and drag operations still produce correct `_commitFloat` outcomes.

---

### 9. Long-session degradation

9.1 Add 15 layers (mix of pixel and ref), create 3 folders, distribute layers across folders via drag, then perform 20 drag operations in varied combinations. After each set of 5 operations, verify:
- `state.layerOrder.length` equals `state.layers.length + state.refLayers.length` (no phantom entries)
- Every `layer.folderIdx` references a valid index in `state.folders` or is `-1`
- Every `folder.orderPos` matches the index of the corresponding folder-header entry in `state.layerOrder`
- No CSS class `floating-ghost` or `layer-drop-preview` remains in the DOM after drops are committed

9.2 Toggle lock on 5 layers simultaneously, then attempt to drag each. Verify `layer-locked-shake` fires and drag is blocked for each. Verify unlocked layers can still be dragged normally.

9.3 Rapidly click the `⚓` anchor button on the same layer 10 times. Verify no duplicate float sessions are spawned (`_floatingLayerIdx` never holds two simultaneous indices).

---

### 10. Hover and selection states

10.1 Hover over each layer card: verify the hover style activates and deactivates cleanly without sticking when the cursor leaves.

10.2 Click a layer card to select it (`setActiveLayer`). Verify `_activeFolderIdx` is set to `-1` and the previously active layer loses the `active` class.

10.3 Click a folder header to select the folder. Verify `_activeFolderIdx` updates and no pixel layer appears `active` simultaneously.

10.4 Select a ref layer (via canvas click, `state._selRefIdx`). Verify the ref-layer card in the panel receives `active` styling and pixel-layer cards do not.

---

### 11. Cross-system interactions — external editor features affecting the layer panel

This section covers every subsystem outside the layer panel that shares mutable state with it. The key shared variables are: `state.tool`, `state.activeLayerIdx`, `state._selRefIdx`, `state._refStaging`, `state._lastPixelLayerIdx`, `state._cropIsStaging`, `_activeFolderIdx`, `_floatingLayerIdx / _floatingRefIdx / _floatingFolderIdx`, and `state.layerOrder`.

#### 11-A. Tool switching (toolbar + hotkeys → `setTool`)

11-A.1 Switch tool to **select** while a pixel layer float is active. `setTool('select')` does not call `_cancelFloat`. Verify the float session survives correctly (or is cancelled intentionally) and the layer panel does not end up with an orphaned ghost.

11-A.2 Switch from **select** back to **pen/erase** (`setTool`) while `state._selRefIdx >= 0`. Verify `_hideSelRefOverlay()` is called, `state._selRefIdx` is reset to `-1` via `_forceExitRefSelection`, and the previously highlighted ref-layer card in the panel loses the `active` class correctly on the next `renderLayersPanel()`.

11-A.3 Activate **sketch mode** (hold Alt while tool = pen). Open the layer panel and drag a layer while Alt is still held. Verify the sketch overlay (`sketch-mode-active` on `#canvas-area`) and the float session do not interfere — sketch input should be blocked while the panel is receiving mouse events, and releasing Alt after the drop does not leave `_sketchActive = true` stuck.

11-A.4 Switch to **eyedrop** via the temporary shortcut (Alt held over canvas). Verify the temporary tool swap (`_eyedropTempPrev`) is restored correctly and does not alter `state.activeLayerIdx` or `_activeFolderIdx` on return.

11-A.5 While **invisibility mode** is active (`enterInvisMode` → `_invisActive = true`, `invis-active` class on body): open the layer panel, add a new layer, drag layers, toggle lock. Verify none of these actions call `exitInvisMode` inadvertently, and that the layer panel CSS is not broken by the `invis-active` class on body affecting layer-item styles.

#### 11-B. Reference layer staging workflow (`startRefStaging` → `applyRefStaging` / `cancelRefStaging`)

11-B.1 Drop an image onto the canvas to start staging (`state._refStaging` set). While staging is active, switch to the layer panel and attempt to drag a pixel layer. The `item.addEventListener('mousedown')` handler calls `applyRefStaging()` if `state._refStaging` is truthy before any drag logic. Verify `applyRefStaging` completes and commits the new ref layer into `state.layerOrder` **before** `_startFloat` is entered — not after — so `layerOrder` is consistent when `_commitFloat` runs.

11-B.2 `_doApplyRefStaging` calls `state.layerOrder.forEach(e => { if (e.type==='ref') e.idx++; })` to bump all ref indices because a new ref is `unshift`ed. Verify this bump does not corrupt `_floatingRefIdx` if a ref-float session was somehow left non-null at staging commit time.

11-B.3 Cancel staging (`cancelRefStaging`). Verify `state._refStaging = null` is set, `renderLayersPanel()` is called, and the staging placeholder card (`.staging-pending`) is removed from the DOM — no phantom item remains.

11-B.4 Commit staging via `applyRefStaging` and immediately drag the newly created ref layer. Verify its index (0 after `unshift`) is correctly tracked in `_floatingRefIdx` and that `_commitRefFloat` resolves its `folderIdx` and `layerOrder` position without off-by-one caused by the index bump.

#### 11-C. Select-tool reference layer selection (`state._selRefIdx`, `_updateSelRefOverlay`)

11-C.1 Select a ref layer on canvas (tool = select, `state._selRefIdx = ri`). Then switch to the layer panel and click a **different pixel layer** card. The mousedown handler calls `confirmSelTransform()` and sets `_activeFolderIdx = -1`, `setActiveLayer(idx)`, `state._selRefIdx = -1`. Verify the sequence leaves `state._selRefIdx` at `-1`, the selection overlay is hidden, and the newly clicked pixel layer is correctly marked `active` in the next render.

11-C.2 Select a ref layer, then drag that same ref layer in the panel. The ref-layer card mousedown calls `confirmSelTransform` if `state._selRefIdx >= 0 && state._selRefIdx !== _ri`. Verify the transform is committed before `_startRefFloat` is called, so the ref layer is not in a half-transformed state during the drag.

11-C.3 `_forceExitRefSelection` sets `state.tool = targetTool` (pen or last drawing tool), resets `_selRefIdx`, and calls `renderLayersPanel()`. Verify calling it during an active layer-float session does not trigger a second `renderLayersPanel()` that wipes the ghost element mid-drag (since `renderLayersPanel` sets `_floatGhostEl = null` at line 8358).

#### 11-D. History panel (`historyJumpTo`, undo/redo buttons, Ctrl+Z / Ctrl+Y)

11-D.1 Click an **arbitrary history entry** in the history bar (`historyJumpTo(pos)`) while a float is active. `_restoreLayersSnapshot` cancels all floats (lines ~10973–11010). Verify the float globals are reset before `state.layers` / `state.layerOrder` are replaced, so the old layer indices are never accessed after the snapshot is restored.

11-D.2 Rapidly alternate Ctrl+Z / Ctrl+Y 20 times. After each pair, verify `state.layerOrder.length === state.layers.length + state.refLayers.length` and no entry has a `folderIdx` pointing to a non-existent folder index in `state.folders`.

11-D.3 Undo an action that **added a folder** (`addFolder`). Verify `state.folders` loses the entry, all layers that were in it have `folderIdx = -1`, and `_recomputeAllFolderOrderPos()` is called so surviving folders have correct `orderPos`.

11-D.4 Undo a **ref staging commit** (`_doApplyRefStaging` inserted a new ref at index 0 and bumped all other ref indices). Verify the undo snapshot correctly restores the pre-bump ref indices in `state.layerOrder`, and `renderLayersPanel()` shows no phantom ref-layer cards.

#### 11-E. Stroke panel (`toggleStroke`, `applyStrokeColor`, `applyStrokeWidth`, `setStrokeStyle`, `setStrokeCorner`, `setStrokePosition`)

11-E.1 Enable stroke on a layer, then drag that layer to a new position. Verify `layer.stroke` object is not mutated or lost inside `_commitFloat` → `_recomputeAllFolderOrderPos` → `renderLayersPanel` → `render`. The stroke must render correctly on the canvas after the move.

11-E.2 While the stroke color wheel is open (`_openStrokeColorWheel`), drag a different layer in the panel. The color wheel uses `document`-level `mousemove` / `mouseup` listeners. Verify these do not intercept the float system's `listEl.mousemove` listener, and closing the wheel afterward does not leave `_floatingLayerIdx` non-null.

11-E.3 `updateStrokePanel()` reads `state._refStaging` and `state.tool` to decide what to display. Verify calling it from inside `setTool` after a layer drag (which calls `renderLayersPanel` → triggers no implicit `setTool`) does not cause a double-render or overwrite the newly committed layer order.

#### 11-F. Canvas operations — new canvas, cell size, zoom

11-F.1 **New canvas** (`createCanvas`): this replaces `state.layers`, `state.refLayers`, `state.layerOrder`, and `state.folders` entirely. Verify that any active float is cancelled beforehand (check for explicit `_cancelFloat` / `_cancelRefFloat` / `_cancelFolderFloat` calls or equivalent reset in `createCanvas`). If those resets are absent, report it as a bug.

11-F.2 **Cell size change** (`setCellSizeLive` / `setCellSizeCommit`): verify layer thumbnails (`drawLayerThumb`) re-draw at the new resolution and that `_recomputeBbox` is called for layers that need it. Verify no layer `folderIdx` or `layerOrder` entry is altered as a side-effect.

11-F.3 **Zoom / pan** on the main canvas (wheel scroll, middle-mouse drag): these mutate `state.offsetX`, `state.offsetY`, `state.scale`. Verify they do not call `renderLayersPanel()` unnecessarily, and that returning to the layer panel after heavy panning shows the correct thumbnail positions without scroll drift in `#layersList`.

#### 11-G. Grid, guides, and measurement overlay

11-G.1 Toggle the **grid** (`toggleGrid`): calls `render()` only. Verify no layer state is touched and the layer panel requires no re-render.

11-G.2 Add or drag a **guide line** (`_onGuideMouseDown` / `_onGuideDocMove` / `_onGuideMouseUp`): guide events are attached to the guide overlay element with its own `mousemove`/`mouseup` on `document`. While a guide drag is in progress, verify that clicking the layer panel does not fire `_commitFloat` (the layer panel mousedown listener should not be reachable while the guide overlay captures events).

11-G.3 Delete a guide (`_deleteGuide`): verify it calls `_renderGuides()` and `render()` but not `renderLayersPanel()`, so no ghost elements are introduced into the layer list.

#### 11-H. Palette extraction and color picker

11-H.1 Drop an image for **palette extraction** (`extractPaletteFromImage`): this calls `saveHistory` and `renderHistoryBar`. Verify the history entry does not accidentally snapshot a half-committed layer order if a float was active at extraction time.

11-H.2 Use the **eyedrop** color picker on the canvas while a layer is selected in the panel. Verify `state.activeLayerIdx` is unchanged after the eyedrop completes and the layer panel selection highlight is correct.

#### 11-I. Modal dialogs (Save layer, Save project, New canvas, Lol-save)

11-I.1 Open the **save-layer modal** (`openSaveLayerModal`) from a layer card button. While the modal is open, verify that global `keydown` handlers (Escape, Ctrl+Z, Alt) are blocked by the modal-guard check at line ~2953 and do not cancel a float or trigger undo.

11-I.2 Close the save modal by clicking outside it (`onclick="if(event.target===this){...}"` on `.modal-overlay`). Verify the click does not bubble into the layer list and accidentally commit a float at `_floatingDropIdx`.

11-I.3 Open the **new-canvas modal** and cancel it (`closeNewModal`). Verify `state.layers`, `state.layerOrder`, `state.folders`, and all float globals are unchanged.

---

### 12. Boundary and edge-case data states

12.1 **Empty layer list.** Delete all layers down to zero. Verify `renderLayersPanel()` renders an empty list without errors, `state.activeLayerIdx` does not point to a non-existent index, and `_ensureLayerOrder()` does not throw on an empty `state.layers`.

12.2 **Single layer.** With exactly one layer in the list, test: drag it (float must be available, but placement must return it to the same slot); call `moveLayerUp()` and `moveLayerDown()` (must be no-ops without errors); delete it (verify `state.activeLayerIdx` resets to `-1` or another valid value without throwing).

12.3 **Empty folder.** Create a folder and add no layers to it. Drag a layer into it, then drag it back out. Delete the empty folder. Verify `state.layerOrder` contains no orphan entries and `_recomputeAllFolderOrderPos()` does not break on a folder with no children.

12.4 **Opacity at hard limits.** Set opacity to exactly 0% and exactly 100% via the opacity drag. Verify `layer.opacity` holds exactly `0` and `1` without floating-point overflow, the fill bar does not escape the item element bounds, and `render()` correctly displays a fully transparent layer.

12.5 **Very long layer name.** Enter a name of 200+ characters. Verify the input does not break the card layout or push other buttons out of view, and `layer.name` is stored and restored in full by `_snapshotLayers` without truncation.

12.6 **Maximum layer count.** Add 30+ layers and 5+ folders. Verify `renderLayersPanel()` does not degrade in performance, scroll in `#layersList` works, and drag between layers at the top and bottom of the list computes `dropOrderIdx` correctly without off-by-one errors.

---

### 13. Mouse event edge cases

13.1 **Mousedown without mouseup — cursor leaves the browser window.** Start dragging a layer, move the cursor outside the browser window, and release the mouse button there. Verify that when the cursor returns the float session is not stuck — `_floatingLayerIdx` must return to `null`, the ghost element must be removed from DOM, and `_detachFloatListeners` must have been called. Check whether `mouseup` is attached to `document` (not only to `listEl`) inside `_attachFloatListeners`.

13.2 **Mousedown on layer A, mouseup on layer B.** Press the mouse button on card A, keep it held while moving to card B, then release. Verify the float commits at the position under the cursor on mouseup, not back at layer A.

13.3 **Rapid double-click on the anchor button `⚓`.** Verify the double-click does not spawn two parallel float sessions — the second click must enter the `_commitFloat` branch (layer already floating) rather than `_startFloat`.

13.4 **Right-click during drag.** Right-click while a layer is floating. Verify the browser context menu does not leave the float in a suspended state — the `contextmenu` event must either cancel the float or be ignored without leaking state.

13.5 **Fast mouse movement outside `#layersList` during drag.** Verify the ghost stops at the list boundary but `_floatingDropIdx` does not take an invalid value. Verify the folder-group hit-test (which checks `e.clientX >= fgr.left && e.clientX <= fgr.right`) does not get stuck on the last valid result when the cursor exits to the right or left.

---

### 14. Scrolling the layer panel during drag

14.1 Add enough layers to make `#layersList` vertically scrollable. Scroll the list to the bottom, then start dragging a layer from the lower section. Verify `_floatInitialTop` and `_floatClickOffsetY` account for `listEl.scrollTop` (around line 7177: `itemRect.top - listRect.top + listEl.scrollTop`), and the ghost appears exactly under the cursor rather than offset by the scroll amount.

14.2 While a drag is active, scroll the list with the mouse wheel. Verify the ghost continues to follow the cursor correctly as `listEl.scrollTop` changes, and the drop-line (`layer-drop-preview`) is inserted at the DOM position that matches the new scroll position, not the one before scrolling.

14.3 Drag a layer from the very top of the list to the very bottom while the list is scrolled. Verify `dropOrderIdx` at the lower boundary is computed as `layerOrder.length`, not `layerOrder.length - 1`, and the layer becomes the last entry after commit.

---

### 15. Toolbar operations fired during an active drag session

15.1 While a layer is floating, click **"+" (addLayer)**. `addLayer` calls `renderLayersPanel()`, which sets `_floatGhostEl = null` (around line 8358) without ending the float. Verify that either `addLayer` is blocked while a float is active, or an explicit `_cancelFloat()` is called inside `addLayer` before `renderLayersPanel`.

15.2 While a layer is floating, click **"✕" (deleteLayer)**. `deleteLayer` mutates `state.layers` and calls `renderLayersPanel`. Verify `_floatingLayerIdx` does not point to a deleted or shifted index after that call.

15.3 While a layer is floating, press **Ctrl+Z**. `_restoreLayersSnapshot` is supposed to cancel the float before mutating state. Verify the ghost is removed, listeners are detached, and a new drag can begin without artifacts.

15.4 While a layer is floating, click **"⧉" (duplicateLayer)**. Verify that duplication either is blocked, or correctly commits or cancels the current float before adding the new layer to `state.layerOrder`.

15.5 While a layer is floating, click **"↑" / "↓" (moveLayerUp / moveLayerDown)**. These functions directly mutate `state.layerOrder`. Verify they are either blocked when `_floatingLayerIdx !== null`, or call `_cancelFloat()` first.

---

### 16. render() call after every layer operation

16.1 After each `_commitFloat` / `_commitRefFloat` / `_commitFolderFloat`, verify `render()` is called at the end of the function (not only `renderLayersPanel()`), so the canvas visually reflects the new layer order immediately.

16.2 After `toggleStroke`, `applyStrokeColor`, `applyStrokeWidth`, and `setStrokeStyle`, verify `render()` is called and the stroke change appears on the canvas without requiring any additional interaction.

16.3 After `undo()` and `redo()`, verify `render()` is called inside `_applyHistoryAt` and the canvas shows the state matching the restored snapshot — not a previously cached image.

16.4 After `setLayerVisible(idx, val)` and after any opacity change, verify `scheduleRender()` or `render()` is called and the canvas immediately reflects the new visibility or transparency.

16.5 After `deleteLayer()` and `duplicateLayer()`, verify `render()` is called and the canvas neither shows the deleted layer nor omits the duplicated one.

---

## Output instructions

Work in two phases. Do not skip phase one and jump straight to fixes. Provide your entire response in Russian.

### Phase 1 — Bug list

After completing all checks, output a numbered list of every bug found. No code, no explanations, no fix details yet. Each entry must fit in four lines:

```
🔴 BUG-001  CRITICAL
Line(s): <line numbers or function name>
Symptom: <what the user observes — one sentence>
Cause:   <which variable or code path is responsible — one sentence>
```

Severity levels and their icons — use exactly these, no variations:
- 🔴 **CRITICAL** — data loss, permanent state corruption, or feature becomes completely unusable
- 🟠 **MAJOR** — incorrect behaviour that regularly affects normal use (wrong drop position, stuck drag, broken undo)
- 🟡 **MINOR** — visible glitch or inconsistency that has a workaround
- 🟢 **TRIVIAL** — cosmetic issue or edge case that rarely occurs in practice

Group the list under section headings (e.g. `Section 2 — Drag state isolation`). If a section is fully clean, write `Section N — PASS`. Output nothing else in this phase.

---

### Phase 2 — Fixes

Only after the full bug list is complete, go through it from BUG-001 downward and fix each one. For each fix:
- Reference the bug number and its severity
- Show only the changed lines with minimal surrounding context
- One fix per bug — do not combine unrelated changes

Do not rewrite sections of code that are not directly related to a listed bug.
