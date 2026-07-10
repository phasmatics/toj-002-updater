/**
 * 16x16 sprite editor for ToJ-002 updater
 */

export const SPRITE_W = 16;
export const SPRITE_H = 16;
export const SPRITE_BYTES = 32;
export const SPRITE_FRAMES = 3;
export const SPRITE_LAYERS = 3;
export const SPRITE_TOTAL = SPRITE_BYTES * SPRITE_FRAMES;

function createEmptyLayer() {
  return new Uint8Array(SPRITE_W * SPRITE_H);
}

function createEmptyFrameLayers() {
  return Array.from({ length: SPRITE_LAYERS }, () => createEmptyLayer());
}

const spriteFrames = Array.from({ length: SPRITE_FRAMES }, () => createEmptyFrameLayers());

const layerVisibility = Array.from({ length: SPRITE_FRAMES }, () => [true, true, true]);

let activeSpriteFrame = 0;
let activeLayer = 0;
let activeTool = "pencil";
let brushSize = 1;
let drawing = false;
let lineStart = null;
let selectStart = null;
let selection = null;
let clipboard = null;
let moveDrag = null;

const MAX_HISTORY = 50;
let history = [];
let historyIndex = -1;

let ui = {};
let onRedrawPreview = () => {};

function currentBuf() {
  return spriteFrames[activeSpriteFrame][activeLayer];
}

function compositeFrame(frameIdx, layerOverride = null, overrideLayerIdx = -1, includeHidden = false) {
  const out = createEmptyLayer();
  const layers = spriteFrames[frameIdx];
  const vis = layerVisibility[frameIdx];
  for (let l = 0; l < SPRITE_LAYERS; l++) {
    if (!includeHidden && !vis[l]) continue;
    const src = l === overrideLayerIdx && layerOverride ? layerOverride : layers[l];
    for (let i = 0; i < out.length; i++) {
      if (src[i]) out[i] = 1;
    }
  }
  return out;
}

function compositeFrameForExport(frameIdx) {
  return compositeFrame(frameIdx, null, -1, true);
}

function compositeActiveFrame(layerOverride = null, overrideLayerIdx = activeLayer) {
  return compositeFrame(activeSpriteFrame, layerOverride, overrideLayerIdx);
}

function pasteTargetLayer() {
  return Math.min(activeLayer + 1, SPRITE_LAYERS - 1);
}

function blitOpaquePixels(dst, pixels, x0, y0, w, h) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = pixels[j * w + i];
      if (!v) continue;
      const x = x0 + i;
      const y = y0 + j;
      if (x < 0 || x >= SPRITE_W || y < 0 || y >= SPRITE_H) continue;
      dst[y * SPRITE_W + x] = 1;
    }
  }
}

function blitLayerShifted(dst, srcFull, shiftX, shiftY) {
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (!srcFull[y * SPRITE_W + x]) continue;
      const nx = x + shiftX;
      const ny = y + shiftY;
      if (nx < 0 || nx >= SPRITE_W || ny < 0 || ny >= SPRITE_H) continue;
      dst[ny * SPRITE_W + nx] = 1;
    }
  }
}

function clearOpaqueRect(buf, sel) {
  const s = normalizeSelection(sel);
  if (!s) return;
  for (let y = s.y0; y <= s.y1; y++) {
    for (let x = s.x0; x <= s.x1; x++) {
      const idx = y * SPRITE_W + x;
      if (buf[idx]) buf[idx] = 0;
    }
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeSelection(sel) {
  if (!sel) return null;
  return {
    x0: Math.min(sel.x0, sel.x1),
    y0: Math.min(sel.y0, sel.y1),
    x1: Math.max(sel.x0, sel.x1),
    y1: Math.max(sel.y0, sel.y1),
  };
}

function hasSelection() {
  return selection !== null;
}

function clearSelection() {
  selection = null;
  selectStart = null;
  drawSpriteEditor();
  updateActionButtons();
}

function cellInSelection(x, y, sel) {
  const s = normalizeSelection(sel);
  if (!s) return false;
  return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function cloneAllFrames() {
  return spriteFrames.map((layers) => layers.map((layer) => layer.slice()));
}

function snapshotsEqual(a, b) {
  return a.every((layers, fi) =>
    layers.every((layer, li) => layer.every((v, vi) => v === b[fi][li][vi]))
  );
}

function pushHistory() {
  const snap = cloneAllFrames();
  if (historyIndex >= 0 && snapshotsEqual(snap, history[historyIndex])) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snap);
  if (history.length > MAX_HISTORY) {
    history.shift();
  } else {
    historyIndex++;
  }
}

function restoreHistory(index) {
  if (index < 0 || index >= history.length) return false;
  historyIndex = index;
  const snap = history[index];
  for (let f = 0; f < SPRITE_FRAMES; f++) {
    for (let l = 0; l < SPRITE_LAYERS; l++) {
      spriteFrames[f][l].set(snap[f][l]);
    }
  }
  selection = null;
  selectStart = null;
  moveDrag = null;
  drawSpriteEditor();
  onRedrawPreview();
  updateActionButtons();
  return true;
}

function undo() {
  if (historyIndex <= 0) return false;
  return restoreHistory(historyIndex - 1);
}

function redo() {
  if (historyIndex >= history.length - 1) return false;
  return restoreHistory(historyIndex + 1);
}

function resetHistory() {
  history = [cloneAllFrames()];
  historyIndex = 0;
}

function spriteCellFromEvent(evt) {
  const canvas = ui.spriteCanvas;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((evt.clientX - rect.left) / rect.width) * SPRITE_W);
  const y = Math.floor(((evt.clientY - rect.top) / rect.height) * SPRITE_H);
  if (x < 0 || x >= SPRITE_W || y < 0 || y >= SPRITE_H) return null;
  return { x, y };
}

function stampBrush(buf, cx, cy, size, value) {
  const offset = size <= 1 ? 0 : Math.floor(size / 2);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const x = cx - offset + dx;
      const y = cy - offset + dy;
      if (x >= 0 && x < SPRITE_W && y >= 0 && y < SPRITE_H) {
        buf[y * SPRITE_W + x] = value;
      }
    }
  }
}

function drawLinePixels(buf, x0, y0, x1, y1, value, size) {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    stampBrush(buf, x, y, size, value);
    if (x === x1 && y === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function floodFill(buf, sx, sy, fillValue) {
  const target = buf[sy * SPRITE_W + sx];
  if (target === fillValue) return;
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= SPRITE_W || y < 0 || y >= SPRITE_H) continue;
    const idx = y * SPRITE_W + x;
    if (buf[idx] !== target) continue;
    buf[idx] = fillValue;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function copySelection() {
  const s = normalizeSelection(selection);
  if (!s) return false;
  const w = s.x1 - s.x0 + 1;
  const h = s.y1 - s.y0 + 1;
  const pixels = new Uint8Array(w * h);
  const buf = currentBuf();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      pixels[j * w + i] = buf[(s.y0 + j) * SPRITE_W + (s.x0 + i)];
    }
  }
  clipboard = { x0: s.x0, y0: s.y0, w, h, pixels };
  return true;
}

function cutSelection() {
  if (!copySelection()) return false;
  pushHistory();
  clearOpaqueRect(currentBuf(), selection);
  drawSpriteEditor();
  onRedrawPreview();
  return true;
}

function deleteSelection() {
  if (!hasSelection()) return false;
  pushHistory();
  clearOpaqueRect(currentBuf(), selection);
  selection = null;
  selectStart = null;
  drawSpriteEditor();
  onRedrawPreview();
  updateActionButtons();
  return true;
}

function pasteClipboard() {
  if (!clipboard) return false;
  pushHistory();
  const target = pasteTargetLayer();
  activeLayer = target;
  setActiveLayer(target, false);
  const buf = spriteFrames[activeSpriteFrame][target];
  blitOpaquePixels(buf, clipboard.pixels, clipboard.x0, clipboard.y0, clipboard.w, clipboard.h);
  selection = {
    x0: clipboard.x0,
    y0: clipboard.y0,
    x1: clipboard.x0 + clipboard.w - 1,
    y1: clipboard.y0 + clipboard.h - 1,
  };
  drawSpriteEditor();
  onRedrawPreview();
  updateActionButtons();
  return true;
}

function rotateSelectionCW() {
  const s = normalizeSelection(selection);
  if (!s) return false;
  pushHistory();
  const buf = currentBuf();
  const w = s.x1 - s.x0 + 1;
  const h = s.y1 - s.y0 + 1;
  const tmp = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      tmp[j * w + i] = buf[(s.y0 + j) * SPRITE_W + (s.x0 + i)];
    }
  }
  clearOpaqueRect(buf, s);
  const nw = h;
  const nh = w;
  if (s.x0 + nw > SPRITE_W || s.y0 + nh > SPRITE_H) return false;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = tmp[j * w + i];
      if (!v) continue;
      const ni = h - 1 - j;
      const nj = i;
      buf[(s.y0 + nj) * SPRITE_W + (s.x0 + ni)] = v;
    }
  }
  selection = { x0: s.x0, y0: s.y0, x1: s.x0 + nw - 1, y1: s.y0 + nh - 1 };
  drawSpriteEditor();
  onRedrawPreview();
  return true;
}

function startMoveAt(cell) {
  const s = normalizeSelection(selection);
  if (s && cellInSelection(cell.x, cell.y, s)) {
    pushHistory();
    const w = s.x1 - s.x0 + 1;
    const h = s.y1 - s.y0 + 1;
    const buf = currentBuf();
    const pixels = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        pixels[j * w + i] = buf[(s.y0 + j) * SPRITE_W + (s.x0 + i)];
      }
    }
    clearOpaqueRect(buf, s);
    moveDrag = {
      fullLayer: false,
      pixels,
      w,
      h,
      offsetX: cell.x - s.x0,
      offsetY: cell.y - s.y0,
      origX0: s.x0,
      origY0: s.y0,
    };
    return true;
  }

  if (!hasSelection()) {
    return startFullLayerMove(cell);
  }

  return false;
}

function startFullLayerMove(cell) {
  const buf = currentBuf();
  let hasPixels = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i]) {
      hasPixels = true;
      break;
    }
  }
  if (!hasPixels) return false;

  pushHistory();
  const pixels = buf.slice();
  for (let i = 0; i < buf.length; i++) {
    if (buf[i]) buf[i] = 0;
  }
  moveDrag = {
    fullLayer: true,
    pixels,
    grabX: cell.x,
    grabY: cell.y,
  };
  return true;
}

function cancelMoveDrag() {
  if (!moveDrag) return;
  const buf = currentBuf();
  if (moveDrag.fullLayer) {
    buf.set(moveDrag.pixels);
  } else {
    const { pixels, w, h, origX0, origY0 } = moveDrag;
    blitOpaquePixels(buf, pixels, origX0, origY0, w, h);
    selection = { x0: origX0, y0: origY0, x1: origX0 + w - 1, y1: origY0 + h - 1 };
  }
  moveDrag = null;
}

function previewMoveAt(cell) {
  if (!moveDrag) return null;

  if (moveDrag.fullLayer) {
    const layerBuf = createEmptyLayer();
    const shiftX = cell.x - moveDrag.grabX;
    const shiftY = cell.y - moveDrag.grabY;
    blitLayerShifted(layerBuf, moveDrag.pixels, shiftX, shiftY);
    return {
      buf: compositeActiveFrame(layerBuf, activeLayer),
      sel: null,
    };
  }

  const layerBuf = currentBuf().slice();
  const newX0 = clamp(cell.x - moveDrag.offsetX, 0, SPRITE_W - moveDrag.w);
  const newY0 = clamp(cell.y - moveDrag.offsetY, 0, SPRITE_H - moveDrag.h);
  blitOpaquePixels(layerBuf, moveDrag.pixels, newX0, newY0, moveDrag.w, moveDrag.h);
  return {
    buf: compositeActiveFrame(layerBuf, activeLayer),
    sel: {
      x0: newX0,
      y0: newY0,
      x1: newX0 + moveDrag.w - 1,
      y1: newY0 + moveDrag.h - 1,
    },
  };
}

function commitMoveAt(cell) {
  if (!moveDrag) return false;

  if (moveDrag.fullLayer) {
    const buf = currentBuf();
    const shiftX = cell.x - moveDrag.grabX;
    const shiftY = cell.y - moveDrag.grabY;
    buf.fill(0);
    blitLayerShifted(buf, moveDrag.pixels, shiftX, shiftY);
    moveDrag = null;
    drawSpriteEditor();
    onRedrawPreview();
    return true;
  }

  const preview = previewMoveAt(cell);
  if (!preview) return false;
  const buf = currentBuf();
  blitOpaquePixels(buf, moveDrag.pixels, preview.sel.x0, preview.sel.y0, moveDrag.w, moveDrag.h);
  selection = preview.sel;
  moveDrag = null;
  drawSpriteEditor();
  onRedrawPreview();
  return true;
}

function flipSelectionH() {
  const s = normalizeSelection(selection);
  if (!s) return false;
  pushHistory();
  const buf = currentBuf();
  const w = s.x1 - s.x0 + 1;
  const h = s.y1 - s.y0 + 1;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < Math.floor(w / 2); i++) {
      const l = (s.y0 + j) * SPRITE_W + (s.x0 + i);
      const r = (s.y0 + j) * SPRITE_W + (s.x1 - i);
      const t = buf[l];
      buf[l] = buf[r];
      buf[r] = t;
    }
  }
  drawSpriteEditor();
  onRedrawPreview();
  return true;
}

function flipSelectionV() {
  const s = normalizeSelection(selection);
  if (!s) return false;
  pushHistory();
  const buf = currentBuf();
  const w = s.x1 - s.x0 + 1;
  const h = s.y1 - s.y0 + 1;
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < Math.floor(h / 2); j++) {
      const t = (s.y0 + j) * SPRITE_W + (s.x0 + i);
      const b = (s.y1 - j) * SPRITE_W + (s.x0 + i);
      const tmp = buf[t];
      buf[t] = buf[b];
      buf[b] = tmp;
    }
  }
  drawSpriteEditor();
  onRedrawPreview();
  return true;
}

function updateLayerVisibilityUI() {
  const visBtns = [ui.layerVis0, ui.layerVis1, ui.layerVis2];
  const frameVis = layerVisibility[activeSpriteFrame];
  visBtns.forEach((btn, i) => {
    if (!btn) return;
    const visible = frameVis[i];
    btn.classList.toggle("is-visible", visible);
    btn.setAttribute("aria-pressed", visible ? "true" : "false");
    btn.setAttribute("aria-label", `レイヤー${i + 1} ${visible ? "表示" : "非表示"}`);
    btn.innerHTML = visible
      ? '<i class="fa-solid fa-eye"></i>'
      : '<i class="fa-solid fa-eye-slash"></i>';
  });
}

function toggleLayerVisibility(idx) {
  layerVisibility[activeSpriteFrame][idx] = !layerVisibility[activeSpriteFrame][idx];
  updateLayerVisibilityUI();
  drawSpriteEditor();
}

function setActiveLayer(idx, redraw = true) {
  activeLayer = clamp(idx, 0, SPRITE_LAYERS - 1);
  const tabs = [ui.spriteLayer0, ui.spriteLayer1, ui.spriteLayer2];
  tabs.forEach((el, i) => {
    if (!el) return;
    el.classList.toggle("is-active", i === activeLayer);
    el.setAttribute("aria-selected", i === activeLayer ? "true" : "false");
  });
  if (redraw) {
    drawSpriteEditor();
    updateActionButtons();
  }
}

function setActiveTab(idx) {
  activeSpriteFrame = idx;
  selection = null;
  selectStart = null;
  moveDrag = null;
  const tabs = [ui.spriteTabA, ui.spriteTabB, ui.spriteTabKO];
  tabs.forEach((el, i) => {
    if (!el) return;
    el.classList.toggle("is-active", i === idx);
    el.setAttribute("aria-selected", i === idx ? "true" : "false");
  });
  drawSpriteEditor();
  updateActionButtons();
  updateLayerVisibilityUI();
}

function setActiveTool(tool) {
  if (moveDrag) cancelMoveDrag();
  activeTool = tool;
  ui.toolBar?.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tool === tool);
  });
  if (tool !== "select") {
    selectStart = null;
  }
  drawSpriteEditor();
}

function updateActionButtons() {
  const hasSel = hasSelection();
  ui.toolCopy?.toggleAttribute("disabled", !hasSel);
  ui.toolCut?.toggleAttribute("disabled", !hasSel);
  ui.toolRotateCW?.toggleAttribute("disabled", !hasSel);
  ui.toolFlipH?.toggleAttribute("disabled", !hasSel);
  ui.toolFlipV?.toggleAttribute("disabled", !hasSel);
  ui.toolPaste?.toggleAttribute("disabled", !clipboard);
}

function spriteZoom() {
  const z = clamp(parseInt(ui.spriteZoom?.value ?? "15", 10), 5, 24);
  if (ui.spriteZoomValue) ui.spriteZoomValue.textContent = `${z}×`;
  if (ui.spriteCanvas) {
    ui.spriteCanvas.width = SPRITE_W * z;
    ui.spriteCanvas.height = SPRITE_H * z;
    ui.spriteCanvas.style.width = `${SPRITE_W * z}px`;
    ui.spriteCanvas.style.height = `${SPRITE_H * z}px`;
  }
  drawSpriteEditor();
}

function applyPaintAt(x, y) {
  const buf = currentBuf();
  const value = activeTool === "eraser" ? 0 : 1;
  stampBrush(buf, x, y, brushSize, value);
  drawSpriteEditor();
  onRedrawPreview();
}

function handlePointerDown(evt) {
  const cell = spriteCellFromEvent(evt);
  if (!cell) return;
  drawing = true;
  ui.spriteCanvas.setPointerCapture(evt.pointerId);

  if (hasSelection() && !cellInSelection(cell.x, cell.y, selection)) {
    clearSelection();
  }

  if (activeTool === "select") {
    selectStart = { x: cell.x, y: cell.y };
    selection = { x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y };
    drawSpriteEditor();
    updateActionButtons();
    return;
  }

  if (activeTool === "move") {
    if (startMoveAt(cell)) {
      drawSpriteEditor();
    } else {
      drawing = false;
    }
    return;
  }

  if (activeTool === "fill") {
    pushHistory();
    floodFill(currentBuf(), cell.x, cell.y, 1);
    drawing = false;
    drawSpriteEditor();
    onRedrawPreview();
    return;
  }

  if (activeTool === "line") {
    pushHistory();
    lineStart = { x: cell.x, y: cell.y };
    return;
  }

  if (activeTool === "pencil" || activeTool === "eraser") {
    pushHistory();
  }
  applyPaintAt(cell.x, cell.y);
}

function handlePointerMove(evt) {
  if (!drawing) return;
  const cell = spriteCellFromEvent(evt);
  if (!cell) return;

  if (activeTool === "select" && selectStart) {
    selection = {
      x0: selectStart.x,
      y0: selectStart.y,
      x1: cell.x,
      y1: cell.y,
    };
    drawSpriteEditor();
    return;
  }

  if (activeTool === "move" && moveDrag) {
    const preview = previewMoveAt(cell);
    if (preview) drawSpriteEditor(preview.buf, preview.sel);
    return;
  }

  if (activeTool === "line" && lineStart) {
    const layerBuf = currentBuf().slice();
    const value = 1;
    drawLinePixels(layerBuf, lineStart.x, lineStart.y, cell.x, cell.y, value, brushSize);
    drawSpriteEditor(compositeActiveFrame(layerBuf, activeLayer));
    return;
  }

  if (activeTool === "pencil" || activeTool === "eraser") {
    applyPaintAt(cell.x, cell.y);
  }
}

function handlePointerUp(evt) {
  if (!drawing) return;
  drawing = false;

  if (activeTool === "line" && lineStart) {
    const cell = spriteCellFromEvent(evt);
    if (cell) {
      const value = 1;
      drawLinePixels(currentBuf(), lineStart.x, lineStart.y, cell.x, cell.y, value, brushSize);
      onRedrawPreview();
    }
    lineStart = null;
    drawSpriteEditor();
    return;
  }

  if (activeTool === "move" && moveDrag) {
    const cell = spriteCellFromEvent(evt);
    if (cell) commitMoveAt(cell);
    else cancelMoveDrag();
    drawSpriteEditor();
    updateActionButtons();
    return;
  }

  if (activeTool === "select") {
    selectStart = null;
    updateActionButtons();
    drawSpriteEditor();
  }
}

export function drawSpriteEditor(previewBuf = null, previewSelection = null) {
  const canvas = ui.spriteCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const buf = previewBuf ?? compositeActiveFrame();
  const z = canvas.width / SPRITE_W;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#fff";
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (buf[y * SPRITE_W + x]) {
        ctx.fillRect(x * z, y * z, z, z);
      }
    }
  }

  ctx.strokeStyle = "rgba(240,240,240,0.18)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= SPRITE_W; x++) {
    ctx.beginPath();
    ctx.moveTo(x * z + 0.5, 0);
    ctx.lineTo(x * z + 0.5, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= SPRITE_H; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * z + 0.5);
    ctx.lineTo(canvas.width, y * z + 0.5);
    ctx.stroke();
  }

  const sel = normalizeSelection(previewSelection ?? selection);
  if (sel) {
    ctx.strokeStyle = "#11c2e4";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(sel.x0 * z + 0.5, sel.y0 * z + 0.5, (sel.x1 - sel.x0 + 1) * z, (sel.y1 - sel.y0 + 1) * z);
    ctx.setLineDash([]);
  }
}

function handleDocumentPointerDown(evt) {
  if (!hasSelection()) return;
  const canvas = ui.spriteCanvas;
  if (canvas?.contains(evt.target)) return;

  const target = evt.target;
  if (target instanceof Element && target.closest(".tool-bar, .editor-options, .sprite-tabs, .layer-list, .sprite-actions")) {
    return;
  }

  clearSelection();
}

function handleKeyDown(evt) {
  if (isTypingTarget(evt.target)) return;

  if (evt.key === "Escape") {
    if (moveDrag) {
      cancelMoveDrag();
      drawSpriteEditor();
      updateActionButtons();
      evt.preventDefault();
      return;
    }
    if (hasSelection()) {
      clearSelection();
      evt.preventDefault();
    }
    return;
  }

  if (evt.key === "Delete" || evt.key === "Backspace") {
    if (deleteSelection()) {
      evt.preventDefault();
    }
    return;
  }

  const mod = evt.ctrlKey || evt.metaKey;
  if (!mod) return;

  const key = evt.key.toLowerCase();
  if (key === "z") {
    const ok = evt.shiftKey ? redo() : undo();
    if (ok) evt.preventDefault();
    return;
  }
  if (key === "c") {
    if (copySelection()) {
      updateActionButtons();
      evt.preventDefault();
    }
  } else if (key === "x") {
    if (cutSelection()) {
      updateActionButtons();
      evt.preventDefault();
    }
  } else if (key === "v") {
    if (pasteClipboard()) {
      updateActionButtons();
      evt.preventDefault();
    }
  }
}

export function packSpriteFramesToDeviceBytes() {
  const out = new Uint8Array(SPRITE_TOTAL);
  for (let f = 0; f < SPRITE_FRAMES; f++) {
    const src = compositeFrameForExport(f);
    const base = f * SPRITE_BYTES;
    for (let row = 0; row < SPRITE_H; row++) {
      for (let byte = 0; byte < 2; byte++) {
        let v = 0;
        for (let bit = 0; bit < 8; bit++) {
          const col = byte * 8 + bit;
          const on = src[row * SPRITE_W + col] ? 1 : 0;
          v |= on ? (0x80 >> bit) : 0;
        }
        out[base + row * 2 + byte] = v;
      }
    }
  }
  return out;
}

export function unpackDeviceBytesToSpriteFrames(bytes) {
  if (bytes.length !== SPRITE_TOTAL) {
    throw new Error(`スプライトデータの長さが不正です（${bytes.length} バイト）`);
  }
  for (let f = 0; f < SPRITE_FRAMES; f++) {
    for (let l = 0; l < SPRITE_LAYERS; l++) {
      spriteFrames[f][l].fill(0);
    }
    const dst = spriteFrames[f][0];
    const base = f * SPRITE_BYTES;
    for (let row = 0; row < SPRITE_H; row++) {
      for (let byte = 0; byte < 2; byte++) {
        const v = bytes[base + row * 2 + byte];
        for (let bit = 0; bit < 8; bit++) {
          const col = byte * 8 + bit;
          dst[row * SPRITE_W + col] = (v & (0x80 >> bit)) ? 1 : 0;
        }
      }
    }
  }
  selection = null;
  resetHistory();
}

export function initSpriteEditor(elements, options = {}) {
  ui = elements;
  onRedrawPreview = options.onRedrawPreview ?? (() => {});

  setActiveTab(0);
  setActiveLayer(0, false);
  setActiveTool("pencil");
  spriteZoom();
  resetHistory();
  updateActionButtons();

  ui.spriteTabA?.addEventListener("click", () => setActiveTab(0));
  ui.spriteTabB?.addEventListener("click", () => setActiveTab(1));
  ui.spriteTabKO?.addEventListener("click", () => setActiveTab(2));
  ui.spriteLayer0?.addEventListener("click", () => setActiveLayer(0));
  ui.spriteLayer1?.addEventListener("click", () => setActiveLayer(1));
  ui.spriteLayer2?.addEventListener("click", () => setActiveLayer(2));
  ui.layerVis0?.addEventListener("click", (evt) => {
    evt.stopPropagation();
    toggleLayerVisibility(0);
  });
  ui.layerVis1?.addEventListener("click", (evt) => {
    evt.stopPropagation();
    toggleLayerVisibility(1);
  });
  ui.layerVis2?.addEventListener("click", (evt) => {
    evt.stopPropagation();
    toggleLayerVisibility(2);
  });
  updateLayerVisibilityUI();
  ui.spriteZoom?.addEventListener("input", spriteZoom);
  ui.brushSize?.addEventListener("input", () => {
    brushSize = clamp(parseInt(ui.brushSize.value, 10), 1, 4);
    if (ui.brushSizeValue) ui.brushSizeValue.textContent = `${brushSize}px`;
  });

  ui.toolBar?.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTool(btn.dataset.tool));
  });

  ui.toolCopy?.addEventListener("click", () => {
    if (copySelection()) updateActionButtons();
  });
  ui.toolCut?.addEventListener("click", () => {
    if (cutSelection()) updateActionButtons();
  });
  ui.toolPaste?.addEventListener("click", () => {
    if (pasteClipboard()) updateActionButtons();
  });
  ui.toolRotateCW?.addEventListener("click", () => rotateSelectionCW());
  ui.toolFlipH?.addEventListener("click", () => flipSelectionH());
  ui.toolFlipV?.addEventListener("click", () => flipSelectionV());

  ui.spriteCanvas?.addEventListener("pointerdown", handlePointerDown);
  ui.spriteCanvas?.addEventListener("pointermove", handlePointerMove);
  ui.spriteCanvas?.addEventListener("pointerup", handlePointerUp);
  ui.spriteCanvas?.addEventListener("pointercancel", () => {
    drawing = false;
    lineStart = null;
    selectStart = null;
    if (moveDrag) {
      cancelMoveDrag();
      drawSpriteEditor();
      updateActionButtons();
    }
  });

  document.addEventListener("pointerdown", handleDocumentPointerDown);
  document.addEventListener("keydown", handleKeyDown);

  brushSize = clamp(parseInt(ui.brushSize?.value ?? "1", 10), 1, 4);
  if (ui.brushSizeValue) ui.brushSizeValue.textContent = `${brushSize}px`;
}
