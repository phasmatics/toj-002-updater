/**
 * ToJ-002 Firmware Updater
 * Web Serial + BOSSA (bossa-web) for Seeed XIAO SAMD21
 */

import { SamBA } from "https://esm.sh/bossa-web@0.9.7";
import { Device, Family } from "https://esm.sh/bossa-web@0.9.7";
import { Flasher } from "https://esm.sh/bossa-web@0.9.7";

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

function activeFirmware() {
  return manualFirmware ?? bundledFirmware;
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

  loadBundledFirmware();
}

init();
