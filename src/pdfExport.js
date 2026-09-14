import { PDFDocument, rgb, StandardFonts, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import { buildCompetitorSchedules, buildStageList } from "./schedule.js";

const MM_TO_PT = 2.834645669;
const mmv = (v) => v * MM_TO_PT;

// Mirrors the constants in BadgeDesigner.jsx (which are raw CSS px at the
// designer's fixed 5.2px/mm canvas scale). Row-height constants were already
// being divided by 5.2 to convert to real mm — font sizes need EXACTLY the
// same treatment (px-at-scale -> mm -> pt), otherwise font size and row
// height end up on different unit bases and the text no longer fits the
// row the way it does in the browser preview. If you tune the font size in
// BadgeDesigner.jsx (SCHEDULE_FONT_SIZE_PX), change the raw px value here
// too — the /5.2 and mmv() conversion stays the same.
const SCHEDULE_FONT_SIZE_PX = 8.5;
const SCHEDULE_FONT_SIZE = mmv(SCHEDULE_FONT_SIZE_PX / 5.2);
const SCHEDULE_HEADER_H_MM = 14 / 5.2;
const SCHEDULE_SUBHEADER_H_MM = 12 / 5.2;
const SCHEDULE_ROW_H_MM = 13 / 5.2;
const SCHEDULE_BOTTOM_PADDING_MM = 0; // no longer needed now the font/row-height fit correctly
const SCHEDULE_QR_FONT_SIZE_PX = 11;
const SCHEDULE_QR_FONT_SIZE = mmv(SCHEDULE_QR_FONT_SIZE_PX / 5.2);
const SCHEDULE_TIME_W_MM = 40 / 5.2; // Tailwind w-10 = 40px, not "10px"
const SCHEDULE_TASK_W_MM = 36 / 5.2; // Tailwind w-9 = 36px, not "9px"
const SCHEDULE_COLORS = {
  headerBg: "#000000",
  headerText: "#ffffff",
  subheaderBg: "#f2f2f2",
  border: "#000000",
  timeCellBg: "#999999",
  lunchBg: "#999999",
  otherSpecialBg: "#f5a3c7",
};
const TASKKEY_HEADER_H_MM = SCHEDULE_SUBHEADER_H_MM;
const TASKKEY_ROW_H_MM = SCHEDULE_ROW_H_MM;
const TASKKEY_TASKS = [
  ["C", "Compete"],
  ["J", "Judge"],
  ["R", "Runner"],
  ["S", "Scrambler"],
];

function hexToRgb01(hex) {
  const h = (hex || "#000000").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Duotone tint via canvas: grayscale the source, then map black->color,
// white->white — same effect as PIL's ImageOps.colorize used server-side.
async function tintImageDataUrl(dataUrl, colorHex) {
  const img = await loadImageEl(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const h = colorHex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const cn = parseInt(full, 16);
  const cr = (cn >> 16) & 255, cg = (cn >> 8) & 255, cb = cn & 255;
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const t = gray / 255; // 0 = black -> tint color, 1 = white -> white
    d[i] = cr + (255 - cr) * t;
    d[i + 1] = cg + (255 - cg) * t;
    d[i + 2] = cb + (255 - cb) * t;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

// Precomposed (NFC) vs decomposed (NFD) Unicode matters a lot here: pdf-lib's
// standard fonts can't encode a bare combining accent mark at all (only the
// single precomposed character, e.g. "é" not "e" + combining acute) — so
// decomposed text doesn't just look different, it throws outright. Normalize
// every piece of user-facing text to NFC before it ever reaches a font.
function normText(s) {
  return s == null ? s : String(s).normalize("NFC");
}

function resolveTemplateStr(str, ctx) {
  return normText((str || "").replace(/\{(\w+)\}/g, (_, k) => (ctx[k] !== undefined && ctx[k] !== null ? ctx[k] : `{${k}}`)));
}

function resolveTextValue(field, ctx) {
  if (field.bindMode === "static") return normText(field.staticText ?? field.text ?? "");
  if (field.bindMode === "template") return resolveTemplateStr(field.template, ctx);
  const raw = ctx[field.source];
  const valueMap = field.valueMap || field.value_map;
  if (valueMap) {
    const found = valueMap.find((m) => m.value === raw);
    if (found) return normText(found.label);
  }
  return raw === undefined || raw === null ? "" : normText(String(raw));
}

function resolveMappingColor(field, ctx) {
  const val = ctx[field.mapSource];
  const found = (field.mappings || []).find((m) => m.value === val);
  return found ? found.color : field.fallbackColor || "#9CA3AF";
}

function resolveMappingImage(field, ctx) {
  const val = ctx[field.mapSource];
  const found = (field.mappings || []).find((m) => m.value === val);
  if (found && found.preview) return found.preview;
  return field.fallbackPreview || null;
}

// -------------------------------------------------------- unicode fallback

// pdf-lib throws when a font's encoding can't represent a character (e.g.
// the built-in Helvetica only supports WinAnsi — no CJK, no most emoji,
// etc.). Rather than crash generation, every piece of text is rendered
// CHARACTER BY CHARACTER, each glyph independently choosing whichever
// available font (the field's own, or any uploaded custom font) can
// actually render it. This is what lets a single name correctly mix
// scripts — e.g. a Latin family name next to a CJK given name — since no
// single font needs to cover everything, just each character somewhere.
// A character no available font can render becomes "?" rather than
// crashing the whole batch.
const PLACEHOLDER_GLYPH = "?";

function canEncode(font, text) {
  if (!text) return true;
  try {
    font.widthOfTextAtSize(text, 10);
    return true;
  } catch (e) {
    return false;
  }
}

function canRenderCodePoint(fontInfo, codePoint) {
  if (!fontInfo) return false;

  // Custom font uploaded through the Fonts panel: wrapped as
  // {pdfFont, fontkitFont} so we can ask fontkit directly.
  if (fontInfo.fontkitFont) {
    return fontInfo.fontkitFont.hasGlyphForCodePoint(codePoint);
  }

  // Everything else here is a raw pdf-lib PDFFont, not the wrapped
  // {pdfFont, fontkitFont} shape — this covers BOTH the built-in
  // fonts.helvetica/fonts.helveticaBold AND the Google-Fonts-backed
  // script fonts loaded by loadGoogleScriptFonts (fonts.custom['local:...']
  // is stored as a bare embedFont() result, no fontkitFont companion).
  // Without this branch, canRenderCodePoint always returned false for
  // any of these, which broke both plain-Helvetica text and the local
  // script font lookup in fontForChar below.
  const pdfFont = fontInfo.pdfFont || fontInfo;
  if (pdfFont && typeof pdfFont.encodeText === "function") {
    try {
      pdfFont.encodeText(String.fromCodePoint(codePoint));
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function pickFont(fonts, preferredFont, text) {
  if (canEncode(preferredFont, text)) return preferredFont;
  for (const family in fonts.custom) {
    const candidate = fonts.custom[family];
    if (candidate !== preferredFont && canEncode(candidate, text)) return candidate;
  }
  console.warn(`No available font (built-in or uploaded) can render "${text}" — it may appear blank or garbled. Upload a font with broader Unicode coverage in the Fonts panel.`);
  return preferredFont;
}

// Private Use Area codepoints (BMP: U+E000–U+F8FF, plus the two
// supplementary PUA planes) are never legitimate renderable text on their
// own — they're app-specific by definition. Notably, this is exactly the
// range macOS's "Last Resort" font uses as an on-screen placeholder for a
// glyph it couldn't find elsewhere. If these show up in real data, it
// almost always means the actual character was already lost upstream
// (e.g. copied from somewhere that couldn't render it in the first place)
// — so treat them as always-unencodable rather than let some font's cmap
// coincidentally "succeed" on them and produce more placeholder-looking
// output.
function isPrivateUse(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd);
}

// Country-based font selection previously lived here (a WCA country code
// mapped directly to a font family) but was removed at the maintainer's
// request — fontForChar below tries every "local:"-prefixed font in
// fonts.custom instead, regardless of the person's country. Script
// selection now happens earlier, at fetch time, in
// scriptFamilyForName()/loadGoogleScriptFonts() (see the "Google Fonts"
// section further down) — that's a per-NAME heuristic based on which
// Unicode blocks the name actually uses, not the competitor's country.
//
// Removing the country check here does reintroduce a real risk noted
// previously: probing multiple CID-keyed CJK fonts for the same codepoint
// has been known to corrupt pdf-lib/fontkit's internal subsetting state
// and throw deep inside its CFF encoder. Keep an eye out for that failure
// mode (generation throwing partway through a batch) if more than one CJK
// local font ends up loaded at once.

function fontForChar(fonts, preferredFont, ch) {
  if (isPrivateUse(ch)) return null;

  const codePoint = ch.codePointAt(0);

  if (canRenderCodePoint(preferredFont, codePoint)) {
    return preferredFont;
  }

  // preferredFont (the field's own font, whether that's Helvetica or a
  // font uploaded through the Fonts panel) can't render this codepoint —
  // treat that as "this is a foreign script that font just doesn't
  // cover" and try the Google-Fonts-backed script fonts (see
  // GOOGLE_FONT_FAMILIES / loadGoogleScriptFonts further down), without
  // regard to the person's country. Only fonts.custom keys prefixed
  // "local:" (or "auto:") are tried here — never other uploaded custom
  // fonts — to keep the pool of "foreign glyph" fonts to the ones meant
  // for this.
  for (const key in fonts.custom) {
    if (!key.startsWith("local:") && !key.startsWith("auto:")) continue;
    const candidate = fonts.custom[key];
    if (canRenderCodePoint(candidate, codePoint)) {
      return candidate;
    }
  }

  return null;
}


// Splits text into a per-character render plan: {glyph, font, width}. Each
// character independently picks the first available font that can encode
// it (field's own font first, then uploaded fonts in upload order); a
// character nothing can render becomes a "?" placeholder instead of
// crashing generation.
let warnedMissingGlyphs = new Set();
function buildCharPlan(fonts, preferredFont, text, size) {
  const plan = [];
  for (const ch of text) {
    let font = fontForChar(fonts, preferredFont, ch);
    let glyph = ch;
    if (!font) {
      if (!warnedMissingGlyphs.has(ch)) {
        console.log(ch, ch.codePointAt(0).toString(16), preferredFont, fonts.custom);
        warnedMissingGlyphs.add(ch);
        const codePointHex = `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
        if (isPrivateUse(ch)) {
          console.warn(`Character ${codePointHex} in the input data is a Private Use Area codepoint, not a real character — showing "${PLACEHOLDER_GLYPH}" instead. This usually means the actual character was already lost before it reached this app (e.g. copied from somewhere that couldn't render it). Check the source data (WCIF) for this field rather than uploading a font — no font can fix this.`);
        } else {
          console.warn(`No available font (built-in or uploaded) can render "${ch}" (${codePointHex}) — showing "${PLACEHOLDER_GLYPH}" instead. Upload a font with broader Unicode coverage in the Fonts panel to fix this.`);
        }
      }
      glyph = PLACEHOLDER_GLYPH;
    }
    const fontInfo = fontForChar(fonts, preferredFont, glyph);
    // fontInfo may be the wrapped {pdfFont, fontkitFont} shape (custom
    // uploaded fonts) or a raw pdf-lib PDFFont (fonts.helvetica/
    // fonts.helveticaBold, or a local script font from
    // loadGoogleScriptFonts) — normalize to the actual drawable PDFFont
    // either way.
    const pdfFont = fontInfo.pdfFont || fontInfo;

    plan.push({ glyph, font: pdfFont, width: pdfFont.widthOfTextAtSize(glyph, size) });
  }
  return plan;
}

function planWidth(plan, letterSpacing) {
  return plan.reduce((sum, p) => sum + p.width, 0) + letterSpacing * Math.max(plan.length - 1, 0);
}

function drawCharPlan(page, plan, x, y, size, letterSpacing, color) {
  let cursor = x;
  for (const { glyph, font, width } of plan) {
    page.drawText(glyph, { x: cursor, y, size, font, color });
    cursor += width + letterSpacing;
  }
}

// wrapLines needs to measure width the same mixed-font-aware way, since a
// pure "one font" measurement would be wrong for text mixing scripts.
function wrapLines(fonts, preferredFont, text, size, maxWidthPt, breakStyle) {
  const widthOf = (s) => planWidth(buildCharPlan(fonts, preferredFont, s, size), 0);
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const tokens = breakStyle === "break-all" ? paragraph.split("") : paragraph.split(" ");
    const sep = breakStyle === "break-all" ? "" : " ";
    let current = "";
    for (const token of tokens) {
      const trial = current ? current + sep + token : token;
      if (widthOf(trial) <= maxWidthPt || !current) {
        current = trial;
      } else {
        lines.push(current);
        current = token;
      }
    }
    lines.push(current);
  }
  return lines;
}

// originX/originY are the field's top-left anchor point, already resolved by
// the caller — either the field's absolute page position, or (0,0) if a
// rotation transform is already active on the page's graphics state (see
// generateBadgesPdf's dispatch loop, which is the ONLY place rotation is
// applied — every draw*Field function below just draws at a plain anchor
// and never touches field.rotate itself).
function drawTextField(page, field, ctx, fonts, originX, originY) {
  const value = resolveTextValue(field, ctx);
  const isBold = (field.font || "").includes("Bold");
  const isCustom = fonts.custom[field.font];
  const preferredFont = isCustom || (isBold ? fonts.helveticaBold : fonts.helvetica);
  const color = hexToRgb01(field.color || "#000000");
  const align = field.align || "left";
  const letterSpacing = field.letterSpacing || field.letter_spacing || 0;
  const isWrap = !!field.wrap;
  const boxW = isWrap ? mmv(field.w_mm || 60) : null;

  let size;
  if (field.size_min !== undefined && field.size_min !== null) {
    size = field.size_max || 16;
    // Measure the widest individual line, not `value` as one string — a
    // multi-line value (hard "\n" breaks, e.g. from a value-map label)
    // would otherwise get its lines' widths summed together as if it
    // were one long line, shrinking the font far more than necessary.
    const widestLineWidth = (sz) =>
      Math.max(...value.split("\n").map((line) => planWidth(buildCharPlan(fonts, preferredFont, line, sz), letterSpacing)));
    while (widestLineWidth(size) > mmv(field.max_width_mm || 60) && size > (field.size_min || 8)) size -= 0.5;
  } else {
    size = field.size || 12;
  }

  const drawLine = (text, lineTopY) => {
    const plan = buildCharPlan(fonts, preferredFont, text, size);
    const textW = planWidth(plan, letterSpacing);
    let offset = 0;
    if (isWrap) {
      if (align === "center") offset = (boxW - textW) / 2;
      else if (align === "right") offset = boxW - textW;
    } else {
      if (align === "center") offset = -textW / 2;
      else if (align === "right") offset = -textW;
    }
    const baselineY = lineTopY - size * 0.75;
    drawCharPlan(page, plan, originX + offset, baselineY, size, letterSpacing, color);
  };

  if (isWrap) {
    const lines = wrapLines(fonts, preferredFont, value, size, boxW, field.breakStyle || field.break_style || "break-word");
    const lineHeightPt = size * (field.lineHeight || field.line_height || 1.05);
    lines.forEach((line, i) => drawLine(line, originY - i * lineHeightPt));
  } else {
    // Not wrapped to a box width, but an explicit "\n" (e.g. from a
    // static/template textarea, or a value-map label) should still break
    // into multiple lines — "wrap" only controls automatic word-wrap to
    // fit boxW, it shouldn't gate hard line breaks.
    const rawLines = value.split("\n");
    const lineHeightPt = size * (field.lineHeight || field.line_height || 1.05);
    rawLines.forEach((line, i) => drawLine(line, originY - i * lineHeightPt));
  }
}

async function drawImageField(page, field, ctx, pdfDoc, imageCache, originX, originY) {
  let src = null;
  if (field.mapped) {
    src = resolveMappingImage(field, ctx);
  } else {
    src = field.preview || null;
  }
  if (!src) return;

  const embedded = await embedImageCached(pdfDoc, src, imageCache);
  if (!embedded) return;

  const boxW = mmv(field.w_mm);
  const boxH = mmv(field.h_mm);

  // Match the designer canvas's `object-contain` rendering (see FieldBox's
  // "w-full h-full object-contain" for image fields): scale the image to
  // fit inside the field's box while preserving its own aspect ratio, then
  // center it in the box. Drawing at boxW x boxH directly (the old
  // behavior) stretches the image to the box's aspect ratio instead of the
  // image's own, which is what made an image with an aspect ratio different
  // from its field come out squashed/stretched compared to the template.
  const imgAspect = embedded.width / embedded.height;
  const boxAspect = boxW / boxH;
  let w = boxW;
  let h = boxH;
  if (imgAspect > boxAspect) {
    w = boxW;
    h = boxW / imgAspect;
  } else {
    h = boxH;
    w = boxH * imgAspect;
  }
  const x = originX + (boxW - w) / 2;
  const y = originY - boxH + (boxH - h) / 2;

  page.drawImage(embedded, { x, y, width: w, height: h });
}

async function embedImageCached(pdfDoc, dataUrl, cache) {
  if (cache.has(dataUrl)) return cache.get(dataUrl);
  try {
    const bytes = dataUrlToBytes(dataUrl);
    const isPng = dataUrl.startsWith("data:image/png");
    const embedded = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    cache.set(dataUrl, embedded);
    return embedded;
  } catch (e) {
    console.error("Failed to embed image", e);
    return null;
  }
}

function drawColorblockField(page, field, ctx, originX, originY) {
  const w = mmv(field.w_mm);
  const h = mmv(field.h_mm);
  const y = originY - h;
  const colorHex = resolveMappingColor(field, ctx);
  const opacity = (field.opacity ?? 100) / 100;

  page.drawRectangle({ x: originX, y, width: w, height: h, color: hexToRgb01(colorHex), opacity });

  if (field.labelSource) {
    const label = String(ctx[field.labelSource] || "").toUpperCase();
    if (label) {
      page.drawText(label, {
        x: originX + mmv(4),
        y: y + h / 2 - 3.3,
        size: 11,
        color: hexToRgb01(field.labelColor || "#FFFFFF"),
      });
    }
  }
}

async function drawQrField(page, field, ctx, pdfDoc, imageCache, originX, originY) {
  const target = resolveTemplateStr(field.target, ctx);
  const dataUrl = await QRCode.toDataURL(target, { margin: 1, width: 300 });
  const embedded = await embedImageCached(pdfDoc, dataUrl, imageCache);
  if (!embedded) return;
  const size = mmv(field.size_mm);
  page.drawImage(embedded, { x: originX, y: originY - size, width: size, height: size });
}

function formatDayTitle(dateStr) {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
    const month = date.toLocaleDateString("en-US", { month: "long" });
    const nth = (n) => ["th", "st", "nd", "rd"][n % 10 > 3 || Math.floor((n % 100) / 10) === 1 ? 0 : n % 10];
    return `${weekday}, ${month} ${d}${nth(d)}`;
  } catch (e) {
    return dateStr;
  }
}

function drawScheduleField(page, field, ctx, fonts, originX, originY) {
  const x0 = originX;
  const wMm = field.w_mm;
  const w = mmv(wMm);

  const dayIdx = field.dayIndex || 0;
  const excluded = new Set(field.excludedIds || []);
  const schedules = ctx.schedules || {};
  const days = Object.keys(schedules).sort();
  const activeDay = days[dayIdx];
  const headerTitle = field.customTitle || (activeDay ? formatDayTitle(activeDay) : "Schedule");
  const allRows = (activeDay && schedules[activeDay]) || [];
  const rows = allRows.filter((r) => !excluded.has(String(r.id || `${r.time}_${r.event}`))).map((r) => ({ ...r, event: normText(r.event) }));

  // Group consecutive subsequent-round rows into merged "QR" blocks.
  const blocks = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (!r.isSpecial && r.isSubsequentRound) {
      let j = i;
      while (j < rows.length && !rows[j].isSpecial && rows[j].isSubsequentRound) j++;
      blocks.push({ type: "qr-group", rows: rows.slice(i, j) });
      i = j;
    } else {
      blocks.push({ type: "single", row: r });
      i++;
    }
  }

  const rowCounts = blocks.map((b) => (b.type === "qr-group" ? b.rows.length : 1));
  const totalHMm = SCHEDULE_HEADER_H_MM + SCHEDULE_SUBHEADER_H_MM + rowCounts.reduce((a, b) => a + b, 0) * SCHEDULE_ROW_H_MM + SCHEDULE_BOTTOM_PADDING_MM;
  const topY = originY;
  const timeW = mmv(SCHEDULE_TIME_W_MM);
  const taskW = mmv(SCHEDULE_TASK_W_MM);
  const black = rgb(0, 0, 0);

  const hline = (y, x1, x2) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color: hexToRgb01(SCHEDULE_COLORS.border) });
  const vline = (x, y1, y2) => page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: 0.5, color: hexToRgb01(SCHEDULE_COLORS.border) });
  const centered = (text, cx, cy, font, size, color = black) => {
    const tw = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: cx - tw / 2, y: cy - size * 0.35, size, font, color });
  };

  // header bar
  page.drawRectangle({ x: x0, y: topY - mmv(SCHEDULE_HEADER_H_MM), width: w, height: mmv(SCHEDULE_HEADER_H_MM), color: hexToRgb01(SCHEDULE_COLORS.headerBg) });
  centered(headerTitle, x0 + w / 2, topY - mmv(SCHEDULE_HEADER_H_MM) / 2, fonts.helveticaBold, SCHEDULE_FONT_SIZE, hexToRgb01(SCHEDULE_COLORS.headerText));

  // subheader
  const subY = topY - mmv(SCHEDULE_HEADER_H_MM);
  page.drawRectangle({ x: x0, y: subY - mmv(SCHEDULE_SUBHEADER_H_MM), width: w, height: mmv(SCHEDULE_SUBHEADER_H_MM), color: hexToRgb01(SCHEDULE_COLORS.subheaderBg) });
  const labelY = subY - mmv(SCHEDULE_SUBHEADER_H_MM) / 2;
  centered("Time", x0 + timeW / 2, labelY, fonts.helveticaBold, SCHEDULE_FONT_SIZE);
  centered("Event", x0 + timeW + (w - timeW - taskW) / 2, labelY, fonts.helveticaBold, SCHEDULE_FONT_SIZE);
  centered("Task", x0 + w - taskW / 2, labelY, fonts.helveticaBold, SCHEDULE_FONT_SIZE);
  hline(subY - mmv(SCHEDULE_SUBHEADER_H_MM), x0, x0 + w);
  vline(x0 + timeW, subY, subY - mmv(SCHEDULE_SUBHEADER_H_MM));
  vline(x0 + w - taskW, subY, subY - mmv(SCHEDULE_SUBHEADER_H_MM));

  let curY = subY - mmv(SCHEDULE_SUBHEADER_H_MM);

  // Two passes: fills+text first, then ALL border lines on top. This is
  // deliberate — a later row's opaque background fill would otherwise
  // paint over the shared border line from the row above it, since fills
  // and lines were previously interleaved row-by-row.
  const layout = []; // { block, topY, bottomY }
  for (const block of blocks) {
    const h = block.type === "qr-group" ? mmv(block.rows.length * SCHEDULE_ROW_H_MM) : mmv(SCHEDULE_ROW_H_MM);
    layout.push({ block, topY: curY, bottomY: curY - h, h });
    curY -= h;
  }
  const tableBottomY = curY;

  // Pass 1: fills + text
  for (const { block, topY: rowTop } of layout) {
    if (block.type === "qr-group") {
      const groupRows = block.rows;
      const groupColor = groupRows.find((r) => r.color)?.color;
      page.drawRectangle({ x: x0 + w - taskW, y: rowTop - mmv(groupRows.length * SCHEDULE_ROW_H_MM), width: taskW, height: mmv(groupRows.length * SCHEDULE_ROW_H_MM), color: hexToRgb01(groupColor || "#ffffff") });
      centered("QR", x0 + w - taskW / 2, rowTop - mmv(groupRows.length * SCHEDULE_ROW_H_MM) / 2, fonts.helveticaBold, SCHEDULE_QR_FONT_SIZE);

      let subY2 = rowTop;
      groupRows.forEach((r) => {
        const rowH = mmv(SCHEDULE_ROW_H_MM);
        page.drawRectangle({ x: x0 + timeW, y: subY2 - rowH, width: w - timeW - taskW, height: rowH, color: hexToRgb01(r.color || "#ffffff") });
        page.drawRectangle({ x: x0, y: subY2 - rowH, width: timeW, height: rowH, color: hexToRgb01(SCHEDULE_COLORS.timeCellBg) });
        centered(r.time, x0 + timeW / 2, subY2 - rowH / 2, fonts.helvetica, SCHEDULE_FONT_SIZE);
        centered(r.event, x0 + timeW + (w - timeW - taskW) / 2, subY2 - rowH / 2, fonts.helveticaBold, SCHEDULE_FONT_SIZE);
        subY2 -= rowH;
      });
    } else {
      const r = block.row;
      const rowH = mmv(SCHEDULE_ROW_H_MM);
      const isSpecial = r.isSpecial || /lunch|dinner|opening|awards|tutorial/i.test(r.event);

      if (!isSpecial) {
        page.drawRectangle({ x: x0, y: rowTop - rowH, width: w, height: rowH, color: hexToRgb01(r.color || "#ffffff") });
      }
      page.drawRectangle({ x: x0, y: rowTop - rowH, width: timeW, height: rowH, color: hexToRgb01(SCHEDULE_COLORS.timeCellBg) });
      centered(r.time, x0 + timeW / 2, rowTop - rowH / 2, fonts.helvetica, SCHEDULE_FONT_SIZE);

      if (isSpecial) {
        const bg = /lunch|dinner/i.test(r.event) ? SCHEDULE_COLORS.lunchBg : SCHEDULE_COLORS.otherSpecialBg;
        page.drawRectangle({ x: x0 + timeW, y: rowTop - rowH, width: w - timeW, height: rowH, color: hexToRgb01(r.specialColor || bg) });
        centered(r.event.toUpperCase(), x0 + timeW + (w - timeW) / 2, rowTop - rowH / 2, fonts.helveticaBold, SCHEDULE_FONT_SIZE);
      } else {
        centered(r.event, x0 + timeW + (w - timeW - taskW) / 2, rowTop - rowH / 2, fonts.helveticaBold, SCHEDULE_FONT_SIZE);
        page.drawRectangle({ x: x0 + w - taskW, y: rowTop - rowH, width: taskW, height: rowH, color: hexToRgb01(r.color || "#ffffff") });
        centered(r.task || "", x0 + w - taskW / 2, rowTop - rowH / 2, fonts.helveticaBold, SCHEDULE_FONT_SIZE);
      }
    }
  }

  // Pass 2: border lines, drawn last so nothing can paint over them.
  // Every row/block boundary gets a full-width horizontal line, and every
  // block gets its own vertical dividers — EXCEPT a QR-group's merged task
  // cell, which deliberately has no internal dividers (that's the point of
  // merging it), just its own single outer rectangle border.
  hline(topY, x0, x0 + w); // top of table (== bottom of header, drawn again here for full opacity)
  for (const { block, topY: rowTop, bottomY, h } of layout) {
    if (block.type === "qr-group") {
      let subY2 = rowTop;
      block.rows.forEach((_, k) => {
        const rowH = mmv(SCHEDULE_ROW_H_MM);
        if (k > 0) hline(subY2, x0, x0 + w - taskW);
        vline(x0 + timeW, subY2, subY2 - rowH);
        subY2 -= rowH;
      });
      vline(x0 + w - taskW, rowTop, bottomY);
      page.drawRectangle({ x: x0 + w - taskW, y: bottomY, width: taskW, height: h, borderColor: hexToRgb01(SCHEDULE_COLORS.border), borderWidth: 0.5 });
    } else {
      const isSpecial = block.row.isSpecial || /lunch|dinner|opening|awards|tutorial/i.test(block.row.event);
      vline(x0 + timeW, rowTop, bottomY);
      if (!isSpecial) vline(x0 + w - taskW, rowTop, bottomY);
    }
    hline(bottomY, x0, x0 + w);
  }

  // outer border on top of everything
  page.drawRectangle({ x: x0, y: tableBottomY, width: w, height: topY - tableBottomY, borderColor: hexToRgb01(SCHEDULE_COLORS.border), borderWidth: 0.6 });
}

function drawTaskKeyField(page, field, ctx, fonts, originX, originY) {
  const x0 = originX;
  const w = mmv(field.w_mm);
  const half = w / 2;

  const stages = ctx.stages && ctx.stages.length > 0 ? ctx.stages : [{ name: "Stage 1", color: "#1E5FD9" }, { name: "Stage 2", color: "#B8860B" }];
  const overrides = field.stageNames || [];
  const stageRows = stages.map((s, i) => ({
    name: normText(overrides[i] && overrides[i].trim() ? overrides[i].trim() : s.name),
    color: s.color,
  }));

  const rowCount = Math.max(TASKKEY_TASKS.length, stageRows.length);
  const totalHMm = TASKKEY_HEADER_H_MM + rowCount * TASKKEY_ROW_H_MM;
  const topY = originY;
  const rowH = mmv(TASKKEY_ROW_H_MM);

  const centered = (text, cx, cy, font, size, color = rgb(0, 0, 0)) => {
    const tw = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: cx - tw / 2, y: cy - size * 0.35, size, font, color });
  };

  // Pass 1: fills (always opaque — white by default) + text
  [["Task", TASKKEY_TASKS], ["Stage", stageRows]].forEach(([label, items], col) => {
    const cx0 = x0 + col * half;
    page.drawRectangle({ x: cx0, y: topY - mmv(TASKKEY_HEADER_H_MM), width: half, height: mmv(TASKKEY_HEADER_H_MM), color: hexToRgb01(SCHEDULE_COLORS.subheaderBg) });
    centered(label, cx0 + half / 2, topY - mmv(TASKKEY_HEADER_H_MM) / 2, fonts.helveticaBold, SCHEDULE_FONT_SIZE);

    let rowY = topY - mmv(TASKKEY_HEADER_H_MM);
    for (let i = 0; i < rowCount; i++) {
      if (col === 0) {
        page.drawRectangle({ x: cx0, y: rowY - rowH, width: half, height: rowH, color: hexToRgb01("#ffffff") });
        if (i < items.length) {
          const [code, meaning] = items[i];
          page.drawText(code, { x: cx0 + mmv(1.5), y: rowY - rowH / 2 - SCHEDULE_FONT_SIZE * 0.35, size: SCHEDULE_FONT_SIZE, font: fonts.helveticaBold });
          const eqW = fonts.helveticaBold.widthOfTextAtSize(`${code} = `, SCHEDULE_FONT_SIZE);
          page.drawText(meaning, { x: cx0 + mmv(1.5) + eqW, y: rowY - rowH / 2 - SCHEDULE_FONT_SIZE * 0.35, size: SCHEDULE_FONT_SIZE, font: fonts.helvetica });
          page.drawText(" = ", { x: cx0 + mmv(1.5) + fonts.helveticaBold.widthOfTextAtSize(code, SCHEDULE_FONT_SIZE), y: rowY - rowH / 2 - SCHEDULE_FONT_SIZE * 0.35, size: SCHEDULE_FONT_SIZE, font: fonts.helveticaBold });
        }
      } else {
        const s = i < items.length ? items[i] : null;
        page.drawRectangle({ x: cx0, y: rowY - rowH, width: half, height: rowH, color: hexToRgb01(s ? s.color : "#ffffff") });
        if (s) {
          const nameFont = pickFont(fonts, fonts.helveticaBold, s.name);
          page.drawText(s.name, { x: cx0 + mmv(1.5), y: rowY - rowH / 2 - SCHEDULE_FONT_SIZE * 0.35, size: SCHEDULE_FONT_SIZE, font: nameFont });
        }
      }
      rowY -= rowH;
    }
  });

  // Pass 2: border lines on top, so fills can never cover them
  for (let i = 1; i < rowCount; i++) {
    const y = topY - mmv(TASKKEY_HEADER_H_MM) - i * rowH;
    page.drawLine({ start: { x: x0, y }, end: { x: x0 + w, y }, thickness: 0.3, color: hexToRgb01(SCHEDULE_COLORS.border) });
  }
  page.drawLine({ start: { x: x0 + half, y: topY }, end: { x: x0 + half, y: topY - mmv(totalHMm) }, thickness: 0.5, color: hexToRgb01(SCHEDULE_COLORS.border) });
  page.drawLine({ start: { x: x0, y: topY - mmv(TASKKEY_HEADER_H_MM) }, end: { x: x0 + w, y: topY - mmv(TASKKEY_HEADER_H_MM) }, thickness: 0.5, color: hexToRgb01(SCHEDULE_COLORS.border) });
  page.drawRectangle({ x: x0, y: topY - mmv(totalHMm), width: w, height: mmv(totalHMm), borderColor: hexToRgb01(SCHEDULE_COLORS.border), borderWidth: 0.6 });
}

// ------------------------------------------------- local bundled fonts

// A locally-bundled font file is far more reliable than fetching from
// Google Fonts: it's one plain, complete font you control directly, with
// no pre-subsetting, no WOFF2 compression quirks, and no risk of Google
// splitting the family into several unicode-range files and this code
// guessing the wrong one — all three of which turned out to be real,
// confirmed bugs in the automatic-fetch path below. Checked FIRST, before
// the automatic fetch, so a bundled font always takes priority.
//
// Place font files anywhere your build serves as a static asset (e.g. a
// Vite project's `public/assets/fonts/` folder is served at the site root)
// and list them here, keyed by whatever family name you want them to
// Rather than bundling script fonts as local files (which can go stale,
// get skipped in a deploy, or simply be the wrong file), these are fetched
// on demand from Google Fonts, subsetted to only the characters actually
// needed by this batch of competitors. A single Noto Sans JP weight is
// ~3.4MB in full — subsetting to e.g. one person's name-worth of
// characters is a few KB, so this is also far cheaper than shipping (or
// fetching) the whole family.
//
// Family -> heuristic detector is handled in scriptFamilyForName() below;
// this set just controls which family names are legal targets.
const GOOGLE_FONT_FAMILIES = ["Noto Sans KR", "Noto Sans JP", "Noto Sans SC", "Noto Sans TC"];

// A name is written in one language, so classification happens per NAME,
// not per character — a bare Han character means nothing about which
// regional font it should use on its own (see the 朱星宇-style ambiguity:
// simplified and traditional Chinese share most Han glyphs outright).
// Presence of Hangul or Kana anywhere in the name is an unambiguous
// signal; bare Han falls back to a modest curated list of
// traditional-only characters before defaulting to Simplified, which is
// the more common case. This is a heuristic, not a real classifier —
// extend TRADITIONAL_ONLY_HINTS or swap in real per-competitor script
// data if you have it.
const TRADITIONAL_ONLY_HINTS = new Set("國華們學東車長龍灣體東台鄉會語");

function scriptFamilyForName(name) {
  if (!name) return null;
  const hasHangul = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(name);
  if (hasHangul) return "Noto Sans KR";
  const hasKana = /[\u3040-\u30FF]/.test(name);
  if (hasKana) return "Noto Sans JP";
  const hasHan = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(name);
  if (!hasHan) return null;
  for (const ch of name) {
    if (TRADITIONAL_ONLY_HINTS.has(ch)) return "Noto Sans TC";
  }
  return "Noto Sans SC";
}

// Scans every accepted person's name, buckets the non-ASCII characters by
// which Google Font family they'll need, and returns { family: Set<char> }
// — one Set per family, deduped, so each family is fetched exactly once
// per generation covering every person who needs it.
function collectGoogleFontRequirements(persons) {
  const byFamily = {};
  for (const person of persons) {
    const name = person.name || "";
    const family = scriptFamilyForName(name);
    if (!family) continue;
    const set = byFamily[family] || (byFamily[family] = new Set());
    for (const ch of name) {
      if (ch.codePointAt(0) > 0x7f) set.add(ch);
    }
  }
  return byFamily;
}

// Wraps a promise with a hard deadline: if it hasn't settled by `ms`, this
// rejects instead of leaving the caller waiting indefinitely. Needed here
// because none of fetch(), a WASM module's own init, or a stalled network
// connection reject on their own if something upstream just silently drops
// packets (a filtered/firewalled request typically hangs, it doesn't
// error) — without this, one bad network condition or a broken WASM
// decoder install blocks the ENTIRE PDF generation forever with no
// error surfaced anywhere, which is exactly the "stuck on Starting..."
// symptom this was added to fix.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Hits the Google Fonts CSS2 API for exactly `text`, pulls the resulting
// @font-face src url out of the returned CSS, and fetches those bytes.
// With a `text=` param Google always returns a single @font-face block
// (no unicode-range splitting), so one regex match is enough.
async function fetchGoogleFontBytes(family, text) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&text=${encodeURIComponent(text)}&display=swap`;
  const cssController = new AbortController();
  const cssRes = await withTimeout(
    fetch(cssUrl, { mode: "cors", signal: cssController.signal }),
    8000,
    `Google Fonts CSS request for "${family}"`
  ).catch((e) => { cssController.abort(); throw e; });
  if (!cssRes.ok) throw new Error(`HTTP ${cssRes.status} fetching Google Fonts CSS for "${family}"`);
  const css = await cssRes.text();
  const match = css.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)\s*format\('(\w+)'\)/);
  if (!match) throw new Error(`Google Fonts CSS for "${family}" had no usable font url in it: ${css.slice(0, 200)}`);
  const [, fontUrl, format] = match;
  const fontController = new AbortController();
  const fontRes = await withTimeout(
    fetch(fontUrl, { mode: "cors", signal: fontController.signal }),
    8000,
    `Google Fonts file download for "${family}"`
  ).catch((e) => { fontController.abort(); throw e; });
  if (!fontRes.ok) throw new Error(`HTTP ${fontRes.status} fetching the font file for "${family}"`);
  const bytes = new Uint8Array(await fontRes.arrayBuffer());
  return { bytes, format };
}

// Browser fetch() can't force Google to hand back a bare .ttf/.otf (that
// selection happens server-side off the User-Agent header, which fetch()
// can't override), so this will always be WOFF2 in practice — and WOFF2
// is NOT something to hand to pdfDoc.embedFont() directly. It's not a
// bare sfnt: table data (notably glyf/loca) is stored in a transformed,
// Brotli-compressed layout specific to WOFF2, not the raw TrueType/
// OpenType structure pdf-lib/fontkit expect. Some fontkit builds don't
// throw on WOFF2 bytes — they read enough of the wrapper to proceed
// without error — but what gets embedded is a malformed subset: no crash
// during generation, but PDF readers doing real validation (Acrobat, in
// particular) report they can't extract the embedded font, and affected
// characters may not display or print. Chrome's viewer and others are
// often lenient enough about broken font tables to mask this, which is
// why it can look fine there.
//
// So WOFF2 is always decompressed to a real sfnt BEFORE embedFont ever
// sees it — never "try raw bytes first". Uses `woff2-encoder`'s
// decompress-only build (`woff2-encoder/decompress`) rather than the more
// commonly-referenced `wawoff2`: wawoff2's WASM module loaded fine here
// (confirmed via the network panel — two real binary payloads, 200 OK)
// but its decompress() call itself hung indefinitely with no error,
// which points at its internal "module ready" signaling not resolving
// correctly in this bundler/browser context. woff2-encoder's build
// explicitly forces a setTimeout(0) tick after its own ready signal
// before resolving, specifically to dodge that class of deadlock.
// Requires `npm install woff2-encoder`; imported dynamically so it's
// only pulled in when a WOFF2 response actually needs it (which, per the
// note above, is every time here). Wrapped in withTimeout() regardless —
// a broken/missing install or any other stall must not hang generation.
async function embedGoogleFontBytes(pdfDoc, bytes, format) {
  if (format === "woff2") {
    const { default: decompress } = await withTimeout(import("woff2-encoder/decompress"), 8000, "loading the woff2-encoder decompress module");
    const sfntBytes = await withTimeout(decompress(bytes), 8000, "decompressing WOFF2 to sfnt");
    return pdfDoc.embedFont(sfntBytes, { subset: true });
  }
  return pdfDoc.embedFont(bytes, { subset: true });
}

async function loadGoogleScriptFonts(pdfDoc, fonts, persons) {
  const requirements = collectGoogleFontRequirements(persons);
  for (const family of GOOGLE_FONT_FAMILIES) {
    const charSet = requirements[family];
    if (!charSet || charSet.size === 0) continue;
    const key = `local:${family}`;
    if (fonts.custom[key]) continue;
    const text = Array.from(charSet).join("");
    try {
      const { bytes, format } = await fetchGoogleFontBytes(family, text);
      fonts.custom[key] = await embedGoogleFontBytes(pdfDoc, bytes, format);
      console.log(`Fetched "${family}" from Google Fonts for ${charSet.size} character(s) (${bytes.length} bytes).`);
    } catch (e) {
      console.warn(`Could not fetch "${family}" from Google Fonts — characters needing it will show as "${PLACEHOLDER_GLYPH}". Check your network connection to fonts.googleapis.com / fonts.gstatic.com, and that "woff2-encoder" is installed.`, e);
    }
  }
}

// ------------------------------------------------------------- background

async function drawBackground(page, sideTpl, ctx, pdfDoc, pageWMm, pageHMm, imageCache) {
  const bgMap = sideTpl.backgroundMap;
  let finalDataUrl = null;

  if (bgMap && bgMap.enabled) {
    // Fully different image per value — no tinting involved, the images
    // already differ.
    const val = ctx[bgMap.mapSource];
    const found = (bgMap.mappings || []).find((m) => m.value === val);
    finalDataUrl = (found && found.preview) || bgMap.fallbackPreview || null;
  } else {
    const bg = sideTpl.background; // data URL, or null
    if (!bg) return;
    const tint = sideTpl.tint || {};
    finalDataUrl = bg;
    if (tint.enabled) {
      const val = ctx[tint.mapSource];
      let color = tint.fallbackColor || "#1E5FD9";
      const found = (tint.mappings || []).find((m) => m.value === val);
      if (found) color = found.color;
      const cacheKey = `${bg}::${color}`;
      if (!imageCache.has(cacheKey)) {
        const tinted = await tintImageDataUrl(bg, color);
        imageCache.set(cacheKey, tinted);
      }
      finalDataUrl = imageCache.get(cacheKey);
    }
  }

  if (!finalDataUrl) return;
  const embedded = await embedImageCached(pdfDoc, finalDataUrl, imageCache);
  if (embedded) {
    page.drawImage(embedded, { x: 0, y: 0, width: mmv(pageWMm), height: mmv(pageHMm) });
  }
}

// --------------------------------------------------------------- person ctx

function personRole(person) {
  const roles = person.roles || [];
  if (roles.includes("organizer")) return "organizer";
  if (roles.includes("delegate")) return "delegate";
  return "competitor";
}

function buildPersonContext(person, sampleData, competitorSchedules, stages) {
  const ctx = { ...sampleData };
  const regId = person.registrantId;
  Object.assign(ctx, {
    name: normText(person.name || ""),
    role: personRole(person),
    wcaId: person.wcaId || "",
    registrantId: regId !== undefined && regId !== null ? String(regId) : "",
    country: person.countryIso2 || "",
    schedules: competitorSchedules[String(regId)] || {},
    stages,
  });
  return ctx;
}

// ------------------------------------------------------------------ main

/**
 * Generates the full combined PDF: every accepted person's front page
 * immediately followed by their back page. Returns a Uint8Array (PDF bytes)
 * ready to download.
 *
 * @param {object} state    - the designer's full app state (front/back/fonts)
 * @param {object} wcif     - the loaded competition's WCIF JSON
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function generateBadgesPdf(state, wcif, onProgress) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const fonts = {
    helvetica: await pdfDoc.embedFont(StandardFonts.Helvetica),
    helveticaBold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    custom: {},
  };
  for (const f of state.fonts || []) {
    if (f.dataUrl) {
      try {
        const bytes = dataUrlToBytes(f.dataUrl);

        const fontkitFont = fontkit.create(bytes);
        const pdfFont = await pdfDoc.embedFont(bytes, { subset: true });

        fonts.custom[f.family] = {
          pdfFont,
          fontkitFont,
        };
      } catch (e) {
        console.error(`Could not embed font ${f.family}, falling back to Helvetica`, e);
      }
    }
  }

  const competitorSchedules = buildCompetitorSchedules(wcif);
  const stages = buildStageList(wcif);

  const persons = (wcif.persons || []).filter(
    (p) => (p.registration && p.registration.status === "accepted") || (!p.registration && p.roles && p.roles.length)
  );

  console.log("Fetching any needed script fonts from Google Fonts...");
  await loadGoogleScriptFonts(pdfDoc, fonts, persons);

  const imageCache = new Map();

  const renderSide = async (sideTpl) => {
    const pageWMm = sideTpl.page.width_mm;
    const pageHMm = sideTpl.page.height_mm;
    const page = pdfDoc.addPage([mmv(pageWMm), mmv(pageHMm)]);
    return { page, pageWMm, pageHMm };
  };

  for (let idx = 0; idx < persons.length; idx++) {
    const person = persons[idx];
    const ctx = buildPersonContext(person, state.sampleData, competitorSchedules, stages);

    for (const sideKey of ["front", "back"]) {
      const sideTpl = state[sideKey];
      const { page, pageWMm, pageHMm } = await renderSide(sideTpl);

      await drawBackground(page, { background: sideTpl.background, tint: sideTpl.tint, backgroundMap: sideTpl.backgroundMap }, ctx, pdfDoc, pageWMm, pageHMm, imageCache);

      for (const field of sideTpl.fields) {
        const rotateDeg = field.rotate || 0;
        const pivotX = mmv(field.x_mm);
        const pivotY = mmv(pageHMm - field.y_mm);

        const runDraw = async (originX, originY) => {
          if (field.type === "text") drawTextField(page, field, ctx, fonts, originX, originY);
          else if (field.type === "image") await drawImageField(page, field, ctx, pdfDoc, imageCache, originX, originY);
          else if (field.type === "colorblock") drawColorblockField(page, field, ctx, originX, originY);
          else if (field.type === "qr") await drawQrField(page, field, ctx, pdfDoc, imageCache, originX, originY);
          else if (field.type === "schedule") drawScheduleField(page, field, ctx, fonts, originX, originY);
          else if (field.type === "taskkey") drawTaskKeyField(page, field, ctx, fonts, originX, originY);
        };

        if (rotateDeg) {
          // Rotate the ENTIRE local coordinate frame around the field's own
          // anchor point, then draw at local (0,0) — this is the one place
          // rotation is applied, uniformly, for every field type (including
          // multi-shape ones like schedule/task-key).
          const theta = (rotateDeg * Math.PI) / 180;
          const cos = Math.cos(theta);
          const sin = Math.sin(theta);
          page.pushOperators(pushGraphicsState(), concatTransformationMatrix(cos, sin, -sin, cos, pivotX, pivotY));
          await runDraw(0, 0);
          page.pushOperators(popGraphicsState());
        } else {
          await runDraw(pivotX, pivotY);
        }
      }
    }

    if (onProgress) onProgress(idx + 1, persons.length);
  }

  return pdfDoc.save();
}

export function downloadPdfBytes(bytes, filename = "print_ready.pdf") {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}