/**
 * ToJ-002 Firmware Updater
 * Web Serial + BOSSA (bossa-web) for Seeed XIAO SAMD21
 */

import { SamBA } from "https://esm.sh/bossa-web@0.9.7";
import { Device, Family } from "https://esm.sh/bossa-web@0.9.7";
import { Flasher } from "https://esm.sh/bossa-web@0.9.7";
import {
  SPRITE_W,
  SPRITE_H,
  SPRITE_BYTES,
  SPRITE_FRAMES,
  SPRITE_TOTAL,
  initSpriteEditor,
  drawSpriteEditor,
  packSpriteFramesToDeviceBytes,
  unpackDeviceBytesToSpriteFrames,
} from "./sprite-editor.js";

/**
 * Windows の Web Serial では flowControl:'hardware' が失敗することがある。
 * bossa-web の connect() を none 優先に差し替える。
 */
function patchSambaConnectForWindows() {
  if (SamBA.prototype.connect.__tojWindowsPatched) return;

  const originalConnect = SamBA.prototype.connect;
  SamBA.prototype.connect = async function patchedConnect(rebootWaitMs = 1000) {
    if (this.readLoopPromise) {
      throw new Error("already open");
    }

    const variants = [
      { baudRate: 921600, flowControl: "none" },
      { baudRate: 921600, flowControl: "hardware" },
    ];

    let lastError = null;
    for (const variant of variants) {
      try {
        await closePortQuietly(this.serialPort);
        await this.serialPort.open({
          dataBits: 8,
          stopBits: 1,
          parity: "none",
          bufferSize: 63,
          baudRate: variant.baudRate,
          flowControl: variant.flowControl,
        });
        await sleep(50);

        const noopOpen = async () => {};
        const origOpen = this.serialPort.open.bind(this.serialPort);
        this.serialPort.open = noopOpen;
        try {
          await originalConnect.call(this, rebootWaitMs);
        } finally {
          this.serialPort.open = origOpen;
        }
        return;
      } catch (error) {
        lastError = error;
        this.readLoopPromise = undefined;
        this.serialReader = undefined;
        try {
          await this.serialPort.close();
        } catch {
          // ignore
        }
      }
    }

    throw lastError ?? new Error("SAM-BA 接続に失敗しました");
  };

  SamBA.prototype.connect.__tojWindowsPatched = true;
}

patchSambaConnectForWindows();

const FIRMWARE_URL = "./firmware.bin";
/** 同梱ファームウェアの表示用バージョン（リリース時にここだけ書き換え） */
const FIRMWARE_VERSION = "0.6.1";
const BOOTLOADER_SIZE = 0x2000;

// Sprite transfer protocol (TOJS)
const SPRITE_MAGIC_SET = new Uint8Array([0x54, 0x4f, 0x4a, 0x53]); // 'TOJS'
const SPRITE_MAGIC_RESET = new Uint8Array([0x54, 0x4f, 0x4a, 0x44]); // 'TOJD'
const SPRITE_PROTO_VER = 1;
const PREVIEW_SCALE = 5;

const USB_FILTERS = [
  { usbVendorId: 0x2886 }, // Seeed Studio (ToJ-002 / XIAO)
  { usbVendorId: 0x2341 }, // Arduino
  { usbVendorId: 0x239a }, // Adafruit
  { usbVendorId: 0x1b4f }, // SparkFun
  { usbVendorId: 0x03eb }, // Atmel / Microchip
];

const BOOTLOADER_WAIT_MS = 2500;
const BOOTLOADER_POLL_MS = 300;
const BOOTLOADER_POLL_TIMEOUT_MS = 10000;

// Seeed XIAO: アプリとブートローダーで PID が変わる
const APP_USB_PID = 0x802f;
const BOOTLOADER_USB_PIDS = new Set([0x002f, 0x004d, 0x800f]);

const STATUS = {
  IDLE: "未接続",
  CONNECTING: "接続中...",
  RESETTING: "ブートローダーへ移行中...",
  ERASING: "消去中...",
  WRITING: (pct) => `書き込み中（${pct}%）`,
  VERIFYING: "検証中...",
  DONE: "完了！",
  ERROR: "エラー",
};

const ui = {
  statusText: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),
  progressPercent: document.getElementById("progressPercent"),
  updateBtn: document.getElementById("updateBtn"),
  log: document.getElementById("log"),
  browserWarning: document.getElementById("browserWarning"),
  manualFile: document.getElementById("manualFile"),
  manualFileName: document.getElementById("manualFileName"),
  clearManualBtn: document.getElementById("clearManualBtn"),
  firmwareInfo: document.getElementById("firmwareInfo"),

  // Sprite editor
  spriteCanvas: document.getElementById("spriteCanvas"),
  previewCanvas: document.getElementById("previewCanvas"),
  spriteTabA: document.getElementById("spriteTabA"),
  spriteTabB: document.getElementById("spriteTabB"),
  spriteTabKO: document.getElementById("spriteTabKO"),
  spriteLayer0: document.getElementById("spriteLayer0"),
  spriteLayer1: document.getElementById("spriteLayer1"),
  spriteLayer2: document.getElementById("spriteLayer2"),
  layerVis0: document.getElementById("layerVis0"),
  layerVis1: document.getElementById("layerVis1"),
  layerVis2: document.getElementById("layerVis2"),
  toolBar: document.getElementById("spriteToolBar"),
  toolCopy: document.getElementById("toolCopy"),
  toolCut: document.getElementById("toolCut"),
  toolPaste: document.getElementById("toolPaste"),
  toolRotateCW: document.getElementById("toolRotateCW"),
  toolFlipH: document.getElementById("toolFlipH"),
  toolFlipV: document.getElementById("toolFlipV"),
  brushSize: document.getElementById("brushSize"),
  brushSizeValue: document.getElementById("brushSizeValue"),
  spriteZoom: document.getElementById("spriteZoom"),
  spriteZoomValue: document.getElementById("spriteZoomValue"),
  sendSpriteBtn: document.getElementById("sendSpriteBtn"),
  resetSpriteBtn: document.getElementById("resetSpriteBtn"),
  shareSpriteBtn: document.getElementById("shareSpriteBtn"),
  spriteStatus: document.getElementById("spriteStatus"),
  togglePreviewBtn: document.getElementById("togglePreviewBtn"),
  shareModal: document.getElementById("shareModal"),
  shareUrlInput: document.getElementById("shareUrlInput"),
  shareCopyBtn: document.getElementById("shareCopyBtn"),
};

let bundledFirmware = null;
let manualFirmware = null;
let busy = false;

function supportsSerial() {
  return "serial" in navigator;
}

function setStatus(text, tone = "default") {
  ui.statusText.textContent = text;
  ui.statusText.className = "status-text";
  if (tone === "success") ui.statusText.classList.add("is-success");
  if (tone === "error") ui.statusText.classList.add("is-error");
  if (tone === "active") ui.statusText.classList.add("is-active");
}

function setProgress(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  ui.progressBar.style.width = `${clamped}%`;
  ui.progressPercent.textContent = `${clamped}%`;
}

function log(message, type = "info") {
  const line = document.createElement("p");
  line.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  line.textContent = `[${time}] ${message}`;
  ui.log.appendChild(line);
  ui.log.scrollTop = ui.log.scrollHeight;
  console.log(`[${type}] ${message}`);
}

function setMiniStatus(text, tone = "default") {
  if (!ui.spriteStatus) return;
  ui.spriteStatus.textContent = text;
  ui.spriteStatus.className = "mini-status";
  if (tone === "success") ui.spriteStatus.style.background = "var(--accent-1)";
  else if (tone === "active") ui.spriteStatus.style.background = "var(--accent-2)";
  else if (tone === "error") ui.spriteStatus.style.background = "var(--base)";
  else ui.spriteStatus.style.background = "var(--base)";
}

function activeFirmware() {
  return manualFirmware ?? bundledFirmware;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(encoded) {
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function buildSpriteShareUrl() {
  const encoded = bytesToBase64Url(packSpriteFramesToDeviceBytes());
  const url = new URL(window.location.href);
  url.searchParams.set("sprites", encoded);
  return url.toString();
}

function loadSpritesFromQuery() {
  const encoded = new URL(window.location.href).searchParams.get("sprites");
  if (!encoded) return false;

  try {
    unpackDeviceBytesToSpriteFrames(base64UrlToBytes(encoded));
    drawSpriteEditor();
    previewStartMs = performance.now();
    setMiniStatus("共有リンクから読み込みました", "success");
    log("URL パラメーター sprites からキャラクターを読み込みました", "success");
    return true;
  } catch (error) {
    log(`共有リンクの読み込みに失敗: ${error.message}`, "error");
    setMiniStatus("共有リンクが不正です", "error");
    return false;
  }
}

function openShareModal() {
  if (!ui.shareModal || !ui.shareUrlInput) return;
  ui.shareUrlInput.value = buildSpriteShareUrl();
  ui.shareModal.hidden = false;
  ui.shareUrlInput.focus();
  ui.shareUrlInput.select();
}

function closeShareModal() {
  if (!ui.shareModal) return;
  ui.shareModal.hidden = true;
}

async function copyShareUrl() {
  const text = ui.shareUrlInput?.value ?? buildSpriteShareUrl();
  try {
    await navigator.clipboard.writeText(text);
    if (ui.shareCopyBtn) {
      const prev = ui.shareCopyBtn.textContent;
      ui.shareCopyBtn.textContent = "コピーしました";
      setTimeout(() => {
        ui.shareCopyBtn.textContent = prev;
      }, 1500);
    }
    log("共有 URL をコピーしました", "success");
  } catch {
    ui.shareUrlInput?.focus();
    ui.shareUrlInput?.select();
    document.execCommand("copy");
    log("共有 URL をコピーしました", "success");
  }
}

function drawBitmap1bpp(ctx, bmpBytes, x, y, w, h, scale) {
  ctx.fillStyle = "#fff";
  const bytesPerRow = Math.ceil(w / 8);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const b = bmpBytes[row * bytesPerRow + (col >> 3)];
      const on = (b & (0x80 >> (col & 7))) !== 0;
      if (!on) continue;
      ctx.fillRect(x + col * scale, y + row * scale, scale, scale);
    }
  }
}

function drawBitmapRotated(ctx, bmpBytes, x, y, w, h, scale, deg) {
  if (Math.abs(deg) < 0.5) {
    drawBitmap1bpp(ctx, bmpBytes, x, y, w, h, scale);
    return;
  }
  const cx = x + (w * scale) / 2;
  const cy = y + (h * scale) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  drawBitmap1bpp(ctx, bmpBytes, x, y, w, h, scale);
  ctx.restore();
}

// --- Preview animation (device sequence @ default BPM 85) ---
let previewRunning = true;
let previewStartMs = performance.now();

const PREVIEW_BPM = 85;
const PREVIEW_BEAT = 60 / PREVIEW_BPM;
const PREVIEW_MOVE_DURATION = 3.0;
const T_PREVIEW_KO = PREVIEW_MOVE_DURATION;
const T_PREVIEW_BEAT_WAIT = T_PREVIEW_KO + PREVIEW_BEAT;
const T_PREVIEW_FALL = T_PREVIEW_BEAT_WAIT + PREVIEW_BEAT * 2;
const T_PREVIEW_LYING = T_PREVIEW_FALL + PREVIEW_BEAT * 2;
const T_PREVIEW_HEART_WAIT = T_PREVIEW_LYING + PREVIEW_BEAT;
const T_PREVIEW_HEART_FALL = T_PREVIEW_HEART_WAIT + 0.5;
const T_PREVIEW_HEART_VANISH = T_PREVIEW_HEART_FALL + 0.2;
const T_PREVIEW_REBORN = T_PREVIEW_HEART_VANISH + PREVIEW_BEAT * 2;
const PREVIEW_LOOP = T_PREVIEW_REBORN;

const PREVIEW_HEART = new Uint8Array([0x6c, 0x9e, 0xbe, 0xfe, 0x7c, 0x38, 0x10]);
const PREVIEW_HEART_W = 7;
const PREVIEW_HEART_H = 7;

function previewMoveX(lt, centerX, leftX, rightX) {
  if (lt >= PREVIEW_MOVE_DURATION) return centerX;

  const seg = PREVIEW_MOVE_DURATION / 4;
  const s = lt / seg;

  if (s < 1) {
    return centerX + (leftX - centerX) * s;
  }
  if (s < 2) {
    return leftX + (centerX - leftX) * (s - 1);
  }
  if (s < 3) {
    return centerX + (rightX - centerX) * (s - 2);
  }
  return rightX + (centerX - rightX) * (s - 3);
}

function renderPreview(nowMs) {
  const canvas = ui.previewCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = 128;
  const H = 64;
  const S = PREVIEW_SCALE;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W * S, H * S);

  const t = (nowMs - previewStartMs) / 1000;
  const lt = ((t % PREVIEW_LOOP) + PREVIEW_LOOP) % PREVIEW_LOOP;

  const centerX = Math.floor((W - SPRITE_W) / 2);
  const leftX = centerX - 16;
  const rightX = centerX + 16;
  const centerY = Math.floor((H - SPRITE_H) / 2);
  const bottomY = H - SPRITE_H;
  const koFallStartY = centerY;

  let x = centerX;
  let y = centerY;
  let frame = 0;
  let rotation = 0;
  let showHeart = false;
  let heartY = 0;
  let heartVanishStep = 0;

  if (lt < T_PREVIEW_KO) {
    x = Math.round(previewMoveX(lt, centerX, leftX, rightX));
    y = centerY;
    frame = Math.floor((lt * 5) % 2);
  } else if (lt < T_PREVIEW_BEAT_WAIT) {
    x = centerX;
    y = koFallStartY;
    frame = 2;
    rotation = 90;
  } else if (lt < T_PREVIEW_FALL) {
    x = centerX;
    const p = (lt - T_PREVIEW_BEAT_WAIT) / (PREVIEW_BEAT * 2);
    y = Math.round(koFallStartY + (bottomY - koFallStartY) * Math.min(1, Math.max(0, p)));
    frame = 2;
    rotation = 90;
  } else if (lt < T_PREVIEW_LYING) {
    x = centerX;
    y = bottomY;
    frame = 2;
    rotation = 90;
  } else if (lt < T_PREVIEW_HEART_WAIT) {
    x = centerX;
    y = bottomY;
    frame = 2;
    rotation = 90;
    showHeart = true;
    heartY = y - PREVIEW_HEART_H - 7;
  } else if (lt < T_PREVIEW_HEART_FALL) {
    x = centerX;
    y = bottomY;
    frame = 2;
    rotation = 90;
    showHeart = true;
    const heartStart = y - PREVIEW_HEART_H - 7;
    const heartTarget = y + (SPRITE_H - PREVIEW_HEART_H) * 0.5;
    const p = (lt - T_PREVIEW_HEART_WAIT) / (T_PREVIEW_HEART_FALL - T_PREVIEW_HEART_WAIT);
    heartY = heartStart + (heartTarget - heartStart) * Math.min(1, Math.max(0, p));
  } else if (lt < T_PREVIEW_HEART_VANISH) {
    x = centerX;
    y = bottomY;
    frame = 2;
    rotation = 90;
    heartY = y + (SPRITE_H - PREVIEW_HEART_H) * 0.5;
    heartVanishStep = Math.min(3, Math.floor((lt - T_PREVIEW_HEART_FALL) / 0.05));
    showHeart = heartVanishStep < 3;
  } else {
    x = centerX;
    frame = 2;
    rotation = 0;
    const p = (lt - T_PREVIEW_HEART_VANISH) / (PREVIEW_BEAT * 2);
    y = Math.round(bottomY + (koFallStartY - bottomY) * Math.min(1, Math.max(0, p)));
  }

  const packed = packSpriteFramesToDeviceBytes();
  const frameBytes = packed.subarray(frame * SPRITE_BYTES, frame * SPRITE_BYTES + SPRITE_BYTES);
  drawBitmapRotated(ctx, frameBytes, x * S, y * S, SPRITE_W, SPRITE_H, S, rotation);

  if (showHeart) {
    const heartX = Math.round(x + SPRITE_W / 2 - PREVIEW_HEART_W / 2);
    drawBitmap1bpp(ctx, PREVIEW_HEART, heartX * S, Math.round(heartY) * S, PREVIEW_HEART_W, PREVIEW_HEART_H, S);
  }
}

function previewLoop(nowMs) {
  if (!previewRunning) return;
  renderPreview(nowMs);
  requestAnimationFrame(previewLoop);
}

// --- Sprite transfer ---
async function writeToPort(port, bytes) {
  const writer = port.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

async function readLineFromPort(port, timeoutMs = 1200) {
  const reader = port.readable.getReader();
  const start = performance.now();
  let buf = "";
  try {
    while (performance.now() - start < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buf += new TextDecoder().decode(value);
      const idx = buf.indexOf("\n");
      if (idx >= 0) return buf.slice(0, idx + 1);
    }
    return buf;
  } finally {
    reader.releaseLock();
  }
}

async function transferSpritesToDevice() {
  if (!supportsSerial()) {
    setMiniStatus("Web Serial 非対応", "error");
    return;
  }

  setMiniStatus("ポート選択…", "active");
  const port = await navigator.serial.requestPort({ filters: USB_FILTERS });

  try {
    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      bufferSize: 255,
      flowControl: "none",
    });

    const payload = packSpriteFramesToDeviceBytes();
    const header = new Uint8Array(4 + 1 + 2);
    header.set(SPRITE_MAGIC_SET, 0);
    header[4] = SPRITE_PROTO_VER;
    header[5] = SPRITE_TOTAL & 0xff;
    header[6] = (SPRITE_TOTAL >> 8) & 0xff;

    const crc = checksumCalcBytes(payload, 0);
    const crcBytes = new Uint8Array([crc & 0xff, (crc >> 8) & 0xff]);

    const frame = new Uint8Array(header.length + payload.length + crcBytes.length);
    frame.set(header, 0);
    frame.set(payload, header.length);
    frame.set(crcBytes, header.length + payload.length);

    setMiniStatus("転送中…", "active");
    await writeToPort(port, frame);

    const line = await readLineFromPort(port);
    if (line.startsWith("OK")) {
      setMiniStatus("転送完了", "success");
      log("キャラクターを転送しました", "success");
    } else {
      setMiniStatus("転送失敗", "error");
      log(`キャラクター転送に失敗: ${line || "no response"}`, "error");
    }
  } finally {
    try {
      await port.close();
    } catch {
      // ignore
    }
  }
}

async function resetSpritesOnDevice() {
  if (!supportsSerial()) {
    setMiniStatus("Web Serial 非対応", "error");
    return;
  }

  setMiniStatus("ポート選択…", "active");
  const port = await navigator.serial.requestPort({ filters: USB_FILTERS });

  try {
    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      bufferSize: 64,
      flowControl: "none",
    });

    setMiniStatus("リセット中…", "active");
    await writeToPort(port, SPRITE_MAGIC_RESET);
    const line = await readLineFromPort(port);
    if (line.startsWith("OK")) {
      setMiniStatus("デフォルトへ戻しました", "success");
      log("キャラクターをデフォルトに戻しました", "success");
    } else {
      setMiniStatus("リセット失敗", "error");
      log(`キャラクターリセットに失敗: ${line || "no response"}`, "error");
    }
  } finally {
    try {
      await port.close();
    } catch {
      // ignore
    }
  }
}

function formatFirmwareFooter(sizeText) {
  return `ファームウェア: ${FIRMWARE_URL} ｜ 同梱ファームウェア（Ver ${FIRMWARE_VERSION}）: ${sizeText}`;
}

async function loadBundledFirmware() {
  ui.firmwareInfo.textContent = formatFirmwareFooter("読み込み中…");
  ui.firmwareInfo.className = "firmware-info";

  try {
    const response = await fetch(FIRMWARE_URL, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    bundledFirmware = new Uint8Array(buffer);
    ui.firmwareInfo.textContent = formatFirmwareFooter(
      `${bundledFirmware.length.toLocaleString()} バイト`
    );
    ui.firmwareInfo.className = "firmware-info ok";
    log(`同梱ファームウェアを読み込みました（${bundledFirmware.length.toLocaleString()} バイト）`, "success");
  } catch (error) {
    bundledFirmware = null;
    ui.firmwareInfo.textContent = formatFirmwareFooter("見つかりません");
    ui.firmwareInfo.className = "firmware-info error";
    log(`同梱ファームウェアの取得に失敗: ${error.message}`, "warn");
  }
}

function onManualFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    manualFirmware = new Uint8Array(reader.result);
    ui.manualFileName.textContent = `${file.name}（${manualFirmware.length.toLocaleString()} バイト）`;
    ui.clearManualBtn.disabled = false;
    log(`手動ファイルを選択: ${file.name}`, "info");
  };
  reader.onerror = () => {
    log("手動ファイルの読み込みに失敗しました", "error");
  };
  reader.readAsArrayBuffer(file);
}

function clearManualSelection() {
  manualFirmware = null;
  ui.manualFile.value = "";
  ui.manualFileName.textContent = "ファイル未選択（自動取得を使用）";
  ui.clearManualBtn.disabled = true;
  log("手動選択を解除しました", "info");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describePort(info) {
  if (!info.usbVendorId) return "不明なポート";
  const vid = info.usbVendorId.toString(16).padStart(4, "0");
  const pid = info.usbProductId?.toString(16).padStart(4, "0") ?? "????";
  return `VID=${vid} PID=${pid}`;
}

function createSambaLogger() {
  return {
    debug: () => {},
    log: (msg, ...args) => {
      const text = String(msg) + (args.length ? " " + args.join(" ") : "");
      if (text.includes("Timed out after")) return;
      log(text);
    },
    error: (msg, ...args) => {
      const text = String(msg) + (args.length ? " " + args.join(" ") : "");
      if (text.includes("Timed out after")) return;
      log(text, "error");
    },
  };
}

function isPortOpen(port) {
  return Boolean(port?.readable || port?.writable);
}

async function ensurePortClosed(port) {
  if (!port) return;

  for (let i = 0; i < 5; i++) {
    if (!isPortOpen(port)) return;
    try {
      await port.close();
    } catch {
      // ignore
    }
    await sleep(150);
  }

  if (isPortOpen(port)) {
    throw new Error(
      "シリアルポートを解放できません。\n" +
        "Cursor のシリアルモニタ、PlatformIO Upload、Arduino IDE などが\n" +
        "COM ポートを占有していないか確認し、すべて閉じてから再試行してください。"
    );
  }
}

async function closePortQuietly(port) {
  await ensurePortClosed(port).catch(() => {});
}

async function probeBootloader(port) {
  if (!port) return false;

  await ensurePortClosed(port);

  let samba = null;
  try {
    samba = new SamBA(port, { debug: false, logger: createSambaLogger() });
    await samba.connect();
    await samba.disconnect();
    await ensurePortClosed(port);
    return true;
  } catch {
    try {
      if (samba) await samba.disconnect();
    } catch {
      // ignore
    }
    await ensurePortClosed(port).catch(() => {});
    return false;
  }
}

/**
 * Arduino IDE / bossac と同じ 1200bps タッチ + DTR 操作。
 * SAMD21 は 1200bps 接続後に DTR が落ちるとブートローダーへ入る。
 */
async function resetToBootloader(port) {
  log("1200bps タッチでブートローダーモードへ移行します…");
  setStatus(STATUS.RESETTING, "active");

  await ensurePortClosed(port);

  await port.open({
    baudRate: 1200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  });

  await port.setSignals({ dataTerminalReady: false });
  await sleep(100);
  await port.setSignals({ dataTerminalReady: true });
  await sleep(100);
  await port.setSignals({ dataTerminalReady: false });

  await closePortQuietly(port);
  log("リセット信号を送信しました。ブートローダーの再認識を待機しています…");
  await sleep(BOOTLOADER_WAIT_MS);
}

async function waitForBootloaderPort(preferredPort = null, timeoutMs = BOOTLOADER_POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ports = await navigator.serial.getPorts();
    const seen = new Set();
    const ordered = [];

    if (preferredPort) {
      ordered.push(preferredPort);
      seen.add(preferredPort);
    }
    for (const port of ports) {
      if (!seen.has(port)) {
        ordered.push(port);
        seen.add(port);
      }
    }

    for (const port of ordered) {
      if (await probeBootloader(port)) {
        log(`ブートローダーポートを検出: ${describePort(port.getInfo())}`);
        return port;
      }
    }

    await sleep(BOOTLOADER_POLL_MS);
  }

  return null;
}

function isLikelyAppPort(info) {
  return info.usbProductId === APP_USB_PID;
}

function isLikelyBootloaderPort(info) {
  return Boolean(info.usbProductId && BOOTLOADER_USB_PIDS.has(info.usbProductId));
}

async function connectBootloaderPort(userPort) {
  const info = userPort.getInfo();
  log(`ポートを選択しました（${describePort(info)}）`);

  // 通常モード (PID 802f): SAM-BA 接続は必ず失敗するので、1200bps タッチへ直行
  if (isLikelyAppPort(info) && !isLikelyBootloaderPort(info)) {
    log("通常モード (ToJ-002) を検出しました。ブートローダーへ移行します…");
    await ensurePortClosed(userPort);
    await resetToBootloader(userPort);

    const port = await waitForBootloaderPort(userPort);
    if (port) {
      log("ブートローダーポートへ自動再接続しました", "success");
      return port;
    }

    throw new Error(
      "ブートローダーへの移行後、再接続できませんでした。\n" +
        "① Cursor のシリアルモニタを閉じる\n" +
        "② リセットパッドを2回ショートして LED が点滅していることを確認\n" +
        "③ ブラウザを Ctrl+Shift+R でリロードし、もう一度ボタンを押す"
    );
  }

  if (isLikelyBootloaderPort(info)) {
    log("ブートローダーポート（PID）を検出しました", "success");
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await probeBootloader(userPort)) {
      log("ブートローダーモードを検出しました", "success");
      return userPort;
    }
    if (attempt < 3) {
      log(`接続再試行 (${attempt}/3)…`, "warn");
      await sleep(600);
    }
  }

  const port = await waitForBootloaderPort(userPort, 4000);
  if (port) {
    log("許可済みポートからブートローダーを検出しました", "success");
    return port;
  }

  throw new Error(
    "ブートローダーと通信できませんでした。\n" +
      "① リセットパッドを2回ショートし、オレンジLEDが点滅していること\n" +
      "② デバイスマネージャーで「Seeeduino XIAO (COMx)」が表示されていること\n" +
      "③ Cursor のシリアルモニタを閉じていること\n" +
      "④ ブラウザを Ctrl+Shift+R でリロードしてから、もう一度ボタンを押す\n" +
      "⑤ ポート選択で「Seeeduino XIAO」を選ぶ（MIDI デバイスではない）"
  );
}

// BOSSA と同じ CRC16（Arduino 拡張ブートローダーの Z コマンド検証用）
const CRC16_TABLE = [
  0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
  0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
  0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6,
  0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de,
  0x2462, 0x3443, 0x0420, 0x1401, 0x64e6, 0x74c7, 0x44a4, 0x5485,
  0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
  0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4,
  0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc,
  0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823,
  0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b,
  0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12,
  0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
  0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41,
  0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68, 0x9d49,
  0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70,
  0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78,
  0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f,
  0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
  0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e,
  0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256,
  0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d,
  0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
  0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c,
  0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
  0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab,
  0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3,
  0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a,
  0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92,
  0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9,
  0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
  0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8,
  0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0,
];

function checksumCalcBytes(data, crc16 = 0) {
  for (let i = 0; i < data.length; i++) {
    crc16 = ((crc16 << 8) ^ CRC16_TABLE[((crc16 >> 8) ^ data[i]) & 0xff]) & 0xffff;
  }
  return crc16;
}

/**
 * SAMD21 の Arduino ブートローダーは USB 経由のフラッシュ読み出し（R コマンド）に
 * 既知の不具合があり、書き込みは成功してもバイト比較検証が誤検出することがある。
 * bossac と同様、Z コマンド（CRC16）による検証を優先する。
 */
async function verifyFirmware(samba, firmware, flashOffset) {
  if (samba.canChecksumBuffer) {
    const blockSize = samba.checksumBufferSize();
    log(`CRC16 検証を使用します（ブロック ${blockSize} バイト）`);

    for (let offset = 0; offset < firmware.length; offset += blockSize) {
      const size = Math.min(blockSize, firmware.length - offset);
      const expected = checksumCalcBytes(firmware.subarray(offset, offset + size));
      const actual = await samba.checksumBuffer(flashOffset + offset, size);

      if (actual !== expected) {
        throw new Error(
          `検証エラー: オフセット 0x${(flashOffset + offset).toString(16)} (CRC 不一致)`
        );
      }

      const pct = Math.round(((offset + size) / firmware.length) * 100);
      setProgress(pct);
    }
    return;
  }

  // フォールバック: 63 バイト以下の非 2 乗チャンクで読み出し比較
  const chunkSize = 62;
  const verifyBuffer = new Uint8Array(chunkSize);
  log("CRC16 非対応のためバイト読み出しで検証します", "warn");

  for (let offset = 0; offset < firmware.length; offset += chunkSize) {
    const size = Math.min(chunkSize, firmware.length - offset);
    await samba.read(flashOffset + offset, verifyBuffer, size);

    for (let i = 0; i < size; i++) {
      if (verifyBuffer[i] !== firmware[offset + i]) {
        throw new Error(`検証エラー: オフセット 0x${(flashOffset + offset + i).toString(16)}`);
      }
    }

    const pct = Math.round(((offset + size) / firmware.length) * 100);
    setProgress(pct);
  }
}

async function runUpdate() {
  if (busy) return;

  const firmware = activeFirmware();
  if (!firmware) {
    log("書き込むファームウェアがありません。firmware.bin を配置するか、手動で .bin を選択してください。", "error");
    setStatus(STATUS.ERROR, "error");
    return;
  }

  if (!supportsSerial()) {
    log("Web Serial API が利用できません。", "error");
    setStatus(STATUS.ERROR, "error");
    return;
  }

  busy = true;
  ui.updateBtn.disabled = true;
  ui.manualFile.disabled = true;
  ui.clearManualBtn.disabled = true;
  setProgress(0);
  setStatus(STATUS.CONNECTING, "active");

  let port = null;
  let samba = null;

  try {
    log("シリアルポートの選択を待っています…");
    log("通常動作中の ToJ-002 を選ぶと、自動的にブートローダーモードへ移行します。");
    const userPort = await navigator.serial.requestPort({ filters: USB_FILTERS });
    port = await connectBootloaderPort(userPort);

    samba = new SamBA(port, {
      debug: false,
      logger: createSambaLogger(),
    });

    setStatus(STATUS.CONNECTING, "active");
    await samba.connect();
    log("SAM-BA ブートローダーに接続しました", "success");

    const device = new Device(samba);
    await device.create();

    const flash = device.flash;
    if (!flash) {
      throw new Error("フラッシュ情報を取得できませんでした");
    }

    let flashOffset = 0;
    if (
      device.family === Family.FAMILY_SAMD21 ||
      device.family === Family.FAMILY_SAMR21 ||
      device.family === Family.FAMILY_SAML21
    ) {
      flashOffset = BOOTLOADER_SIZE;
    }

    const available = flash.totalSize - flashOffset;
    if (firmware.length > available) {
      throw new Error(
        `ファームウェアが大きすぎます（${firmware.length} バイト > 利用可能 ${available} バイト）`
      );
    }

    log(
      `デバイス検出: ${flash.numPages} ページ × ${flash.pageSize} バイト、書き込み先 0x${flashOffset.toString(16).toUpperCase()}`
    );

    const flasher = new Flasher(samba, flash, {
      onStatus: (message) => {
        const text = message.trim();
        if (text) log(text);
      },
      onProgress: (current, total) => {
        if (total > 0) {
          const pct = Math.round((current / total) * 100);
          setStatus(STATUS.WRITING(pct), "active");
          setProgress(pct);
        }
      },
    });

    setStatus(STATUS.ERASING, "active");
    log("フラッシュ消去を開始します…");
    await flasher.erase(flashOffset);
    flash.eraseAuto = false;
    log("消去完了", "success");

    setStatus(STATUS.WRITING(0), "active");
    log("ファームウェア書き込みを開始します…");
    await flasher.write(firmware, flashOffset);
    log("書き込み完了", "success");

    setStatus(STATUS.VERIFYING, "active");
    setProgress(0);
    log("書き込み内容を検証しています…");
    await verifyFirmware(samba, firmware, flashOffset);
    log("検証完了", "success");

    log("デバイスをリセットします…");
    try {
      await device.reset();
    } catch {
      // reset で接続が切れるのは正常
    }

    try {
      await samba.disconnect();
    } catch {
      // ignore
    }

    try {
      await port.close();
    } catch {
      // ignore
    }

    setProgress(100);
    setStatus(STATUS.DONE, "success");
    log("アップデートが完了しました。ToJ-002 をお使いください。", "success");
  } catch (error) {
    if (error?.name === "NotFoundError") {
      log("ポート選択がキャンセルされました", "warn");
      setStatus(STATUS.IDLE);
    } else {
      const message = error?.message || String(error);
      for (const line of message.split("\n")) {
        if (line.trim()) log(line.trim(), "error");
      }
      setStatus(STATUS.ERROR, "error");
    }

    try {
      if (samba) await samba.disconnect();
    } catch {
      // ignore
    }
    try {
      if (port) await port.close();
    } catch {
      // ignore
    }
  } finally {
    busy = false;
    ui.updateBtn.disabled = false;
    ui.manualFile.disabled = false;
    ui.clearManualBtn.disabled = !manualFirmware;
    if (ui.statusText.textContent === STATUS.CONNECTING) {
      setStatus(STATUS.IDLE);
    }
  }
}

function init() {
  if (!supportsSerial()) {
    ui.browserWarning.hidden = false;
    ui.updateBtn.disabled = true;
    log("Web Serial API 非対応ブラウザです", "error");
  } else {
    log("準備完了。通常動作中の ToJ-002 を選べば自動でブートローダーへ移行します。");
  }

  ui.updateBtn.addEventListener("click", runUpdate);
  ui.manualFile.addEventListener("change", onManualFileSelected);
  ui.clearManualBtn.addEventListener("click", clearManualSelection);

  // Sprite editor bindings
  initSpriteEditor(ui, {
    onRedrawPreview: () => {
      previewStartMs = performance.now();
    },
  });

  ui.sendSpriteBtn?.addEventListener("click", async () => {
    try {
      await transferSpritesToDevice();
    } catch (e) {
      setMiniStatus("転送失敗", "error");
      log(`キャラクター転送に失敗: ${e?.message ?? e}`, "error");
    }
  });
  ui.resetSpriteBtn?.addEventListener("click", async () => {
    try {
      await resetSpritesOnDevice();
    } catch (e) {
      setMiniStatus("リセット失敗", "error");
      log(`キャラクターリセットに失敗: ${e?.message ?? e}`, "error");
    }
  });

  ui.shareSpriteBtn?.addEventListener("click", () => {
    openShareModal();
  });
  ui.shareCopyBtn?.addEventListener("click", () => {
    copyShareUrl();
  });
  ui.shareModal?.querySelectorAll("[data-share-close]").forEach((el) => {
    el.addEventListener("click", closeShareModal);
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && ui.shareModal && !ui.shareModal.hidden) {
      closeShareModal();
    }
  });

  ui.togglePreviewBtn?.addEventListener("click", () => {
    previewRunning = !previewRunning;
    if (previewRunning) {
      previewStartMs = performance.now();
      requestAnimationFrame(previewLoop);
    }
  });

  loadBundledFirmware();

  if (!loadSpritesFromQuery()) {
    setMiniStatus("未転送");
  }
  requestAnimationFrame(previewLoop);
}

init();
