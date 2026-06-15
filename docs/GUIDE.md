# Pixelol — Complete User Guide

> No tutorials exist for Pixelol yet. This is the first one.
> Everything you need to start drawing with diamond pixels.

---

## 🖱️ Navigation

| Action | How |
|--------|-----|
| **Pan canvas** | Hold `Space` + drag, or middle mouse button drag |
| **Zoom in / out** | `Ctrl + Scroll` (or `Cmd + Scroll` on Mac), or use the zoom slider in the top bar |
| **Fit everything on screen** | Press `0` — centers and fits all layers into view |

---

## 🎨 Drawing Tools

Switch tools with keyboard shortcuts — no need to click the toolbar every time.

| Key | Tool | What it does |
|-----|------|-------------|
| `B` | ✏️ Pen | Draw diamond pixels |
| `E` | 🧹 Eraser | Erase pixels |
| `F` | 🪣 Fill | Flood-fill an area with the current color |
| `I` | 💉 Eyedropper | Pick a color from the canvas |
| `L` | 📏 Line | Draw a straight line |
| `R` | ⬛ Rectangle | Draw a rectangle |
| `V` | ⬚ Select | Select and transform a region or reference layer |
| `G` | 🔲 Grid | Toggle the grid on/off |

### ✏️ Pen — straight line mode
Hold `Shift` while drawing with the pen or eraser to lock to a straight line.
Click to set the anchor point, move, click again — perfectly straight stroke.
Press `Escape` to cancel the line before completing it.

### 💉 Eyedropper — quick access
Hold `Cmd` (Mac) or the Meta key while using any tool to temporarily switch to the eyedropper.
Release to go back to your previous tool instantly.

---

## ⏪ History

| Shortcut | Action |
|----------|--------|
| `Ctrl + Z` / `Cmd + Z` | Undo |
| `Ctrl + Y` / `Cmd + Y` | Redo |
| `Ctrl + Shift + Z` / `Cmd + Shift + Z` | Redo (alternative) |

The visual history bar at the bottom of the screen shows every action as a thumbnail.
Click any point in the bar to jump back to that exact state.

---

## 🗂️ Layers

Layers are managed in the right panel.

**Layer types:**
- **Pixel layer** — where you draw. Stack multiple layers for complex artwork
- **Reference layer** — an imported image used as a drawing guide. Doesn't affect export
- **Folder** — group layers together, control their combined opacity

**Layer controls (icons on each layer card):**
- 🔒 **Lock** — prevents accidental edits or drags
- ⚓ **Anchor / Float** — toggle whether the layer can be dragged to reorder
- 🔘 **Clipping** — clips this layer to the pixels of the layer below
- 💾 **Save layer** — export this layer alone as a PNG
- 🫥 **Sketch toggle** — show/hide the sketch overlay on this layer (only appears if the layer has a sketch)

**Drag to reorder:** click and hold the layer card, drag to a new position.
Drag into a folder header to move a layer inside a folder.

---

## ✏️ Sketch Mode

Sketch mode lets you draw a non-destructive overlay on any layer
without touching the actual pixels — useful for planning or tracing.

| How to activate | Hold `Alt` while the Pen or Eraser tool is active |
|----------------|--------------------------------------------------|
| How to hide/show | Click the 🫥 button on the layer card |

Sketch strokes are stored separately and never appear in the exported image.

---

## 📐 Reference Layers

Drop any image onto the canvas to import it as a reference layer.
Reference layers appear in the layer panel marked with a green border.

**What you can do with a reference layer:**
- Move, resize, rotate with the `V` (Select) tool
- Hold `R` while resizing to rotate at the same time
- Crop it using the crop handles
- Adjust its opacity in the layer panel
- Press `Enter` to confirm a transform or crop
- Press `Escape` to cancel

**To extract a color palette from an image:**
Drop any photo onto the canvas — Pixelol will automatically extract
the dominant colors and populate your palette with them.

---

## 🖊️ Stroke (Outline)

Stroke adds an outline to any pixel layer automatically.
Open the Stroke panel from the right sidebar.

**Controls:**
- **Color** — the outline color
- **Width** — thickness in pixels
- **Style** — solid, dashed, or dotted
- **Corner** — how corners are handled (miter, round, bevel)
- **Position** — inside, outside, or center of the pixel boundary

Stroke updates live as you draw — no need to reapply.

---

## 💾 Saving & Exporting

| Shortcut | Action |
|----------|--------|
| `Ctrl + S` / `Cmd + S` | Open the save / export dialog |

**Export formats:**
- **PNG** — flat image, all visible layers merged
- **SVG** — scalable vector version
- **.lol** — native Pixelol project file (saves all layers, history, settings — use this to continue working later)

To save a single layer as PNG: click the 💾 icon on that layer's card in the panel.

---

## 🆕 New Canvas

| Shortcut | Action |
|----------|--------|
| `Ctrl + N` / `Cmd + N` | Open the new canvas dialog |

---

## 👁️ Invisibility Mode

Press `Alt + I` to enter invisibility mode — hides all UI panels
for a clean, distraction-free view of your artwork.
Press `Escape` to exit.

---

## ⌨️ All Shortcuts at a Glance

| Shortcut | Action |
|----------|--------|
| `B` | Pen tool |
| `E` | Eraser tool |
| `F` | Fill tool |
| `I` | Eyedropper tool |
| `L` | Line tool |
| `R` | Rectangle tool |
| `V` | Select tool |
| `G` | Toggle grid |
| `0` | Fit all layers to screen |
| `Space + drag` | Pan canvas |
| `Ctrl/Cmd + Scroll` | Zoom |
| `Shift + draw` | Straight line mode |
| `Alt + draw` | Sketch mode (non-destructive overlay) |
| `Alt + I` | Invisibility mode |
| `Cmd` (hold) | Temporary eyedropper |
| `R` (hold during resize) | Rotate reference layer |
| `Enter` | Confirm transform / crop / staging |
| `Escape` | Cancel current action |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Y` | Redo |
| `Ctrl/Cmd + S` | Save / Export |
| `Ctrl/Cmd + N` | New canvas |

---

*This guide covers Pixelol v46. The app is actively developed —
new features may not appear here yet.*
