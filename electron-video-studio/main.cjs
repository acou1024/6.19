const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { randomUUID } = require("crypto");
const { appendFile, mkdir, readdir, rm, stat, statfs } = require("fs/promises");
const { cpus, homedir, tmpdir } = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PAPER_TEXT_END_SECONDS = 13;
const ACCOUNTS = Array.from({ length: 10 }, (_, index) => `tt${index + 1}`);
const DEFAULT_PASSWORD = "13579";
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const PAPER_INK_MAIN = "fontcolor=#423B2A@0.98";

function appRoot() {
  return path.join(__dirname, "..");
}

function ffmpegPath() {
  if (process.platform === "win32") {
    return path.join(appRoot(), "bin", "win", "ffmpeg.exe");
  }
  return process.env.FFMPEG_PATH || "/Users/tt/Library/Application Support/bilibili/ffmpeg/ffmpeg";
}

function templatePath() {
  return path.join(appRoot(), "public", "video-studio", "guoxue-template.mp4");
}

function fontPath() {
  return path.join(appRoot(), "electron", "fonts", "Xingkai.ttc");
}

function birthdayChineseFontPath() {
  return fontPath();
}

function cleanText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 90);
}

function safeSegment(value) {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 40) || "output";
}

function escapeDrawText(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function escapeFilterPath(value) {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/ /g, "\\ ");
}

function drawTextFontOption() {
  if (process.platform === "win32") {
    return "fontfile=electron/fonts/Xingkai.ttc";
  }
  return `fontfile=${escapeFilterPath(fontPath())}`;
}

function drawBirthdayChineseFontOption() {
  if (process.platform === "win32") {
    return "fontfile=electron/fonts/Xingkai.ttc";
  }
  return `fontfile=${escapeFilterPath(birthdayChineseFontPath())}`;
}

function textLength(value) {
  return Array.from(String(value || "")).length;
}

function paperTextStyle(input) {
  const nameLength = textLength(input.clientName);
  const birthdayLength = textLength(input.birthday);

  return {
    nameSize: nameLength > 4 ? 33 : nameLength > 3 ? 37 : 40,
    birthdaySize: birthdayLength > 10 ? 19 : birthdayLength > 8 ? 21 : 24,
    nameX: nameLength > 3 ? 15 : 22,
    birthdayX: birthdayLength > 10 ? 8 : 13,
    nameY: 20,
    birthdayY: 63
  };
}

const HANDWRITING_JITTERS = [
  { dx: -1, dy: 0, advance: 0.95 },
  { dx: 1, dy: 1, advance: 0.96 },
  { dx: 0, dy: -1, advance: 0.98 },
  { dx: -1, dy: 0, advance: 0.96 },
  { dx: 1, dy: -1, advance: 0.95 },
  { dx: 0, dy: 1, advance: 0.97 },
  { dx: 1, dy: 0, advance: 0.96 },
  { dx: -1, dy: 0, advance: 0.97 }
];

function glyphWidth(char, size) {
  if (/[0-9]/.test(char)) return size * 0.48;
  if (/[A-Za-z]/.test(char)) return size * 0.54;
  if (/[年月日./·\-]/.test(char)) return size * 0.58;
  return size * 0.95;
}

function markerGlyphLayers({ font, char, x, y, size }) {
  const text = escapeDrawText(char);
  return [
    `drawtext=${[
      font,
      `text='${text}'`,
      `x=${x}`,
      `y=${y}`,
      `fontsize=${size}`,
      PAPER_INK_MAIN,
      "borderw=0"
    ].join(":")}`
  ];
}

function offsetExpression(value, offset) {
  return typeof value === "number" ? String(value + offset) : `${value}${offset >= 0 ? `+${offset}` : offset}`;
}

function markerLineLayers({ font, text, x, y, size, mainColor }) {
  return [
    `drawtext=${[
      font,
      `text='${text}'`,
      `x=${x}`,
      `y=${y}`,
      `fontsize=${size}`,
      mainColor,
      "borderw=0"
    ].join(":")}`
  ];
}

function birthdayTokens(text) {
  const chars = Array.from(String(text || ""));
  const tokens = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (/[0-9]/.test(char)) {
      let value = char;
      while (/[0-9]/.test(chars[index + 1] || "")) {
        index += 1;
        value += chars[index];
      }
      tokens.push(value);
    } else if (char === "农" && chars[index + 1] === "历") {
      tokens.push("农历");
      index += 1;
    } else {
      tokens.push(char);
    }
  }
  return tokens;
}

function birthdayTokenWidth(text, size) {
  if (/^[0-9]+$/.test(text)) return text.length * size * 0.5;
  if (text === "农历") return size * 1.85;
  if (/^[年月日]$/.test(text)) return size * 0.98;
  return Array.from(text).length * size * 0.96;
}

function birthdayGlyphLayers({ font, text, x, y, size }) {
  const escapedText = escapeDrawText(text);
  return [
    `drawtext=${[
      font,
      `text='${escapedText}'`,
      `x=${x}`,
      `y=${y}`,
      `fontsize=${size}`,
      PAPER_INK_MAIN,
      "borderw=0"
    ].join(":")}`
  ];
}

function birthdayLineLayers({ chineseFont, text, y }) {
  const length = textLength(text);
  const size = length > 12 ? 14 : length > 9 ? 15 : length > 6 ? 16 : 17;
  const tokens = birthdayTokens(text);
  const totalWidth = tokens.reduce((width, token) => width + birthdayTokenWidth(token, size), 0);
  let cursor = `(w-${Math.round(totalWidth)})/2`;
  const layers = [];

  tokens.forEach((token) => {
    layers.push(...birthdayGlyphLayers({ font: chineseFont, text: token, x: cursor, y, size }));
    cursor = offsetExpression(cursor, Math.round(birthdayTokenWidth(token, size)));
  });

  return layers;
}

function handwritingTextLayers({ font, text, x, y, size, maxWidth, seed }) {
  const chars = Array.from(String(text || ""));
  const baseWidth = chars.reduce((width, char, index) => {
    if (char.trim() === "") return width + size * 0.35;
    const jitter = HANDWRITING_JITTERS[(index + seed) % HANDWRITING_JITTERS.length];
    return width + glyphWidth(char, size) * jitter.advance;
  }, 0);
  const widthScale = baseWidth > maxWidth ? maxWidth / baseWidth : 1;
  const charSize = Math.max(14, Math.round(size * widthScale));
  let cursor = x;
  const layers = [];

  chars.forEach((char, index) => {
    if (char.trim() === "") {
      cursor += size * 0.35 * widthScale;
      return;
    }

    const jitter = HANDWRITING_JITTERS[(index + seed) % HANDWRITING_JITTERS.length];
    const charX = Math.round(cursor + jitter.dx * widthScale);
    const charY = Math.round(y + jitter.dy * widthScale);
    layers.push(...markerGlyphLayers({ font, char, x: charX, y: charY, size: charSize }));
    cursor += glyphWidth(char, charSize) * jitter.advance;
  });

  return layers;
}

async function writeErrorLog(errorText) {
  const logDir = path.join(homedir(), "Desktop", "国学视频成品");
  await mkdir(logDir, { recursive: true }).catch(() => undefined);
  const logPath = path.join(logDir, "错误日志.txt");
  const stamp = new Date().toLocaleString("zh-CN");
  await appendFile(logPath, `\n[${stamp}]\n${errorText}\n`, "utf8").catch(() => undefined);
  return logPath;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "未知";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)}GB`;
  return `${Math.round(value / 1024 / 1024)}MB`;
}

function explainError(error) {
  const code = error && typeof error === "object" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error || "");

  if (code === "ENOSPC" || message.includes("No space left") || message.includes("no space")) {
    return '生成失败：电脑磁盘空间不足，请先清理桌面"国学视频成品"和系统临时文件，至少保留 1GB 空间';
  }
  if (message.includes("电脑剩余空间不足")) {
    return `生成失败：${message}`;
  }
  if (message.includes("程序文件不完整")) {
    return `生成失败：${message}`;
  }
  if (message.includes("没有生成有效视频文件") || message.includes("输出视频文件没有生成")) {
    return "生成失败：输出视频没有正常生成，可能是 Windows 临时占用或安全软件拦截，程序已自动重试";
  }
  if (code === "EACCES" || code === "EPERM" || message.includes("permission")) {
    return "生成失败：没有写入权限，请不要把程序放在压缩包里运行，先完整解压到桌面后再打开";
  }
  if (code === "ENOENT") {
    return "生成失败：生成过程中的文件没有正常落盘，可能是 Windows 临时占用或安全软件拦截，程序已自动重试";
  }
  if (code === "EBUSY" || message.includes("busy")) {
    return "生成失败：输出文件被占用，请关闭正在播放或发送中的视频后再试";
  }
  return "生成失败：请查看错误日志并联系管理员";
}

async function ensureFreeSpace(targetDir) {
  if (typeof statfs !== "function") return;
  const disk = await statfs(targetDir).catch(() => null);
  if (!disk) return;
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);

  if (freeBytes < MIN_FREE_BYTES) {
    throw new Error(`电脑剩余空间不足，当前约 ${formatBytes(freeBytes)}，请至少保留 ${formatBytes(MIN_FREE_BYTES)} 后再生成`);
  }
}

async function cleanupOldTempFiles(tempRoot) {
  const entries = await readdir(tempRoot).catch(() => []);
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  await Promise.all(
    entries.map(async (entry) => {
      const isGeneratedTempFile = entry.includes(".tmp") || entry.endsWith("-input.mp4") || entry.endsWith("-output.mp4");
      if (!isGeneratedTempFile) return;

      const filePath = path.join(tempRoot, entry);
      const info = await stat(filePath).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await rm(filePath, { recursive: true, force: true }).catch(() => undefined);
      }
    })
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertRequiredFiles() {
  const requiredFiles = [
    { label: "ffmpeg.exe", filePath: ffmpegPath() },
    { label: "模板视频", filePath: templatePath() },
    { label: "姓名字体文件", filePath: fontPath() },
    { label: "生辰字体文件", filePath: birthdayChineseFontPath() }
  ];

  for (const item of requiredFiles) {
    const info = await stat(item.filePath).catch(() => null);
    if (!info || !info.isFile()) {
      throw new Error(`程序文件不完整：缺少${item.label}，请重新解压新版压缩包，不要只复制 exe`);
    }
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { cwd: appRoot(), windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function ffmpegThreads() {
  const totalCores = cpus().length;
  // Reserve 2 cores for system/Electron, floor at 2, cap at 4
  return Math.max(2, Math.min(4, totalCores - 2));
}

function parseDuration(stderr) {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function buildVideoFilter(input) {
  const font = drawTextFontOption();
  const birthdayChineseFont = drawBirthdayChineseFontOption();
  const nameLength = textLength(input.clientName);
  const nameSize = nameLength > 4 ? 24 : nameLength > 3 ? 26 : 27;
  const enable = `lt(t,${PAPER_TEXT_END_SECONDS})`;

  return [
    "[1:v]format=rgba",
    ...handwritingTextLayers({
      font,
      text: input.clientName,
      x: 52,
      y: 1,
      size: nameSize,
      maxWidth: 76,
      seed: 3
    }),
    ...birthdayLineLayers({
      chineseFont: birthdayChineseFont,
      text: input.birthday,
      y: 42
    }),
    "colorkey=0xF4D91A:0.08:0.12",
    "perspective=x0=7:y0=0:x1=139:y1=5:x2=0:y2=89:x3=132:y3=96:sense=destination:interpolation=cubic[papertext]",
    `[0:v][papertext]overlay=x=184:y=520:enable='${enable}'[v]`
  ].join(",");
}

async function generateVideo(input) {
  const account = cleanText(input.account, "tt1").toLowerCase();
  const clientName = cleanText(input.clientName, "缘主");
  const birthday = cleanText(input.birthday, "生辰未填");

  if (!ACCOUNTS.includes(account)) {
    throw new Error("员工账号不存在");
  }

  const jobId = randomUUID();
  const tempRoot = path.join(tmpdir(), "guoxue-video-studio");
  const outputDir = path.join(homedir(), "Desktop", "国学视频成品", safeSegment(account));
  const savedName = `${safeSegment(clientName)}_${safeSegment(birthday)}_${Date.now()}.mp4`;
  const savedPath = path.join(outputDir, savedName);
  let completed = false;

  try {
    await mkdir(tempRoot, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await assertRequiredFiles();
    await cleanupOldTempFiles(tempRoot);
    await cleanupOldTempFiles(outputDir);
    await ensureFreeSpace(outputDir);

    const probe = await runFfmpeg(["-hide_banner", "-i", templatePath()]);
    const duration = parseDuration(probe.stderr) || 60;
    const filter = buildVideoFilter({ clientName, birthday });

    let render = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await rm(savedPath, { force: true }).catch(() => undefined);
      render = await runFfmpeg([
        "-y",
        "-nostdin",
        "-loglevel",
        "error",
        "-threads",
        String(ffmpegThreads()),
        "-i",
        templatePath(),
        "-f",
        "lavfi",
        "-t",
        String(duration),
        "-i",
        "color=c=0xF4D91A:s=172x100:r=24",
        "-filter_complex",
        filter,
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "superfast",
        "-b:v",
        "300k",
        "-maxrate",
        "420k",
        "-bufsize",
        "600k",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        savedPath
      ]);

      if (render.code === 0) {
        const info = await stat(savedPath).catch(() => null);
        if (info && info.size) break;
        render = { code: 1, stderr: "FFmpeg 已结束，但输出视频文件没有生成" };
      }
      if (attempt < 3) await sleep(1500);
    }

    if (!render || render.code !== 0) {
      const logPath = await writeErrorLog(render?.stderr || "FFmpeg 生成失败");
      throw new Error(`生成失败，程序已自动重试仍未成功。请把桌面"国学视频成品"里的"错误日志.txt"发给管理员。日志位置：${logPath}`);
    }

    const outputInfo = await stat(savedPath);
    if (!outputInfo.size) {
      throw new Error("FFmpeg 已结束，但没有生成有效视频文件");
    }
    completed = true;
    return { savedPath, savedName };
  } finally {
    if (!completed) {
      await rm(savedPath, { force: true }).catch(() => undefined);
    }
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 720,
    title: "国学视频工作台",
    backgroundColor: "#f6f1e8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("generate-video", async (_event, input) => {
  try {
    return await generateVideo(input);
  } catch (error) {
    const userMessage = error instanceof Error ? error.message : String(error || "未知错误");
    const rawMessage = error instanceof Error ? `${error.message}\n${error.stack || ""}` : userMessage;
    const message = userMessage.includes("错误日志.txt")
      ? userMessage
      : `${explainError(error)}。请把桌面"国学视频成品"里的"错误日志.txt"发给管理员。日志位置：${await writeErrorLog(rawMessage)}`;
    return { error: message };
  }
});

ipcMain.handle("open-output-folder", async (_event, savedPath) => {
  if (savedPath) {
    shell.showItemInFolder(savedPath);
  }
});

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
