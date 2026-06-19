const { mkdir, rm } = require("fs/promises");
const { readFileSync } = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const vm = require("vm");

const appRoot = path.join(__dirname, "..");
const ffmpeg = path.join(appRoot, "bin", "win", "ffmpeg.exe");
const template = path.join(appRoot, "public", "video-studio", "guoxue-template.mp4");
const outputRoot = path.join(appRoot, "tmp", "baseline-validation");
const evidenceRoot = path.join(appRoot, "pr-evidence", "text-baseline");
const PAPER_TEXT_END_SECONDS = 13;
const PAPER_INK_MAIN = "fontcolor=#423B2A@0.98";

const fixtures = [
  { slug: "wang-1991", clientName: "王先生", birthday: "1991年农历八月初六" },
  { slug: "ouyang-2000", clientName: "欧阳娜娜", birthday: "2000年1月1日" }
];

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

function textLength(value) {
  return Array.from(String(value || "")).length;
}

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

function birthdayLineLayersBefore({ chineseFont, digitFont, text, y }) {
  const length = textLength(text);
  const size = length > 12 ? 14 : length > 9 ? 15 : length > 6 ? 16 : 17;
  const tokens = birthdayTokens(text);
  const totalWidth = tokens.reduce((width, token) => width + birthdayTokenWidth(token, size), 0);
  let cursor = `(w-${Math.round(totalWidth)})/2`;
  const layers = [];

  tokens.forEach((token) => {
    const font = /^[0-9]+$/.test(token) ? digitFont : chineseFont;
    layers.push(...birthdayGlyphLayers({ font, text: token, x: cursor, y, size }));
    cursor = offsetExpression(cursor, Math.round(birthdayTokenWidth(token, size)));
  });

  return layers;
}

function birthdayLineLayersAfter({ chineseFont, text, y }) {
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

const HANDWRITING_JITTERS_BEFORE = [
  { dx: -1, dy: 0, scale: 1.03, advance: 0.95 },
  { dx: 1, dy: 0, scale: 0.98, advance: 0.96 },
  { dx: 0, dy: 0, scale: 1.01, advance: 0.98 },
  { dx: -1, dy: 0, scale: 0.99, advance: 0.96 },
  { dx: 1, dy: 0, scale: 1.02, advance: 0.95 },
  { dx: 0, dy: 0, scale: 1.00, advance: 0.97 },
  { dx: 1, dy: 0, scale: 1.01, advance: 0.96 },
  { dx: -1, dy: 0, scale: 0.99, advance: 0.97 }
];

const HANDWRITING_JITTERS_AFTER = [
  { dx: -1, dy: 0, advance: 0.95 },
  { dx: 1, dy: 1, advance: 0.96 },
  { dx: 0, dy: -1, advance: 0.98 },
  { dx: -1, dy: 0, advance: 0.96 },
  { dx: 1, dy: -1, advance: 0.95 },
  { dx: 0, dy: 1, advance: 0.97 },
  { dx: 1, dy: 0, advance: 0.96 },
  { dx: -1, dy: 0, advance: 0.97 }
];

function handwritingTextLayersBefore({ font, text, x, y, size, maxWidth, seed }) {
  const chars = Array.from(String(text || ""));
  const baseWidth = chars.reduce((width, char, index) => {
    if (char.trim() === "") return width + size * 0.35;
    const jitter = HANDWRITING_JITTERS_BEFORE[(index + seed) % HANDWRITING_JITTERS_BEFORE.length];
    return width + glyphWidth(char, size * jitter.scale) * jitter.advance;
  }, 0);
  const widthScale = baseWidth > maxWidth ? maxWidth / baseWidth : 1;
  let cursor = x;
  const layers = [];

  chars.forEach((char, index) => {
    if (char.trim() === "") {
      cursor += size * 0.35 * widthScale;
      return;
    }

    const jitter = HANDWRITING_JITTERS_BEFORE[(index + seed) % HANDWRITING_JITTERS_BEFORE.length];
    const charSize = Math.max(14, Math.round(size * jitter.scale * widthScale));
    const charX = Math.round(cursor + jitter.dx * widthScale);
    const charY = Math.round(y + jitter.dy * widthScale);
    layers.push(...markerGlyphLayers({ font, char, x: charX, y: charY, size: charSize }));
    cursor += glyphWidth(char, charSize) * jitter.advance;
  });

  return layers;
}

function handwritingTextLayersAfter({ font, text, x, y, size, maxWidth, seed }) {
  const chars = Array.from(String(text || ""));
  const baseWidth = chars.reduce((width, char, index) => {
    if (char.trim() === "") return width + size * 0.35;
    const jitter = HANDWRITING_JITTERS_AFTER[(index + seed) % HANDWRITING_JITTERS_AFTER.length];
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

    const jitter = HANDWRITING_JITTERS_AFTER[(index + seed) % HANDWRITING_JITTERS_AFTER.length];
    const charX = Math.round(cursor + jitter.dx * widthScale);
    const charY = Math.round(y + jitter.dy * widthScale);
    layers.push(...markerGlyphLayers({ font, char, x: charX, y: charY, size: charSize }));
    cursor += glyphWidth(char, charSize) * jitter.advance;
  });

  return layers;
}

function buildVideoFilter(input, mode) {
  if (mode === "after") {
    return buildVideoFilterFromMain(input);
  }

  const font = "fontfile=electron/fonts/Xingkai.ttc";
  const birthdayChineseFont = "fontfile=electron/fonts/Xingkai.ttc";
  const birthdayDigitFont = "fontfile=electron/fonts/lxgw-wenkai.ttf";
  const nameLength = textLength(input.clientName);
  const nameSize = nameLength > 4 ? 24 : nameLength > 3 ? 26 : 27;
  const enable = `lt(t,${PAPER_TEXT_END_SECONDS})`;
  const handwritingTextLayers = mode === "before" ? handwritingTextLayersBefore : handwritingTextLayersAfter;
  const birthdayLineLayers = mode === "before" ? birthdayLineLayersBefore : birthdayLineLayersAfter;

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
      digitFont: birthdayDigitFont,
      text: input.birthday,
      y: 42
    }),
    "colorkey=0xF4D91A:0.08:0.12",
    "perspective=x0=7:y0=0:x1=139:y1=5:x2=0:y2=89:x3=132:y3=96:sense=destination:interpolation=cubic[papertext]",
    `[0:v][papertext]overlay=x=184:y=520:enable='${enable}'[v]`
  ].join(",");
}

function buildVideoFilterFromMain(input) {
  const mainPath = path.join(appRoot, "electron-video-studio", "main.cjs");
  const source = `${readFileSync(mainPath, "utf8")}\nglobalThis.__buildVideoFilter = buildVideoFilter;`;
  const sandbox = {
    console,
    process: { ...process, platform: "win32", env: process.env },
    require(moduleName) {
      if (moduleName === "electron") {
        return {
          app: { whenReady: () => new Promise(() => undefined), on: () => undefined, quit: () => undefined },
          BrowserWindow: Object.assign(function BrowserWindow() {}, { getAllWindows: () => [] }),
          ipcMain: { handle: () => undefined },
          shell: {}
        };
      }
      return require(moduleName);
    },
    __dirname: path.join(appRoot, "electron-video-studio"),
    __filename: mainPath
  };
  vm.runInNewContext(source, sandbox, { filename: mainPath });
  return sandbox.__buildVideoFilter(input);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { cwd: appRoot, windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

async function renderFixture(fixture, mode) {
  const videoPath = path.join(outputRoot, `${fixture.slug}-${mode}.mp4`);
  const framePath = path.join(evidenceRoot, `${fixture.slug}-${mode}-frame.png`);
  const cropPath = path.join(evidenceRoot, `${fixture.slug}-${mode}-paper-crop.png`);
  const filter = buildVideoFilter(fixture, mode);
  const render = await runFfmpeg([
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-threads",
    "2",
    "-i",
    template,
    "-f",
    "lavfi",
    "-t",
    "4",
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
    videoPath
  ]);
  if (render.code !== 0) {
    throw new Error(`render ${fixture.slug} ${mode} failed:\n${render.stderr}`);
  }

  const frame = await runFfmpeg([
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-ss",
    "3",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    framePath
  ]);
  if (frame.code !== 0) {
    throw new Error(`frame ${fixture.slug} ${mode} failed:\n${frame.stderr}`);
  }

  const crop = await runFfmpeg([
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-i",
    framePath,
    "-vf",
    "crop=230:170:155:490,scale=920:680:flags=neighbor",
    "-frames:v",
    "1",
    cropPath
  ]);
  if (crop.code !== 0) {
    throw new Error(`crop ${fixture.slug} ${mode} failed:\n${crop.stderr}`);
  }

  return { videoPath, framePath, cropPath };
}

async function main() {
  const mode = process.argv[2];
  if (!["before", "after"].includes(mode)) {
    throw new Error("Usage: node scripts/render-baseline-fixtures.cjs <before|after>");
  }

  await mkdir(outputRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  if (mode === "before") {
    await rm(evidenceRoot, { recursive: true, force: true });
    await mkdir(evidenceRoot, { recursive: true });
  }

  for (const fixture of fixtures) {
    const result = await renderFixture(fixture, mode);
    console.log(`${mode} ${fixture.slug}`);
    console.log(`  video: ${result.videoPath}`);
    console.log(`  frame: ${result.framePath}`);
    console.log(`  crop:  ${result.cropPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
