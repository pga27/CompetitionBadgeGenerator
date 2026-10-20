import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import {
  Type,
  Image as ImageIcon,
  Square,
  QrCode,
  Rows3,
  Trash2,
  Plus,
  Upload,
  RotateCw,
  X,
  Droplet,
  AlignLeft,
  AlignCenter,
  AlignRight,
  FileUp,
  KeyRound,
  Printer,
  GripVertical,
  ChevronUp,
  ChevronDown,
  Users,
  SwatchBook,
  Crop,
  TriangleAlert,
  Undo2,
  Redo2,
  Shapes,
  Layers,
  Trophy,
  Wallpaper,
  Database,
  Keyboard,
  PanelLeftClose,
  ZoomIn,
  ZoomOut,
  Maximize,
  FolderOpen,
  Save,
  BadgeCheck,
  CopyPlus,
  BringToFront,
  SendToBack,
  ArrowUp,
  ArrowDown,
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
} from "lucide-react";
import { buildCompetitorSchedules, buildGenericSchedule, buildStageList, listScheduleTexts, resolveScheduleTimezone } from "./schedule.js";
import { generateBadgesPdf, downloadPdfBytes } from "./pdfExport.js";
import defaultTemplate from "./defaultTemplate.json";
import { applyTextCase, DEFAULT_FRAME, layoutTextFrame, shrinkToWidth } from "./textLayout.js";
import { FULL_CROP, isFullCrop, normalizeCrop, placeImage } from "./imageCrop.js";
import { addRolesFromPersons, countByRule } from "./roles.js";
import { pickMappedLabel } from "./valueMap.js";
import { useHistory } from "./editor/useHistory.js";
import ShortcutsDialog from "./editor/ShortcutsDialog.jsx";
import AboutDialog from "./editor/AboutDialog.jsx";

const SCALE = 5.2; // px per mm
const MIN_MM = 4;
// Country flags, bundled into the project rather than fetched at runtime
// — put one file per country under src/assets/flags/, named by its WCA
// countryIso2 code (e.g. assets/flags/PT.svg, assets/flags/US.svg).
// import.meta.glob is Vite's way to bundle a whole folder of files that
// aren't individually known ahead of time (unlike the old fixed-list
// LOCAL_SCRIPT_FONTS pattern this mirrors): it must appear exactly like
// this, as a literal top-level call, since Vite statically scans the
// source for it at build time rather than evaluating it at runtime — it
// can't be moved into a function or have its path built dynamically.
// `eager: true` resolves every match's URL immediately (no per-file
// dynamic import), and since .svg isn't a JS module Vite transforms, its
// default export is simply the built, fingerprinted URL string.
const FLAG_ASSET_MODULES = import.meta.glob("./assets/flags/*.svg", { eager: true });

// ISO2 code -> resolved asset URL, e.g. { PT: "/assets/PT-a1b2c3.svg", ... }.
const FLAG_URLS_BY_ISO2 = Object.fromEntries(
  Object.entries(FLAG_ASSET_MODULES).map(([path, mod]) => {
    const iso2 = path.split("/").pop().replace(/\.svg$/i, "").toUpperCase();
    return [iso2, mod.default];
  })
);

// Same "who actually gets a badge" filter pdfExport.js's generateBadgesPdf
// and schedule.js's buildCompetitorSchedules use — accepted competitors,
// plus unregistered people who still have a staff role — so this doesn't
// fetch flags for people who won't end up on a badge at all (e.g.
// waitlisted or cancelled registrations).
function badgeablePersons(wcif) {
  return (wcif?.persons || []).filter((p) => (p.registration && p.registration.status === "accepted") || (!p.registration && p.roles && p.roles.length));
}

function wcifCountryIso2Codes(wcif) {
  const codes = new Set();
  for (const person of badgeablePersons(wcif)) {
    if (person.countryIso2) codes.add(person.countryIso2);
  }
  return codes;
}

async function fetchFlagDataUrl(iso2) {
  const url = FLAG_URLS_BY_ISO2[iso2];
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching bundled flag for "${iso2}"`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function fetchFlagMappingEntries(wcif) {
  const codes = [...wcifCountryIso2Codes(wcif)];
  const missing = codes.filter((c) => !FLAG_URLS_BY_ISO2[c]);
  if (missing.length) console.warn(`No bundled flag found for: ${missing.join(", ")} — expected src/assets/flags/<ISO2>.svg for each in the project.`);

  const fetched = await Promise.all(
    codes
      .filter((c) => FLAG_URLS_BY_ISO2[c])
      .map(async (c) => {
        try {
          const dataUrl = await fetchFlagDataUrl(c);
          return { value: c, path: `assets/flags/${c}.svg`, preview: dataUrl };
        } catch (e) {
          console.warn(`Could not load bundled flag for "${c}"`, e);
          return null;
        }
      })
  );
  return fetched.filter(Boolean);
}

// For every image field configured as "driven by country" (mapped &&
// mapSource === "country" — that's the existing UI's own signal of
// intent, so no separate "this is the flag field" toggle is needed),
// upserts one mapping entry per country actually present in the WCIF
// (see upsertMappingsByValue, shared with the manual bulk-upload
// feature). Existing mappings for countries no longer present are left
// alone rather than removed, so a field can carry countries from more
// than one WCIF load without needing to be reset each time.
async function syncCountryFlagFields(fields, wcif) {
  const needsSync = fields.filter((f) => f.type === "image" && f.mapped && f.mapSource === "countryIso2");
  if (needsSync.length === 0) return fields;
  const entries = await fetchFlagMappingEntries(wcif);
  return fields.map((f) => (needsSync.includes(f) ? { ...f, mappings: upsertMappingsByValue(f.mappings, entries) } : f));
}

const BUILTIN_FONTS = ["Helvetica", "Helvetica-Bold"];

// QR fields don't have independent w_mm/h_mm — they're square, sized by a
// single size_mm (see drawQrField in pdfExport.js, the only thing that
// actually determines the real exported size). Every place that reads a
// field's box dimensions for layout purposes — the canvas preview,
// drag/resize, snap-to-edge alignment, centering — needs to go through
// these rather than field.w_mm/h_mm directly, or a QR field silently
// falls back to the generic defaults (20mm / 8mm) instead of its actual
// size, which is exactly what made the on-canvas box (and everything
// derived from it) disagree with what actually gets exported.
// Text fields need the same treatment, for a different reason: FieldBox
// renders a non-wrap text field at width "auto" (sized to its actual
// content, not any stored w_mm) and ANY text field — wrapped or not — at
// height "auto" (always content-driven; only width is ever a real fixed
// box, and only when wrapped). Before this, a non-wrap text field still
// got the generic 20mm/8mm fallback here, so its drag bounds and the
// page-center snap point were computed against a box that didn't match
// what was actually on screen — which is what made dragging some text
// fields feel like it stuck partway across the canvas: the snap/clamp
// math was aiming for where a 20mm-wide box would need to be centered,
// not where the real (auto-sized) field visually was.
function fieldBoxWidthMm(field) {
  if (field.type === "qr") return field.size_mm || 16;
  if (field.type === "text" && field.textKind === "frame") return field.frame.w_mm;
  if (field.type === "text") return field.wrap ? field.w_mm || 60 : 0;
  return field.w_mm || 20;
}
function fieldBoxHeightMm(field) {
  if (field.type === "qr") return field.size_mm || 16;
  if (field.type === "text" && field.textKind === "frame") return field.frame.auto_height ? 0 : field.frame.h_mm;
  if (field.type === "text") return field.boxHeightMm > 0 ? field.boxHeightMm : 0;
  return field.h_mm || 8;
}

// One-click Google Fonts you can add without hunting down a .ttf file
// yourself. Each preset fetches one specific weight of the family as a
// separate selectable "font" — same convention as the built-in Helvetica /
// Helvetica-Bold pair, where weight is a distinct font choice rather than
// a toggle. Add more entries here to offer more presets later.
const GOOGLE_FONT_PRESETS = [
  { label: "Rubik", family: "Rubik", weight: "400" },
  { label: "Rubik Bold", family: "Rubik", weight: "700" },
];

// Wraps a promise with a hard deadline: without this, a stalled network
// request or a broken WASM module init can hang silently forever with
// nothing to catch it (see the equivalent, more-detailed comment on
// withTimeout in pdfExport.js — same reasoning applies here).
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Chunked to avoid blowing the call stack on String.fromCharCode.apply
// for a multi-hundred-KB font file.
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Fetches one weight of a Google Font as a FULL family (no `text=`
// subsetting) — this is for a font the person picks for arbitrary,
// not-yet-known text (any competitor's name, any static/template string),
// unlike the per-character subsetted fetch in pdfExport.js's automatic
// script-fallback system, which only ever needs specific already-known
// characters. Returns a data: URL in the same shape FileReader.
// readAsDataURL produces for a manually-uploaded file, since the rest of
// the app (embedding, live preview, template export) expects exactly
// that shape regardless of where the font actually came from.
async function fetchGoogleFontFamilyDataUrl(family, weight) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`;
  const cssRes = await withTimeout(fetch(cssUrl, { mode: "cors" }), 8000, `Google Fonts CSS request for "${family}" ${weight}`);
  if (!cssRes.ok) throw new Error(`HTTP ${cssRes.status} fetching Google Fonts CSS for "${family}"`);
  const css = await cssRes.text();

  // Without a `text=` param (this needs the family's full Latin coverage
  // for arbitrary, not-yet-known text, unlike pdfExport.js's per-character
  // subsetted fetch for already-known names), Google returns ONE
  // @font-face block PER SCRIPT SUBSET the family supports — cyrillic,
  // vietnamese, latin, latin-ext, etc. — not one block for the whole
  // family, each labeled with a trailing "/* subsetname */" comment. A
  // naive first-match would silently grab whichever subset happens to be
  // listed first (commonly NOT latin — real responses list latin last).
  // We need a single static file to embed as one selectable font, so this
  // explicitly picks "latin-ext" (a superset of "latin": Latin-1 + Latin
  // Extended-A/B, covering Polish, Czech, Turkish, etc.) if present, else
  // falls back to plain "latin", else whatever block exists at all.
  const blocks = [...css.matchAll(/@font-face\s*\{([^}]*)\}\s*\/\*\s*([\w-]+)\s*\*\//g)].map(([, body, label]) => ({ body, label }));
  const chosen = blocks.find((b) => b.label === "latin-ext") || blocks.find((b) => b.label === "latin") || blocks[0];
  if (!chosen) throw new Error(`Google Fonts CSS for "${family}" had no @font-face blocks in it: ${css.slice(0, 200)}`);

  const urlMatch = chosen.body.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)\s*format\('(\w+)'\)/);
  if (!urlMatch) throw new Error(`Google Fonts CSS for "${family}" (${chosen.label} subset) had no usable font url in it`);
  const [, fontUrl, format] = urlMatch;

  const fontRes = await withTimeout(fetch(fontUrl, { mode: "cors" }), 8000, `Google Fonts file download for "${family}"`);
  if (!fontRes.ok) throw new Error(`HTTP ${fontRes.status} fetching the font file for "${family}"`);
  const rawBytes = new Uint8Array(await fontRes.arrayBuffer());

  // Browser fetch() always gets WOFF2 back from Google (it can't override
  // the User-Agent header, which is what Google sniffs to decide format —
  // see the matching note in pdfExport.js), so this needs decompressing
  // to a real sfnt before it's usable as a font file elsewhere in the app.
  let sfntBytes = rawBytes;
  if (format === "woff2") {
    const { default: decompress } = await withTimeout(import("woff2-encoder/decompress"), 8000, "loading the woff2-encoder decompress module");
    sfntBytes = await withTimeout(decompress(rawBytes), 8000, "decompressing WOFF2 to sfnt");
  }

  return `data:font/ttf;base64,${bytesToBase64(sfntBytes)}`;
}

// ---------------------------------------------------------------------
// Schedule field appearance — edit these to restyle the schedule table.
// This is the one place that controls it; nothing else in the schedule
// rendering below should have a hardcoded color or font size outside of
// these constants (a row's own highlight color from real/placeholder
// task data is the one exception — that's per-row data, not styling).
// ---------------------------------------------------------------------
const SCHEDULE_FONT_FAMILY = "Helvetica, Arial, sans-serif"; // time / event / task / header text all use this
const SCHEDULE_FONT_SIZE_PX = 8.5; // bumped up from the ~5pt baseline while keeping row height fixed — tune freely
const SCHEDULE_COLORS = {
  headerBg: "#000000", // day-title bar background (e.g. "Friday, October 9th")
  headerText: "#ffffff", // day-title bar text color
  subheaderBg: "#f2f2f2", // "Time / Event / Task" column-label row background
  border: "#000000", // every border/divider line in the table
  timeCellBg: "#999999", // time column background
  taskCellTint: 45, // 0-100: how strongly a row's task color tints the task cell
  rowTint: 18, // 0-100: how strongly a row's task color tints the rest of the row
  lunchBg: "#999999", // special-row background for Lunch/Dinner
  otherSpecialBg: "#f5a3c7", // special-row background for Opening/Awards/Tutorial/etc.
};
// Fixed pixel heights (at this app's fixed canvas SCALE) for the schedule's
// day-title bar, column-label row, and each data row. A schedule's overall
// height is always header + subheader + (row height * row count) — never a
// free-form value — so two schedules with different row counts still line
// up row-for-row when placed side by side.
const SCHEDULE_HEADER_HEIGHT_PX = 14;
const SCHEDULE_SUBHEADER_HEIGHT_PX = 12;
const SCHEDULE_ROW_HEIGHT_PX = 13;
const SCHEDULE_BOTTOM_PADDING_PX = 0; // no longer needed now the font/row-height fit correctly
const SCHEDULE_QR_FONT_SIZE_PX = 11; // larger label size for merged "QR" cells on round 2+ rows

// ---------------------------------------------------------------------
// Task Key field appearance — shares the schedule's font/row-height for
// visual consistency, so the two fields line up if placed near each other.
// ---------------------------------------------------------------------
const TASKKEY_HEADER_HEIGHT_PX = SCHEDULE_SUBHEADER_HEIGHT_PX;
const TASKKEY_ROW_HEIGHT_PX = SCHEDULE_ROW_HEIGHT_PX;
const TASKKEY_TASKS = [
  { code: "C", label: "Compete" },
  { code: "J", label: "Judge" },
  { code: "R", label: "Runner" },
  { code: "S", label: "Scrambler" },
];
const TASKKEY_FALLBACK_STAGES = [
  { name: "Stage 1", color: "#63f153" },
  { name: "Stage 2", color: "#da3f39" },
];

const PAGE_PRESETS = [
  { label: "A6 portrait (105×148)", w: 105, h: 148 },
  { label: "A6 landscape (148×105)", w: 148, h: 105 },
  { label: "Credit-card badge (85.6×54)", w: 85.6, h: 54 },
  { label: "Large badge (95×130)", w: 95, h: 130 },
  { label: "Custom", w: null, h: null },
];

const TYPE_META = {
  text: { icon: Type, label: "Text" },
  image: { icon: ImageIcon, label: "Image" },
  colorblock: { icon: Square, label: "Color block" },
  qr: { icon: QrCode, label: "QR code" },
  schedule: { icon: Rows3, label: "Schedule" },
  taskkey: { icon: KeyRound, label: "Task key" },
};

let uidCounter = 1;
const uid = (prefix) => `${prefix}_${uidCounter++}`;

function hexToRgba(hex, alphaPct) {
  if (!hex) return `rgba(156,163,175,${(alphaPct ?? 100) / 100})`;
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const bigint = parseInt(full, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${(alphaPct ?? 100) / 100})`;
}

// Fallback demo rows shown when no WCIF schedule has been loaded yet —
// pure placeholder, not tied to any real competition.
const SCHEDULE_FALLBACK_ROWS = [
  { time: "09:00", event: "3x3 OH R1 - G1", task: "<e0>", color: null },
  { time: "09:20", event: "3x3 OH R1 - G2", task: "<e1>", color: null },
  { time: "09:45", event: "3x3 OH R1 - G3", task: "<e2>", color: null },
  { time: "11:15", event: "7x7 R1 - G1", task: "<e6>", color: null },
  { time: "12:15", event: "LUNCH", task: null, isSpecial: true, specialColor: "#e5e7eb" },
  { time: "12:45", event: "OPENING", task: null, isSpecial: true, specialColor: "#fbcfe8" },
  { time: "13:40", event: "Submit MBLD", task: "<e90>", color: null },
  { time: "14:05", event: "4x4x4 R1 - G1", task: "<e8>", color: null },
  // Two consecutive round-2+ rows, so the QR-cell merge behavior previews
  // even before a real WCIF is loaded.
  { time: "16:00", event: "3x3x3 Final", task: null, color: null, isSubsequentRound: true },
  { time: "16:20", event: "4x4x4 Final", task: null, color: null, isSubsequentRound: true },
  { time: "18:50", event: "DINNER", task: null, isSpecial: true, specialColor: "#e5e7eb" },
  { time: "19:20", event: "Rubik's Nations Cup", task: null, isSpecial: true, specialColor: "#fbcfe8" },
];

// Full-width "break" rows (lunch, awards…). Rows from a WCIF know this from
// their activityCode, so renaming one (e.g. "Lunch" -> "Comida") keeps its
// styling; the name check is only for the placeholder rows above.
function isSpecialScheduleRow(r) {
  return r.isSpecial || (!r.activityCode && /lunch|dinner|opening|awards|tutorial/i.test(r.event));
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

// Single source of truth for "which rows does this schedule field show" —
// used both to compute the field's derived height and to render its rows,
// so the two can never drift out of sync with each other.
function resolveScheduleRows(field, sampleData) {
  const dayIdx = field.dayIndex || 0;
  const excluded = new Set(field.excludedIds || []);
  const scheduleDays = sampleData.schedules ? Object.keys(sampleData.schedules).sort() : [];
  const activeDayKey = scheduleDays[dayIdx] || "2026-10-09";
  const headerTitle = field.customTitle || (activeDayKey ? formatDayTitle(activeDayKey) : "Schedule");
  const rows = (sampleData.schedules && sampleData.schedules[activeDayKey]) || SCHEDULE_FALLBACK_ROWS;
  const visibleRows = rows.filter((r) => !excluded.has(String(r.id || `${r.time}_${r.event}`)));
  return { activeDayKey, headerTitle, visibleRows };
}

// Single source of truth for the Task Key field's two columns.
// Single source of truth for the Task Key field's two columns. Stage names
// can be overridden per-field (field.stageNames[i]); colors always come from
// the loaded competition (or the fallback), since those aren't user text.
function resolveTaskKeyRows(field, sampleData) {
  const stages = sampleData.stages && sampleData.stages.length > 0 ? sampleData.stages : TASKKEY_FALLBACK_STAGES;
  const overrides = (field && field.stageNames) || [];
  const stageRows = stages.map((s, i) => ({ ...s, name: (overrides[i] && overrides[i].trim()) || s.name }));
  return { taskRows: TASKKEY_TASKS, stageRows };
}

function resolveMapping(field, sampleData, kind) {
  const val = sampleData[field.mapSource];
  const found = (field.mappings || []).find((m) => m.value === val);
  if (kind === "color") return found ? found.color : field.fallbackColor || "#9CA3AF";
  return found || null;
}

// A text field's color: its own, unless "Color depends on a value" is on
// and the value it watches (e.g. role) has a color of its own.
function resolveTextColor(field, data) {
  const map = field.colorMap;
  if (!map?.enabled) return field.color;
  return resolveMapping({ mapSource: map.source, mappings: map.mappings, fallbackColor: field.color }, data, "color");
}

function isValidTimezone(tz) {
  if (!tz) return true; // empty = "auto", always valid
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function resolveTemplate(template, sampleData) {
  return (template || "").replace(/\{(\w+)(?:\|([^}]*))?\}/g, (_, k, fallback) => {
    const has = Object.prototype.hasOwnProperty.call(sampleData, k);
    const v = sampleData[k];
    const isEmpty = v === undefined || v === null || v === "";
    // Unknown key with no fallback given: keep the literal placeholder
    // visible, since that's almost always a typo worth surfacing rather
    // than silently blanking out. Once a fallback is present — even for
    // an unknown key — it's clearly intentional ("use this text when
    // there's nothing to show"), so honor it.
    if (!has && fallback === undefined) return `{${k}}`;
    if (isEmpty) return fallback !== undefined ? fallback : "";
    return v;
  });
}

function resolveTextValue(field, sampleData) {
  if (field.bindMode === "static") return field.staticText ?? "";
  if (field.bindMode === "template") return resolveTemplate(field.template, sampleData);
  const raw = sampleData[field.source] ?? field.source;
  let value = raw;
  if (field.useValueMap) {
    const found = (field.valueMap || []).find((m) => m.value === raw);
    value = found ? pickMappedLabel(found, sampleData.gender, field.genderVariants) : raw;
  }
  return (field.customPrefix || "") + value;
}

const MM_TO_PT = 72 / 25.4;

// Text width in points, measured with a canvas in the font the preview
// draws with (see textLayout.js). Measuring at "size px" gives the width at
// "size pt" in points, since width scales linearly with font size.
let measureCanvas = null;
function canvasTextMeasurer(font, letterSpacing) {
  measureCanvas ||= document.createElement("canvas").getContext("2d");
  return (text, size) => {
    measureCanvas.font = `${font.weight} ${size}px ${font.family}`;
    return measureCanvas.measureText(text).width + letterSpacing * Math.max([...text].length - 1, 0);
  };
}

// The font's vertical metrics as the browser uses them, as fractions of
// the font size: cap height (for centering by the letters, see
// textLayout.js) and the ascent/descent CSS uses to place the baseline
// inside a line box.
function canvasFontMetrics(font) {
  measureCanvas ||= document.createElement("canvas").getContext("2d");
  measureCanvas.font = `${font.weight} 100px ${font.family}`;
  const m = measureCanvas.measureText("H");
  return { capHeight: m.actualBoundingBoxAscent / 100 || 0.72, ascent: m.fontBoundingBoxAscent / 100 || 0.9, descent: m.fontBoundingBoxDescent / 100 || 0.2 };
}

function anchorTransform(align) {
  if (align === "center") return "translateX(-50%)";
  if (align === "right") return "translateX(-100%)";
  return undefined;
}

function defaultTint() {
  return {
    enabled: false,
    mapSource: "role",
    fallbackColor: "#1E5FD9",
    mappings: [
      { value: "competitor", color: "#38dc35" },
      { value: "delegate", color: "#d53a3a" },
      { value: "organizer", color: "#463be5" },
    ],
  };
}

function defaultBackgroundMap() {
  return {
    enabled: false, // when true, this replaces the single background+tint entirely
    mapSource: "role",
    fallbackPath: "assets/background.png",
    fallbackPreview: null,
    mappings: [], // [{ value, path, preview }]
  };
}

function textFieldDefaults() {
  return {
    bindMode: "field",
    source: "name",
    staticText: "",
    template: "",
    useValueMap: false,
    valueMap: [],
    genderVariants: false,
    font: "Helvetica",
    fontMode: "fixed",
    size: 10,
    color: "#141414",
    align: "left",
    letterSpacing: 0,
    wrap: false,
    w_mm: 60,
    breakStyle: "break-all",
    lineHeight: 1.05,
    // "point": anchored at x/y, optional wrap/auto-fit (the original mode).
    // "frame": a box the text is laid out in (see textLayout.js).
    textKind: "point",
    frame: { ...DEFAULT_FRAME },
    textCase: "none",
    // Per-value color, e.g. role "organizer" -> orange (see resolveTextColor).
    colorMap: { enabled: false, source: "role", mappings: [] },
    // Point text only: an optional box height (0 = none) the text is
    // aligned in vertically, like a spreadsheet cell.
    boxHeightMm: 0,
    vAlign: "top",
  };
}

function initialState() {
  return inflateTemplate(defaultTemplate);
}

// ---------- import: rebuild internal field shapes from an exported template.json ----------
function inflateTextField(f) {
  return {
    id: f.id || uid("text"),
    type: "text",
    x_mm: f.x_mm ?? 8,
    y_mm: f.y_mm ?? 8,
    rotate: f.rotate || 0,
    bindMode: f.bindMode || "field",
    source: f.source || "name",
    staticText: f.text || "",
    template: f.template || "",
    useValueMap: !!f.value_map,
    valueMap: f.value_map || [],
    genderVariants: !!f.gender_variants,
    boxHeightMm: f.box_height_mm || 0,
    vAlign: f.v_align || "top",
    font: f.font || "Helvetica",
    color: f.color || "#141414",
    align: f.align || "left",
    letterSpacing: f.letter_spacing || 0,
    wrap: !!f.wrap,
    w_mm: f.w_mm || 60,
    breakStyle: f.break_style || "break-word",
    lineHeight: f.line_height || 1.05,
    fontMode: f.size_min !== undefined ? "autofit" : "fixed",
    size: f.size || 12,
    size_min: f.size_min,
    size_max: f.size_max,
    max_width_mm: f.max_width_mm,
    textKind: f.text_kind || "point",
    frame: { ...DEFAULT_FRAME, ...(f.frame || {}) },
    textCase: f.text_case || "none",
    colorMap: f.color_map ? { enabled: true, source: f.color_map.source || "role", mappings: f.color_map.mappings || [] } : { enabled: false, source: "role", mappings: [] },
  };
}
function inflateImageField(f) {
  return {
    id: f.id || uid("image"),
    type: "image",
    x_mm: f.x_mm ?? 8,
    y_mm: f.y_mm ?? 8,
    rotate: f.rotate || 0,
    w_mm: f.w_mm || 20,
    h_mm: f.h_mm || 14,
    mapped: !!f.mapped,
    path: f.path || "assets/logo.png",
    preview: f.preview || null,
    mapSource: f.mapSource || "role",
    fallbackPath: f.fallbackPath || "assets/default.png",
    fallbackPreview: f.fallbackPreview || null,
    mappings: (f.mappings || []).map((m) => ({ value: m.value, path: m.path, preview: m.preview || null })),
    // Part of the image to use and how it fills the box (see imageCrop.js).
    crop: normalizeCrop(f.crop),
    fit: f.fit || "contain",
  };
}
function inflateColorblockField(f) {
  return {
    id: f.id || uid("colorblock"),
    type: "colorblock",
    x_mm: f.x_mm ?? 0,
    y_mm: f.y_mm ?? 0,
    rotate: f.rotate || 0,
    w_mm: f.w_mm || 30,
    h_mm: f.h_mm || 10,
    mapSource: f.mapSource || "role",
    fallbackColor: f.fallbackColor || "#9CA3AF",
    opacity: f.opacity ?? 100,
    mappings: f.mappings || [],
    labelSource: f.labelSource || null,
    labelColor: f.labelColor || "#FFFFFF",
  };
}
function inflateQrField(f) {
  return { id: f.id || uid("qr"), type: "qr", x_mm: f.x_mm ?? 8, y_mm: f.y_mm ?? 8, rotate: f.rotate || 0, target: f.target || "", size_mm: f.size_mm || 16 };
}
function inflateScheduleField(f) {
  return { 
    id: f.id || uid("schedule"), 
    type: "schedule", 
    x_mm: f.x_mm ?? 8, 
    y_mm: f.y_mm ?? 8, 
    rotate: f.rotate || 0, 
    w_mm: f.w_mm || 60, 
    h_mm: f.h_mm || 40, 
    dayIndex: f.dayIndex || 0,
    customTitle: f.customTitle || "",
    excludedIds: f.excludedIds || [],
    // Column header texts; empty means the default ("Time" / "Event" / "Task").
    columnLabels: { time: "", event: "", task: "", ...(f.columnLabels || {}) },
  };
}
function inflateTaskKeyField(f) {
  return {
    id: f.id || uid("taskkey"),
    type: "taskkey",
    x_mm: f.x_mm ?? 8,
    y_mm: f.y_mm ?? 8,
    rotate: f.rotate || 0,
    w_mm: f.w_mm || 70,
    stageNames: f.stageNames || [],
  };
}
function inflateField(f) {
  if (f.type === "text") return inflateTextField(f);
  if (f.type === "image") return inflateImageField(f);
  if (f.type === "colorblock") return inflateColorblockField(f);
  if (f.type === "qr") return inflateQrField(f);
  if (f.type === "schedule") return inflateScheduleField(f);
  if (f.type === "taskkey") return inflateTaskKeyField(f);
  return f;
}
function inflateSide(s, fallbackW, fallbackH) {
  return {
    page: s?.page || { width_mm: fallbackW, height_mm: fallbackH },
    // Safe area inset from every edge, in mm: only a design guide (snapping
    // + warnings), never printed. 0 turns it off.
    safeMarginMm: s?.safe_margin_mm ?? 3,
    background: s?.background_data || null,
    backgroundName: s?.background || "assets/background.png",
    tint: s?.background_tint
      ? { enabled: !!s.background_tint.enabled, mapSource: s.background_tint.mapSource || "role", fallbackColor: s.background_tint.fallbackColor || "#1E5FD9", mappings: s.background_tint.mappings || [] }
      : defaultTint(),
    backgroundMap: s?.background_map
      ? {
          enabled: !!s.background_map.enabled,
          mapSource: s.background_map.mapSource || "role",
          fallbackPath: s.background_map.fallbackPath || "assets/background.png",
          fallbackPreview: s.background_map.fallbackPreview || null,
          mappings: (s.background_map.mappings || []).map((m) => ({ value: m.value, path: m.path, preview: m.preview || null })),
        }
      : defaultBackgroundMap(),
    fields: (s?.fields || []).map(inflateField),
  };
}
// The global settings schedule.js's builders take (see buildBaseSchedule).
function scheduleOptions(s) {
  return { stageColors: s.stageColors, labels: s.scheduleLabels, mbldSubmission: s.mbldSubmission, mergedRounds: s.mergedRounds };
}

function inflateTemplate(data) {
  const inflatedFonts = Object.entries(data.fonts || {}).map(([family, meta]) => ({
    id: uid("font"),
    family,
    displayName: meta.display_name || family,
    filename: (meta.path || "").split("/").pop() || "font.ttf",
    dataUrl: meta.data_url || null,
    needsReupload: !meta.data_url,
  }));

  let maxN = 0;
  [...(data.front?.fields || []), ...(data.back?.fields || [])].forEach((f) => {
    const m = /_([0-9]+)$/.exec(f.id || "");
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  });
  uidCounter = Math.max(uidCounter, maxN + 1);

  return {
    // gender: WCIF "m" / "f" / "o", for gender variants of mapped text.
    sampleData: { ...(data.sample_data || { name: "Sample Name" }), gender: data.sample_data?.gender ?? "m" },
    scheduleTimezone: data.schedule_timezone || "",
    // A template saved before this feature existed won't have role_mapping
    // at all — default reproduces the old hardcoded organizer/delegate
    // behavior exactly (see DEFAULT_ROLE_MAPPING in pdfExport.js).
    roleMapping: data.role_mapping || {
      rules: [
        { wcaRole: "organizer", label: "organizer" },
        { wcaRole: "delegate", label: "delegate" },
      ],
      fallback: "competitor",
    },
    // Stage name -> color to print instead of the one set on the WCA
    // website (see StageColorsPanel). Empty = WCA colors everywhere.
    stageColors: data.stage_colors || {},
    // User renames for schedule rows (see SchedulePanel / listScheduleTexts).
    scheduleLabels: { events: {}, activities: {}, ...(data.schedule_labels || {}) },
    // MBLD cube submission shown as a task (see buildCompetitorSchedules).
    mbldSubmission: { enabled: false, task: "C", hideForOthers: false, ...(data.mbld_submission || {}) },
    // Later rounds shown as one row instead of one per group (see buildBaseSchedule).
    mergedRounds: data.merged_rounds || [],
    fonts: inflatedFonts,
    front: inflateSide(data.front, 105, 148),
    back: inflateSide(data.back, 148, 105),
  };
}

// On-screen size of a millimetre at "100%" zoom: real size on a standard
// 96 dpi screen. The page itself is drawn at SCALE px/mm and zoomed with a
// CSS scale, so zoom 1 shows it at SCALE / REAL_PX_PER_MM (about 138%).
const REAL_PX_PER_MM = 96 / 25.4;
const ZOOM_STEPS_PCT = [10, 25, 33, 50, 67, 75, 100, 125, 150, 200, 300, 400, 600, 800];
const pctToZoom = (pct) => ((pct / 100) * REAL_PX_PER_MM) / SCALE;
const zoomToPct = (zoom) => (zoom * SCALE * 100) / REAL_PX_PER_MM;
const VIEWPORT_PAD = 48; // px of grey around the page

// Left rail tabs, Canva style: each opens its panel next to the rail.
const LEFT_TABS = [
  { id: "elements", label: "Elements", icon: Shapes },
  { id: "layers", label: "Layers", icon: Layers },
  { id: "competition", label: "Competition", icon: Trophy },
  { id: "background", label: "Background", icon: Wallpaper },
  { id: "fonts", label: "Fonts", icon: Type },
  { id: "data", label: "Data", icon: Database },
];

// Whether a key event comes from somewhere the user is typing, where the
// browser's own shortcuts (copy, undo, arrows…) must keep working.
function isTypingTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

// Marker for fields copied to the system clipboard, so a paste — in this
// tab or another one — can tell them apart from ordinary text.
const CLIPBOARD_MARKER = "competition-badge-generator/fields";

function fieldDisplayName(f) {
  if (f.type === "text") return f.bindMode === "static" ? `"${(f.staticText || "").slice(0, 18)}"` : f.bindMode === "template" ? f.template || "(template)" : f.source;
  return TYPE_META[f.type].label;
}

export default function BadgeDesigner() {
  // The document (everything that's saved in template.json, plus the loaded
  // WCIF) is undoable; the rest — which side is shown, selection, zoom,
  // open panels — is view state.
  const { doc: state, setDoc: setState, undo, redo, canUndo, canRedo } = useHistory(initialState);
  const [side, setSide] = useState("front");
  const [rawSelectedIds, setSelectedIds] = useState([]);
  const [activeTab, setActiveTab] = useState("elements"); // left panel; null = closed
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [generating, setGenerating] = useState(null); // null | { done, total }
  const [guides, setGuides] = useState({ x: null, y: null });
  const [zoom, setZoom] = useState(1);
  const [marquee, setMarquee] = useState(null); // selection box, client px { left, top, right, bottom }
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [compIdInput, setCompIdInput] = useState("");
  const [showCompMenu, setShowCompMenu] = useState(false);
  const [draggingFieldId, setDraggingFieldId] = useState(null); // layers list drag & drop
  // Ids of fields reaching past the safe margin, measured from what's
  // actually drawn (so auto-width text, alignment and rotation all count).
  const [outsideIds, setOutsideIds] = useState([]);
  const canvasRef = useRef(null);
  const viewportRef = useRef(null);
  const importInputRef = useRef(null);
  const zoomAnchorRef = useRef(null); // keeps the point under the pointer still while zooming
  const pasteCountRef = useRef(0); // how many times the clipboard has been pasted, to offset copies

  const loadWcifData = async (compIdOrFile) => {
    try {
      let wcif;
      if (typeof compIdOrFile === "string") {
        const res = await fetch(`https://www.worldcubeassociation.org/api/v0/competitions/${compIdOrFile}/wcif/public`);
        if (!res.ok) throw new Error("Failed to fetch WCIF from WCA API");
        wcif = await res.json();
      } else {
        const text = await compIdOrFile.text();
        wcif = JSON.parse(text);
      }

      // Diagnostic: log any non-ASCII names exactly as this app sees them,
      // immediately after parsing and before anything else touches them —
      // open the browser console (F12) after loading a WCIF to check this
      // if a name looks wrong later. If it's already wrong HERE, the file
      // itself (or however it was obtained) is the problem, not this app.
      for (const p of wcif.persons || []) {
        if (p.name && /[^\x00-\x7F]/.test(p.name)) {
          console.log(
            `[WCIF check] "${p.name}" — codepoints: ${[...p.name].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()).join(" ")}`
          );
        }
      }

      // Template-design stage only: show the competition's real event shape
      // (dates, times, event names, room colors) with PLACEHOLDER tasks —
      // never a specific person's actual assignments. Real per-competitor
      // data (and buildCompetitorSchedules) only gets used later, in batch
      // generation, once this template is applied to the whole roster.
      const genericSchedule = buildGenericSchedule(wcif, state.scheduleTimezone || undefined, scheduleOptions(state));
      const stages = buildStageList(wcif, state.stageColors);

      // Populates any "driven by country" image field's mappings from the
      // flags actually needed for this WCIF's competitors (see
      // syncCountryFlagFields) — both sides, independently of which one is
      // currently showing.
      const [frontFields, backFields] = await Promise.all([syncCountryFlagFields(state.front.fields, wcif), syncCountryFlagFields(state.back.fields, wcif)]);

      setState((prev) => ({
        ...prev,
        wcif, // full raw WCIF, kept so "Generate PDF" can use REAL per-competitor data later
        // Every role and role combination present gets a rule (existing
        // rules and their labels are kept), see addRolesFromPersons.
        roleMapping: addRolesFromPersons(prev.roleMapping, badgeablePersons(wcif)),
        sampleData: {
          ...prev.sampleData,
          schedules: genericSchedule, // Map of "YYYY-MM-DD" -> placeholder row array
          stages, // [{ name, color }, ...] — used by the Task Key field's stage column
        },
        front: { ...prev.front, fields: frontFields },
        back: { ...prev.back, fields: backFields },
      }));

      return true;
    } catch (err) {
      console.error(err);
      alert(`Could not process WCIF: ${err.message}`);
      return false;
    }
  };

  const handleAddSchedule = async () => {
    // If schedule data isn't loaded yet, prompt the user
    if (!state.sampleData.schedules || Object.keys(state.sampleData.schedules).length === 0) {
      const compId = prompt("Enter WCA Competition ID (e.g. PortugueseChampionship2025):");
      if (!compId) return;
      const ok = await loadWcifData(compId.trim());
      if (!ok) return;
    }

    // Create the schedule field on canvas
    addField("schedule");
  };

  const dragRef = useRef(null);
  const sideData = state[side];
  const fields = sideData.fields;
  // Only fields that exist on the side being shown count as selected (undo,
  // deleting or switching sides can take selected fields away).
  const selectedIds = rawSelectedIds.filter((id) => fields.some((f) => f.id === id));
  const selectedFields = fields.filter((f) => selectedIds.includes(f.id));
  const selectedField = selectedFields.length === 1 ? selectedFields[0] : null;

  // Re-measured after every render (fields, fonts, sample data, zoom and
  // page size all move things), on the next frame so the layout is
  // settled; the functional update keeps the same array when nothing
  // changed, so it doesn't trigger another render.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const m = (sideData.safeMarginMm || 0) * SCALE * zoom;
      const page = canvas.getBoundingClientRect();
      const safe = { left: page.left + m, top: page.top + m, right: page.right - m, bottom: page.bottom - m };
      const TOL = 0.5; // px, so a field snapped exactly onto the line doesn't count
      const next = [];
      if (m > 0) {
        for (const el of canvas.querySelectorAll("[data-field-id]")) {
          // A non-wrapping text box is auto-width and its text is shifted by
          // its alignment, so measure the text itself rather than the box.
          const target = el.dataset.fieldType === "text" ? el.querySelector("[data-text-content]") || el : el;
          const r = target.getBoundingClientRect();
          if (r.left < safe.left - TOL || r.top < safe.top - TOL || r.right > safe.right + TOL || r.bottom > safe.bottom + TOL) next.push(el.dataset.fieldId);
        }
      }
      setOutsideIds((prev) => (prev.join() === next.join() ? prev : next));
    });
    return () => cancelAnimationFrame(frame);
  });

  // `key` groups edits into one undo step (see useHistory).
  const updateSide = (patch, key) => setState((s) => ({ ...s, [side]: { ...s[side], ...patch } }), key);
  const updateField = (id, patch) =>
    setState((s) => ({ ...s, [side]: { ...s[side], fields: s[side].fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) } }), `field:${id}:${Object.keys(patch).sort().join()}`);
  const setFields = (fn, key) => setState((s) => ({ ...s, [side]: { ...s[side], fields: fn(s[side].fields) } }), key);

  // Manual re-sync for a single field — for when mapSource is set to
  // "country" AFTER a WCIF is already loaded (the automatic sync in
  // loadWcifData only fires at load time), or to pick up newly-added
  // flag files under src/assets/flags/ without reloading the WCIF.
  const syncCountryFlagsForField = async (fieldId) => {
    if (!state.wcif) {
      alert("Load a WCIF first (Competition tab) — flags are fetched per the competitors it contains.");
      return;
    }
    const entries = await fetchFlagMappingEntries(state.wcif);
    updateField(fieldId, { mappings: upsertMappingsByValue(sideData.fields.find((f) => f.id === fieldId)?.mappings || [], entries) });
  };
  const updateTint = (patch) => updateSide({ tint: { ...sideData.tint, ...patch } }, `tint:${side}:${Object.keys(patch).join()}`);
  const updateBackgroundMap = (patch) => updateSide({ backgroundMap: { ...sideData.backgroundMap, ...patch } }, `bgmap:${side}:${Object.keys(patch).join()}`);
  // Global, not per-side (like scheduleTimezone) — a person's role doesn't
  // change between the front and back of their own badge.
  const updateRoleMapping = (patch) => setState((s) => ({ ...s, roleMapping: { ...s.roleMapping, ...patch } }), `rolemap:${Object.keys(patch).join()}`);
  // Global too: a stage is the same color on every badge and on both sides.
  // color === null drops the override, going back to the WCA color.
  // sampleData.stages and .schedules are re-derived so the Task Key and
  // schedule previews follow along.
  const setStageColor = (name, color) =>
    setState((prev) => {
      const stageColors = { ...prev.stageColors };
      if (color) stageColors[name] = color;
      else delete stageColors[name];
      if (prev.wcif) {
        const schedules = buildGenericSchedule(prev.wcif, prev.scheduleTimezone || undefined, scheduleOptions({ ...prev, stageColors }));
        return { ...prev, stageColors, sampleData: { ...prev.sampleData, stages: buildStageList(prev.wcif, stageColors), schedules } };
      }
      const stages = (prev.sampleData.stages || []).map((s) => {
        const wcaColor = s.wcaColor || s.color;
        return { ...s, wcaColor, color: stageColors[s.name] || wcaColor };
      });
      return { ...prev, stageColors, sampleData: { ...prev.sampleData, stages } };
    }, `stagecolor:${name}`);

  // ---------- adding, deleting, copying ----------

  const round1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  const addFieldObjects = (newFields) => {
    setFields((fs) => [...fs, ...newFields]);
    setSelectedIds(newFields.map((f) => f.id));
  };

  const addField = (type) => {
    const count = fields.filter((f) => f.type === type).length;
    const off = count * 4;
    const base = { id: uid(type), type, x_mm: 8 + off, y_mm: 8 + off, rotate: 0 };
    if (type === "text") Object.assign(base, textFieldDefaults());
    if (type === "image")
      Object.assign(base, { w_mm: 20, h_mm: 14, mapped: false, path: "assets/logo.png", preview: null, mapSource: "role", fallbackPath: "assets/default.png", fallbackPreview: null, mappings: [] });
    if (type === "colorblock")
      Object.assign(base, { w_mm: 30, h_mm: 10, mapSource: "role", fallbackColor: "#9CA3AF", opacity: 100, mappings: [{ value: "competitor", color: "#1E5FD9" }], labelSource: "role", labelColor: "#FFFFFF" });
    if (type === "qr") Object.assign(base, { size_mm: 16, target: "https://example.org/{wcaId}" });
    if (type === "schedule") Object.assign(base, { w_mm: 60, h_mm: 40, dayIndex: 0, customTitle: "", excludedIds: [], columnLabels: { time: "", event: "", task: "" } });
    if (type === "taskkey") Object.assign(base, { w_mm: 70, stageNames: [] });
    addFieldObjects([base]);
  };

  // A copy of a field with a fresh id, moved by dx/dy mm.
  const cloneField = (f, dx, dy) => ({ ...structuredClone(f), id: uid(f.type), x_mm: round1(f.x_mm + dx), y_mm: round1(f.y_mm + dy) });

  const deleteSelection = () => {
    if (selectedIds.length === 0) return;
    setFields((fs) => fs.filter((f) => !selectedIds.includes(f.id)));
    setSelectedIds([]);
  };

  const duplicateSelection = () => {
    if (selectedFields.length === 0) return;
    addFieldObjects(selectedFields.map((f) => cloneField(f, 4, 4)));
  };

  // Pasted image or text from another app becomes a new field, centered.
  const pasteImage = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const w = Math.min(40, sideData.page.width_mm * 0.6);
        const h = round1((w * img.naturalHeight) / (img.naturalWidth || 1));
        addFieldObjects([
          {
            id: uid("image"),
            type: "image",
            x_mm: round1((sideData.page.width_mm - w) / 2),
            y_mm: round1((sideData.page.height_mm - h) / 2),
            rotate: 0,
            w_mm: w,
            h_mm: h,
            mapped: false,
            path: `assets/${file.name || "pasted.png"}`,
            preview: reader.result,
            mapSource: "role",
            fallbackPath: "assets/default.png",
            fallbackPreview: null,
            mappings: [],
            crop: { x: 0, y: 0, w: 1, h: 1 },
            fit: "contain",
          },
        ]);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  const pasteText = (text) => {
    const f = { id: uid("text"), type: "text", x_mm: round1(sideData.page.width_mm / 2), y_mm: round1(sideData.page.height_mm / 2), rotate: 0, ...textFieldDefaults() };
    Object.assign(f, { bindMode: "static", staticText: text, align: "center", size: 14 });
    addFieldObjects([f]);
  };

  // System clipboard, so copies also paste into another tab of the app;
  // images and text copied from other apps paste as new fields.
  useEffect(() => {
    const copySelection = (e) => {
      // Text highlighted on the page (a label, a panel…) copies as usual.
      if (isTypingTarget(e.target) || selectedFields.length === 0 || window.getSelection()?.toString()) return false;
      e.clipboardData.setData("text/plain", JSON.stringify({ [CLIPBOARD_MARKER]: true, side, fields: selectedFields }));
      e.preventDefault();
      pasteCountRef.current = 0;
      return true;
    };
    const onCopy = (e) => copySelection(e);
    const onCut = (e) => {
      if (copySelection(e)) deleteSelection();
    };
    const onPaste = (e) => {
      if (isTypingTarget(e.target)) return;
      const dt = e.clipboardData;
      const image = [...(dt.files || [])].find((f) => f.type.startsWith("image/"));
      if (image) {
        e.preventDefault();
        pasteImage(image);
        return;
      }
      const text = dt.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      let copied = null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed[CLIPBOARD_MARKER]) copied = parsed;
      } catch {
        // not ours: plain text
      }
      if (!copied) {
        pasteText(text.trim());
        return;
      }
      // Pasting where the originals still are: step each paste down-right
      // so the copies don't hide under them; elsewhere, paste in place.
      const onTop = copied.side === side && copied.fields.some((f) => fields.some((g) => g.id === f.id && g.x_mm === f.x_mm && g.y_mm === f.y_mm));
      const step = onTop ? 4 * ++pasteCountRef.current : 0;
      addFieldObjects(copied.fields.map((f) => cloneField(f, step, step)));
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  });

  // ---------- order (depth) ----------

  // Field DEPTH (stacking order): both the canvas preview (fields.map at
  // render time — later array entries land later in the DOM, so they sit
  // visually on top) and pdfExport.js's draw loop (later entries painted
  // last onto the same PDF page) already treat `fields` array order as
  // depth order, back-to-front.
  //
  // The layers list is shown reversed relative to storage, so the TOP row
  // is the FRONTMOST field (last in the actual array) — the usual layers
  // panel convention (Figma, Photoshop, etc.).
  const reorderSelection = (how) => {
    const sel = new Set(selectedIds);
    if (sel.size === 0) return;
    setFields((fs) => {
      const next = [...fs];
      if (how === "front") return [...next.filter((f) => !sel.has(f.id)), ...next.filter((f) => sel.has(f.id))];
      if (how === "back") return [...next.filter((f) => sel.has(f.id)), ...next.filter((f) => !sel.has(f.id))];
      if (how === "forward") {
        for (let i = next.length - 2; i >= 0; i--) if (sel.has(next[i].id) && !sel.has(next[i + 1].id)) [next[i], next[i + 1]] = [next[i + 1], next[i]];
      } else {
        for (let i = 1; i < next.length; i++) if (sel.has(next[i].id) && !sel.has(next[i - 1].id)) [next[i], next[i - 1]] = [next[i - 1], next[i]];
      }
      return next;
    });
  };

  const reorderFields = (draggedId, targetId) => {
    if (draggedId === targetId) return;
    const displayOrder = [...fields].reverse();
    const fromIdx = displayOrder.findIndex((f) => f.id === draggedId);
    const toIdx = displayOrder.findIndex((f) => f.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = displayOrder.splice(fromIdx, 1);
    displayOrder.splice(toIdx, 0, moved);
    setFields(() => [...displayOrder].reverse());
  };

  // ---------- align & distribute ----------

  // Each selected field's drawn bounds in mm from the page's top-left,
  // measured on screen so every kind of field (auto-width text, rotated
  // fields…) is handled the same way.
  const measureFields = (ids) => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    const page = canvas.getBoundingClientRect();
    const k = SCALE * zoom;
    return ids
      .map((id) => {
        const el = canvas.querySelector(`[data-field-id="${CSS.escape(id)}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { id, l: (r.left - page.left) / k, t: (r.top - page.top) / k, r: (r.right - page.left) / k, b: (r.bottom - page.top) / k };
      })
      .filter(Boolean);
  };

  // Moves fields by whole deltas: { id: { dx, dy } } in mm.
  const moveFieldsBy = (deltas, key) =>
    setFields((fs) => fs.map((f) => (deltas[f.id] ? { ...f, x_mm: round1(f.x_mm + (deltas[f.id].dx || 0)), y_mm: round1(f.y_mm + (deltas[f.id].dy || 0)) } : f)), key);

  // One field: aligned to the page. Several: to the box around them.
  const alignSelection = (how) => {
    const rects = measureFields(selectedIds);
    if (rects.length === 0) return;
    const box =
      rects.length === 1
        ? { l: 0, t: 0, r: sideData.page.width_mm, b: sideData.page.height_mm }
        : { l: Math.min(...rects.map((r) => r.l)), t: Math.min(...rects.map((r) => r.t)), r: Math.max(...rects.map((r) => r.r)), b: Math.max(...rects.map((r) => r.b)) };
    const deltas = {};
    for (const r of rects) {
      if (how === "left") deltas[r.id] = { dx: box.l - r.l };
      if (how === "hcenter") deltas[r.id] = { dx: (box.l + box.r) / 2 - (r.l + r.r) / 2 };
      if (how === "right") deltas[r.id] = { dx: box.r - r.r };
      if (how === "top") deltas[r.id] = { dy: box.t - r.t };
      if (how === "vcenter") deltas[r.id] = { dy: (box.t + box.b) / 2 - (r.t + r.b) / 2 };
      if (how === "bottom") deltas[r.id] = { dy: box.b - r.b };
    }
    moveFieldsBy(deltas);
  };

  // Equal gaps between three or more fields, keeping the outer two in place.
  const distributeSelection = (axis) => {
    const rects = measureFields(selectedIds);
    if (rects.length < 3) return;
    const [start, end] = axis === "h" ? ["l", "r"] : ["t", "b"];
    const sorted = [...rects].sort((a, b) => a[start] - b[start]);
    const span = sorted[sorted.length - 1][end] - sorted[0][start];
    const total = sorted.reduce((sum, r) => sum + (r[end] - r[start]), 0);
    const gap = (span - total) / (sorted.length - 1);
    let cursor = sorted[0][start];
    const deltas = {};
    for (const r of sorted) {
      deltas[r.id] = axis === "h" ? { dx: cursor - r[start] } : { dy: cursor - r[start] };
      cursor += r[end] - r[start] + gap;
    }
    moveFieldsBy(deltas);
  };

  // ---------- page-level settings ----------

  // Global (not per-field): every schedule field shows the same
  // competition, so they all share one timezone. Empty string means
  // "auto" — resolveScheduleTimezone() falls back to the WCIF venue's own
  // timezone in that case. Changing this re-derives sampleData.schedules
  // from the already-loaded raw WCIF (state.wcif) so the live preview
  // updates immediately, without needing to reload the WCIF file.
  const setScheduleTimezone = (tz) => {
    setState((prev) => {
      const next = { ...prev, scheduleTimezone: tz };
      if (prev.wcif) {
        next.sampleData = {
          ...prev.sampleData,
          schedules: buildGenericSchedule(prev.wcif, tz || undefined, scheduleOptions(prev)),
        };
      }
      return next;
    }, "timezone");
  };
  // Global like the timezone: renames and the MBLD submission task apply to
  // every schedule field. Same re-derivation as above, for the live preview.
  const updateScheduleSettings = (patch) =>
    setState((prev) => {
      const next = { ...prev, ...patch };
      if (prev.wcif) {
        next.sampleData = { ...prev.sampleData, schedules: buildGenericSchedule(prev.wcif, prev.scheduleTimezone || undefined, scheduleOptions(next)) };
      }
      return next;
    }, `schedule:${Object.keys(patch).join()}`);
  // kind: "events" (keyed by event id) or "activities" (keyed by the
  // activity's WCIF name). Empty text drops the rename.
  const setScheduleLabel = (kind, key, text) => {
    const group = { ...(state.scheduleLabels[kind] || {}) };
    if (text) group[key] = text;
    else delete group[key];
    updateScheduleSettings({ scheduleLabels: { ...state.scheduleLabels, [kind]: group } });
  };
  const updateMbldSubmission = (patch) => updateScheduleSettings({ mbldSubmission: { ...state.mbldSubmission, ...patch } });
  const scheduleTexts = state.wcif ? listScheduleTexts(state.wcif) : null;
  const detectedScheduleTimezone = state.wcif ? resolveScheduleTimezone(state.wcif) : null;

  // ---------- dragging, resizing, selection box, panning ----------

  const stateRef = useRef(state);
  stateRef.current = state;
  const sideRef = useRef(side);
  sideRef.current = side;

  // Applies { id: patch } to fields of the current side; no-op patches
  // leave the document untouched (so a click doesn't create an undo step).
  const applyFieldsPatch = (patches, key) =>
    setState((s) => {
      const sk = sideRef.current;
      let changed = false;
      const nextFields = s[sk].fields.map((f) => {
        const p = patches[f.id];
        if (!p || Object.keys(p).every((k) => f[k] === p[k])) return f;
        changed = true;
        return { ...f, ...p };
      });
      return changed ? { ...s, [sk]: { ...s[sk], fields: nextFields } } : s;
    }, key);

  const startDrag = (e, field, mode) => {
    if (spaceDown || e.button !== 0) return; // let the viewport pan instead
    e.stopPropagation();
    e.preventDefault();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive && mode === "move") {
      setSelectedIds((ids) => (ids.includes(field.id) ? ids.filter((i) => i !== field.id) : [...ids, field.id]));
      return;
    }
    // Dragging one of several selected fields moves them all; resizing is
    // always one field.
    const ids = mode === "move" && selectedIds.includes(field.id) ? selectedIds : [field.id];
    if (ids.length === 1) setSelectedIds([field.id]);
    const origins = {};
    for (const f of fields) if (ids.includes(f.id)) origins[f.id] = { x: f.x_mm, y: f.y_mm };
    dragRef.current = {
      id: field.id,
      ids,
      origins,
      mode,
      type: field.type,
      zoom,
      gesture: `gesture:${uid(mode)}`, // one undo step for the whole drag
      startX: e.clientX,
      startY: e.clientY,
      origX: field.x_mm,
      origY: field.y_mm,
      origW: fieldBoxWidthMm(field),
      origH: fieldBoxHeightMm(field),
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  };

  const onDragMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const s = stateRef.current;
    const sd = s[sideRef.current];
    const dx = (e.clientX - d.startX) / (SCALE * d.zoom);
    const dy = (e.clientY - d.startY) / (SCALE * d.zoom);
    const pw = sd.page.width_mm;
    const ph = sd.page.height_mm;
    if (d.mode === "move") {
      const rawX = clamp(d.origX + dx, 0, Math.max(pw - d.origW, 0));
      const rawY = clamp(d.origY + dy, 0, Math.max(ph - d.origH, 0));

      // Auto-alignment: snap the grabbed field to the page center, the
      // safe margin, or edges/centers of fields that aren't moving.
      const SNAP_TOL = 1.2; // mm
      const w = d.origW;
      const h = d.origH;
      const others = sd.fields.filter((f) => !d.ids.includes(f.id));

      // [position to snap to, where to draw the guide line]: alignment
      // snaps show the field's center line, safe-margin snaps the margin.
      const m = sd.safeMarginMm || 0;
      const marginX = m > 0 ? [[m, m], [pw - m - w, pw - m]] : [];
      const marginY = m > 0 ? [[m, m], [ph - m - h, ph - m]] : [];
      const candX = [
        ...marginX,
        [(pw - w) / 2, pw / 2],
        ...others.flatMap((f) => {
          const fw = fieldBoxWidthMm(f); // 0 for a non-wrap text field, its real box width when wrapped
          return [f.x_mm, f.x_mm + fw - w, f.x_mm + fw / 2 - w / 2].map((c) => [c, c + w / 2]);
        }),
      ];
      const candY = [
        ...marginY,
        [(ph - h) / 2, ph / 2],
        ...others.flatMap((f) => {
          const fh = fieldBoxHeightMm(f);
          return [f.y_mm, f.y_mm + fh - h, f.y_mm + fh / 2 - h / 2].map((c) => [c, c + h / 2]);
        }),
      ];

      let nx = rawX;
      let gx = null;
      for (const [c, guide] of candX) {
        if (Math.abs(rawX - c) <= SNAP_TOL) {
          nx = c;
          gx = guide;
          break;
        }
      }
      let ny = rawY;
      let gy = null;
      for (const [c, guide] of candY) {
        if (Math.abs(rawY - c) <= SNAP_TOL) {
          ny = c;
          gy = guide;
          break;
        }
      }

      setGuides({ x: gx, y: gy });
      const ddx = nx - d.origX;
      const ddy = ny - d.origY;
      const patches = {};
      for (const id of d.ids) patches[id] = { x_mm: round1(d.origins[id].x + ddx), y_mm: round1(d.origins[id].y + ddy) };
      applyFieldsPatch(patches, d.gesture);
    } else {
      const nw = clamp(d.origW + dx, MIN_MM, pw - d.origX);
      const dragged = sd.fields.find((f) => f.id === d.id);
      const patch = (p) => applyFieldsPatch({ [d.id]: p }, d.gesture);
      if (dragged?.type === "text" && dragged.textKind === "frame") {
        const nh = clamp(d.origH + dy, MIN_MM, ph - d.origY);
        patch({ frame: { ...dragged.frame, w_mm: round1(nw), ...(dragged.frame.auto_height ? {} : { h_mm: round1(nh) }) } });
      } else if (d.type === "schedule" || d.type === "taskkey") {
        // Height is derived, not draggable — width only.
        patch({ w_mm: round1(nw) });
      } else if (d.type === "qr") {
        // QR codes must stay square — a single size_mm, not independent
        // width/height (see drawQrField in pdfExport.js, which only ever
        // reads size_mm). Whichever axis the pointer moved further along
        // wins, so dragging diagonally, horizontally, or vertically from
        // the corner handle all behave the same way.
        const nh = clamp(d.origH + dy, MIN_MM, ph - d.origY);
        const newSize = Math.abs(nw - d.origW) >= Math.abs(nh - d.origH) ? nw : nh;
        const maxSize = Math.min(pw - d.origX, ph - d.origY);
        patch({ size_mm: round1(clamp(newSize, MIN_MM, maxSize)) });
      } else if (dragged?.type === "text") {
        // Wrapped point text: width, plus the box height when it has one.
        const nh = clamp(d.origH + dy, MIN_MM, ph - d.origY);
        patch({ w_mm: round1(nw), ...(dragged.boxHeightMm > 0 ? { boxHeightMm: round1(nh) } : {}) });
      } else {
        const nh = clamp(d.origH + dy, MIN_MM, ph - d.origY);
        patch({ w_mm: round1(nw), h_mm: round1(nh) });
      }
    }
  };

  const onDragEnd = () => {
    dragRef.current = null;
    setGuides({ x: null, y: null });
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
  };

  // Space + drag, or the middle mouse button: scroll the view around.
  const startPan = (e) => {
    e.preventDefault();
    const vp = viewportRef.current;
    const start = { x: e.clientX, y: e.clientY, left: vp.scrollLeft, top: vp.scrollTop };
    setPanning(true);
    const move = (ev) => {
      vp.scrollLeft = start.left - (ev.clientX - start.x);
      vp.scrollTop = start.top - (ev.clientY - start.y);
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Pressing on empty space (fields stop their own presses): a click
  // deselects, a drag draws a selection box selecting every field it
  // touches (added to the selection with Shift/Ctrl).
  const onViewportPointerDown = (e) => {
    if (e.button === 1 || spaceDown) {
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? selectedIds : [];
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      moved = true;
      const r = { left: Math.min(start.x, ev.clientX), top: Math.min(start.y, ev.clientY), right: Math.max(start.x, ev.clientX), bottom: Math.max(start.y, ev.clientY) };
      setMarquee(r);
      const hit = [...(canvasRef.current?.querySelectorAll("[data-field-id]") || [])]
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.right >= r.left && b.left <= r.right && b.bottom >= r.top && b.top <= r.bottom;
        })
        .map((el) => el.dataset.fieldId);
      setSelectedIds([...new Set([...base, ...hit])]);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMarquee(null);
      if (!moved && !additive) setSelectedIds([]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---------- zoom ----------

  const fitZoom = () => {
    const vp = viewportRef.current;
    if (!vp) return 1;
    const w = sideData.page.width_mm * SCALE;
    const h = sideData.page.height_mm * SCALE;
    return Math.max(0.05, Math.min((vp.clientWidth - 2 * VIEWPORT_PAD) / w, (vp.clientHeight - 2 * VIEWPORT_PAD) / h));
  };
  // anchor: a client point that should stay still on screen (pointer zoom).
  const zoomTo = (next, anchor) => {
    const z = clamp(next, pctToZoom(5), pctToZoom(1000));
    if (anchor && canvasRef.current) {
      const page = canvasRef.current.getBoundingClientRect();
      zoomAnchorRef.current = { clientX: anchor.x, clientY: anchor.y, pageX: (anchor.x - page.left) / zoom, pageY: (anchor.y - page.top) / zoom };
    }
    setZoom(z);
  };
  const zoomStep = (dir, anchor) => {
    const pct = zoomToPct(zoom);
    const nextPct = dir > 0 ? ZOOM_STEPS_PCT.find((p) => p > pct + 0.5) ?? ZOOM_STEPS_PCT.at(-1) : [...ZOOM_STEPS_PCT].reverse().find((p) => p < pct - 0.5) ?? ZOOM_STEPS_PCT[0];
    zoomTo(pctToZoom(nextPct), anchor);
  };

  // After a pointer-anchored zoom, scroll so that point is back under the pointer.
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current;
    if (!a || !canvasRef.current || !viewportRef.current) return;
    zoomAnchorRef.current = null;
    const page = canvasRef.current.getBoundingClientRect();
    viewportRef.current.scrollLeft += page.left + a.pageX * zoom - a.clientX;
    viewportRef.current.scrollTop += page.top + a.pageY * zoom - a.clientY;
  }, [zoom]);

  // Fit the page to the window when the editor opens, and whenever the
  // page shown changes size (other side, new page size).
  const pageW = sideData.page.width_mm;
  const pageH = sideData.page.height_mm;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const vp = viewportRef.current;
      if (!vp) return;
      setZoom(Math.max(0.05, Math.min((vp.clientWidth - 2 * VIEWPORT_PAD) / (pageW * SCALE), (vp.clientHeight - 2 * VIEWPORT_PAD) / (pageH * SCALE))));
    });
    return () => cancelAnimationFrame(frame);
  }, [side, pageW, pageH]);

  // Ctrl/⌘ + wheel zooms at the pointer (instead of zooming the browser).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(zoom * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  });

  // ---------- keyboard ----------

  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const typing = isTypingTarget(e.target);
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      // Layer order: Ctrl+] / Ctrl+[ (by key, or by physical key for
      // keyboards where brackets need AltGr), or Ctrl+↑ / Ctrl+↓.
      const forward = e.key === "]" || e.key === "}" || e.code === "BracketRight" || e.key === "ArrowUp";
      const backward = e.key === "[" || e.key === "{" || e.code === "BracketLeft" || e.key === "ArrowDown";

      // [condition, action]: the first match runs, and the browser's own
      // handling of that key is cancelled.
      const shortcuts = [
        // These would otherwise zoom, save or open in the browser itself,
        // so they work even while typing in a box.
        [mod && (e.key === "+" || e.key === "="), () => zoomStep(1)],
        [mod && (e.key === "-" || e.key === "_"), () => zoomStep(-1)],
        [mod && e.key === "0", () => setZoom(fitZoom())],
        [mod && e.key === "1", () => zoomTo(pctToZoom(100))],
        [mod && key === "s", exportTemplate],
        [mod && key === "o", () => importInputRef.current?.click()],
        // From here on, only outside text boxes: there, copy, undo, arrows…
        // belong to the box.
        [!typing && e.key === " ", () => setSpaceDown(true)],
        [!typing && mod && key === "z", () => (e.shiftKey ? redo() : undo())],
        [!typing && mod && key === "y", redo],
        [!typing && mod && key === "a", () => setSelectedIds(fields.map((f) => f.id))],
        [!typing && mod && key === "d", duplicateSelection],
        [!typing && mod && (forward || backward), () => reorderSelection(forward ? (e.shiftKey ? "front" : "forward") : e.shiftKey ? "back" : "backward")],
        [!typing && (e.key === "Delete" || e.key === "Backspace") && selectedIds.length > 0, deleteSelection],
        [
          !typing && !mod && arrows[e.key] && selectedIds.length > 0,
          () => {
            const stepMm = e.shiftKey ? 10 : 1;
            const [ax, ay] = arrows[e.key];
            moveFieldsBy(Object.fromEntries(selectedIds.map((id) => [id, { dx: ax * stepMm, dy: ay * stepMm }])), "nudge");
          },
        ],
        [!typing && (e.key === "?" || (mod && e.key === "/")), () => setShowShortcuts((v) => !v)],
      ];

      if (e.key === "Escape") {
        if (showShortcuts || showAbout) {
          setShowShortcuts(false);
          setShowAbout(false);
        } else if (!typing) setSelectedIds([]);
        return;
      }
      const match = shortcuts.find(([when]) => when);
      if (match) {
        e.preventDefault();
        match[1]();
      }
    };
    const onKeyUp = (e) => {
      if (e.key === " ") setSpaceDown(false);
    };
    const onBlur = () => setSpaceDown(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  });

  // ---------- assets, templates, PDF ----------

  const onBgUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => updateSide({ background: reader.result, backgroundName: `assets/${file.name}` });
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const updateSampleValue = (key, value) => setState((s) => ({ ...s, sampleData: { ...s.sampleData, [key]: value } }), `sample:${key}`);
  const addSampleKey = () => {
    const key = prompt("New data field name (e.g. team, gender):");
    if (key && !(key in state.sampleData)) setState((s) => ({ ...s, sampleData: { ...s.sampleData, [key]: "" } }));
  };
  const removeSampleKey = (key) =>
    setState((s) => {
      const d = { ...s.sampleData };
      delete d[key];
      return { ...s, sampleData: d };
    });

  const uploadFont = (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const baseName = file.name.replace(/\.(ttf|otf|woff2?|)$/i, "");
      const family = `custom-${baseName}-${uid("f")}`.replace(/[^a-zA-Z0-9_-]/g, "");
      try {
        const face = new FontFace(family, `url(${dataUrl})`);
        await face.load();
        document.fonts.add(face);
      } catch (err) {
        console.error("Font failed to load", err);
      }
      setState((s) => ({ ...s, fonts: [...s.fonts, { id: uid("font"), family, displayName: baseName, filename: file.name, dataUrl }] }));
    };
    reader.readAsDataURL(file);
  };
  const renameFontDisplay = (id, displayName) => setState((s) => ({ ...s, fonts: s.fonts.map((f) => (f.id === id ? { ...f, displayName } : f)) }), `fontname:${id}`);
  const removeFont = (id) => setState((s) => ({ ...s, fonts: s.fonts.filter((f) => f.id !== id) }));

  const [addingGoogleFont, setAddingGoogleFont] = useState(null); // preset.label currently being fetched, or null
  const addGoogleFontPreset = async (preset) => {
    setAddingGoogleFont(preset.label);
    try {
      const dataUrl = await fetchGoogleFontFamilyDataUrl(preset.family, preset.weight);
      const family = `custom-${preset.label.replace(/\s+/g, "")}-${uid("f")}`.replace(/[^a-zA-Z0-9_-]/g, "");
      try {
        const face = new FontFace(family, `url(${dataUrl})`);
        await face.load();
        document.fonts.add(face);
      } catch (err) {
        console.error("Font failed to load", err);
      }
      setState((s) => ({ ...s, fonts: [...s.fonts, { id: uid("font"), family, displayName: preset.label, filename: `${preset.family}-${preset.weight}.ttf`, dataUrl }] }));
    } catch (e) {
      console.error(`Could not fetch "${preset.label}" from Google Fonts`, e);
      alert(`Could not fetch "${preset.label}" from Google Fonts. Check your network connection and try again.`);
    } finally {
      setAddingGoogleFont(null);
    }
  };

  const allFontOptions = [...BUILTIN_FONTS, ...state.fonts.map((f) => f.family)];
  const fontLabel = (family) => state.fonts.find((f) => f.family === family)?.displayName || family;

  const applyPreset = (preset) => {
    if (preset.w == null) return;
    updateSide({ page: { width_mm: preset.w, height_mm: preset.h } });
  };

  const exportTemplate = () => {
    const cleanFields = (arr) =>
      arr.map((f) => {
        const out = { id: f.id, type: f.type, x_mm: f.x_mm, y_mm: f.y_mm, rotate: f.rotate || 0 };
        if (f.type === "text") {
          out.bindMode = f.bindMode || "field";
          if (out.bindMode === "static") {
            out.text = f.staticText;
          } else if (out.bindMode === "template") {
            out.template = f.template;
          } else {
            out.source = f.source;
            if (f.useValueMap) Object.assign(out, { value_map: f.valueMap, ...(f.genderVariants ? { gender_variants: true } : {}) });
          }
          Object.assign(out, { font: f.font, color: f.color, align: f.align || "left", letter_spacing: f.letterSpacing || 0, wrap: !!f.wrap });
          if (f.wrap) Object.assign(out, { w_mm: f.w_mm, break_style: f.breakStyle, line_height: f.lineHeight || 1.05 });
          if (f.textCase && f.textCase !== "none") out.text_case = f.textCase;
          if (f.colorMap?.enabled) out.color_map = { source: f.colorMap.source, mappings: f.colorMap.mappings };
          if (f.textKind === "frame") {
            Object.assign(out, { text_kind: "frame", frame: f.frame, size: f.size, line_height: f.lineHeight || 1.05, break_style: f.breakStyle });
          } else if (f.fontMode === "autofit") Object.assign(out, { size_min: f.size_min, size_max: f.size_max, max_width_mm: f.max_width_mm || 60 });
          else out.size = f.size;
          if (f.textKind !== "frame" && f.boxHeightMm > 0) Object.assign(out, { box_height_mm: f.boxHeightMm, v_align: f.vAlign || "top" });
        } else if (f.type === "image") {
          Object.assign(out, { w_mm: f.w_mm, h_mm: f.h_mm, mapped: f.mapped });
          if (!isFullCrop(f.crop)) out.crop = f.crop;
          if (f.fit && f.fit !== "contain") out.fit = f.fit;
          if (f.mapped) {
            Object.assign(out, {
              mapSource: f.mapSource,
              fallbackPath: f.fallbackPath,
              fallbackPreview: f.fallbackPreview || null,
              mappings: f.mappings.map((m) => ({ value: m.value, path: m.path, preview: m.preview || null })),
            });
          } else {
            out.path = f.path;
            out.preview = f.preview || null;
          }
        } else if (f.type === "colorblock") {
          Object.assign(out, { w_mm: f.w_mm, h_mm: f.h_mm, mapSource: f.mapSource, fallbackColor: f.fallbackColor, opacity: f.opacity, mappings: f.mappings, labelSource: f.labelSource, labelColor: f.labelColor });
        } else if (f.type === "qr") {
          Object.assign(out, { target: f.target, size_mm: f.size_mm });
        } else if (f.type === "schedule") {
          Object.assign(out, { w_mm: f.w_mm, h_mm: f.h_mm, dayIndex: f.dayIndex || 0, customTitle: f.customTitle || "", excludedIds: f.excludedIds || [], columnLabels: f.columnLabels });
        } else if (f.type === "taskkey") {
          Object.assign(out, { w_mm: f.w_mm, stageNames: f.stageNames || [] });
        }
        return out;
      });
    const cleanTint = (t) => ({ enabled: t.enabled, mapSource: t.mapSource, fallbackColor: t.fallbackColor, mappings: t.mappings });
    const cleanBgMap = (b) => ({
      enabled: b.enabled,
      mapSource: b.mapSource,
      fallbackPath: b.fallbackPath,
      fallbackPreview: b.fallbackPreview || null,
      mappings: b.mappings.map((m) => ({ value: m.value, path: m.path, preview: m.preview || null })),
    });

    const fontsManifest = {};
    state.fonts.forEach((f) => {
      fontsManifest[f.family] = { display_name: f.displayName, path: `assets/fonts/${f.filename}`, data_url: f.dataUrl || null };
    });

    const out = {
      sample_data: state.sampleData,
      schedule_timezone: state.scheduleTimezone || "",
      role_mapping: state.roleMapping,
      stage_colors: state.stageColors,
      schedule_labels: state.scheduleLabels,
      mbld_submission: state.mbldSubmission,
      merged_rounds: state.mergedRounds,
      fonts: fontsManifest,
      front: {
        page: state.front.page,
        safe_margin_mm: state.front.safeMarginMm,
        background: state.front.backgroundName,
        background_data: state.front.background || null,
        background_tint: cleanTint(state.front.tint),
        background_map: cleanBgMap(state.front.backgroundMap),
        fields: cleanFields(state.front.fields),
      },
      back: {
        page: state.back.page,
        safe_margin_mm: state.back.safeMarginMm,
        background: state.back.backgroundName,
        background_data: state.back.background || null,
        background_tint: cleanTint(state.back.tint),
        background_map: cleanBgMap(state.back.backgroundMap),
        fields: cleanFields(state.back.fields),
      },
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "template.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const generateAllBadges = async () => {
    if (!state.wcif) {
      setActiveTab("competition");
      alert("Load a competition first (Competition tab) — the PDF is built from real competitors, not the sample preview data.");
      return;
    }
    setGenerating({ done: 0, total: 0 });
    try {
      const bytes = await generateBadgesPdf(state, state.wcif, (done, total) => setGenerating({ done, total }));
      downloadPdfBytes(bytes, `${state.wcif.id || "badges"}_print_ready.pdf`);
      setGenerating(null);
    } catch (err) {
      console.error(err);
      alert(`Couldn't generate the PDF: ${err.message}`);
      setGenerating(null);
    }
  };

  const importTemplate = (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        const next = inflateTemplate(data);

        // Re-register any fonts that came with embedded data, so they
        // render immediately without needing a re-upload.
        for (const f of next.fonts) {
          if (f.dataUrl) {
            try {
              const face = new FontFace(f.family, `url(${f.dataUrl})`);
              await face.load();
              document.fonts.add(face);
              f.needsReupload = false;
            } catch (err) {
              console.error("Font failed to load on import", err);
              f.needsReupload = true;
            }
          }
        }

        setState(next);
        setSelectedIds([]);
        setSide("front");

        const missingFonts = next.fonts.some((f) => f.needsReupload);
        const missingFrontBg = !!data.front?.background && !data.front?.background_data;
        const missingBackBg = !!data.back?.background && !data.back?.background_data;
        if (missingFonts || missingFrontBg || missingBackBg) {
          alert(
            "Template imported. This file predates embedded assets (or a font failed to load) — some backgrounds/images/fonts will need re-uploading. Anything exported after this update carries its own images and fonts, so re-importing it needs no re-uploads at all."
          );
        }
      } catch (err) {
        console.error(err);
        alert("Couldn't import that file — is it a valid template.json exported from this app?");
      }
    };
    reader.readAsText(file, "utf-8");
  };

  const pw = sideData.page.width_mm * SCALE;
  const ph = sideData.page.height_mm * SCALE;
  const tintColor = sideData.tint.enabled ? resolveMapping({ mapSource: sideData.tint.mapSource, mappings: sideData.tint.mappings, fallbackColor: sideData.tint.fallbackColor }, state.sampleData, "color") : null;
  const bgMapEnabled = sideData.backgroundMap?.enabled;
  const bgMapMatch = bgMapEnabled ? resolveMapping(sideData.backgroundMap, state.sampleData, "image") : null;
  const bgMapSrc = bgMapEnabled ? (bgMapMatch ? bgMapMatch.preview : sideData.backgroundMap.fallbackPreview) : null;
  const personCount = state.wcif ? badgeablePersons(state.wcif).length : 0;

  const iconButton = "p-1.5 rounded-md text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="w-full h-screen bg-neutral-100 text-neutral-900 flex flex-col overflow-hidden" style={{ fontFamily: "system-ui, sans-serif" }}>
      {/* ---------- top bar ---------- */}
      <div className="h-12 shrink-0 flex items-center gap-2 px-3 bg-white border-b border-neutral-200">
        <button onClick={() => setShowAbout(true)} className="flex items-center gap-1.5 pr-2 mr-1 border-r border-neutral-200 font-semibold text-sm hover:text-blue-700" title="About and credits">
          <BadgeCheck size={18} className="text-blue-600" />
          <span className="hidden md:inline">Badge Designer</span>
        </button>
        <button onClick={undo} disabled={!canUndo} className={iconButton} title="Undo (Ctrl+Z)">
          <Undo2 size={16} />
        </button>
        <button onClick={redo} disabled={!canRedo} className={iconButton} title="Redo (Ctrl+Shift+Z)">
          <Redo2 size={16} />
        </button>
        <div className="w-px h-6 bg-neutral-200 mx-1" />
        <div className="flex rounded-md overflow-hidden border border-neutral-300 text-sm">
          {["front", "back"].map((s) => (
            <button
              key={s}
              onClick={() => {
                setSide(s);
                setSelectedIds([]);
              }}
              className={`px-3 py-1 font-medium capitalize ${side === s ? "bg-neutral-900 text-white" : "bg-white text-neutral-600 hover:bg-neutral-50"}`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* page of the side shown: size and safe margin */}
        <div className="hidden md:flex items-center gap-1.5 text-xs text-neutral-500 ml-1">
          <select
            onChange={(e) => applyPreset(PAGE_PRESETS[Number(e.target.value)])}
            value={String(PAGE_PRESETS.findIndex((p) => p.w === sideData.page.width_mm && p.h === sideData.page.height_mm))}
            className="text-xs px-1.5 py-1 border border-neutral-300 rounded-md text-neutral-700 max-w-40"
            title="Page size"
          >
            <option value="-1" disabled>
              Custom size
            </option>
            {PAGE_PRESETS.filter((p) => p.w != null).map((p) => (
              <option key={p.label} value={PAGE_PRESETS.indexOf(p)}>
                {p.label}
              </option>
            ))}
          </select>
          <input type="number" step="0.5" value={sideData.page.width_mm} onChange={(e) => updateSide({ page: { ...sideData.page, width_mm: Number(e.target.value) } }, `page:${side}:w`)} className="w-14 px-1.5 py-1 border border-neutral-300 rounded text-neutral-800" title="Width (mm)" />
          <span>×</span>
          <input type="number" step="0.5" value={sideData.page.height_mm} onChange={(e) => updateSide({ page: { ...sideData.page, height_mm: Number(e.target.value) } }, `page:${side}:h`)} className="w-14 px-1.5 py-1 border border-neutral-300 rounded text-neutral-800" title="Height (mm)" />
          <span>mm</span>
          <span className="ml-2" title="Safe margin: a guide drawn this far inside every edge while designing. Not printed.">
            Margin
          </span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={sideData.safeMarginMm}
            onChange={(e) => updateSide({ safeMarginMm: clamp(Number(e.target.value) || 0, 0, Math.min(sideData.page.width_mm, sideData.page.height_mm) / 2) }, `margin:${side}`)}
            className="w-12 px-1.5 py-1 border border-neutral-300 rounded text-neutral-800"
            title="Safe margin (mm) — guide only, not printed"
          />
        </div>

        <div className="flex-1" />

        <div className="relative">
          <button
            onClick={() => setShowCompMenu((v) => !v)}
            className={`hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md max-w-64 ${state.wcif ? "bg-emerald-50 text-emerald-800 hover:bg-emerald-100" : "bg-amber-50 text-amber-800 hover:bg-amber-100"}`}
            title={state.wcif ? "Competition loaded — click to load another" : "Load a competition"}
          >
            <Trophy size={13} className="shrink-0" />
            <span className="truncate">{state.wcif ? `${state.wcif.name || state.wcif.id} · ${personCount} people` : "Load competition"}</span>
            <ChevronDown size={13} className="shrink-0" />
          </button>
          {showCompMenu && (
            <CompetitionMenu
              loaded={state.wcif}
              onLoadId={async (id) => {
                if (await loadWcifData(id)) setShowCompMenu(false);
              }}
              onOpenFile={async (file) => {
                if (await loadWcifData(file)) setShowCompMenu(false);
              }}
              onManage={() => {
                setActiveTab("competition");
                setShowCompMenu(false);
              }}
              onClose={() => setShowCompMenu(false)}
            />
          )}
        </div>

        <button onClick={() => importInputRef.current?.click()} className={`${iconButton} flex items-center gap-1.5 text-sm px-2.5`} title="Open template (Ctrl+O)">
          <FolderOpen size={15} /> <span className="hidden lg:inline">Open</span>
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importTemplate(file);
            e.target.value = "";
          }}
        />
        <button onClick={exportTemplate} className={`${iconButton} flex items-center gap-1.5 text-sm px-2.5`} title="Save template.json (Ctrl+S)">
          <Save size={15} /> <span className="hidden lg:inline">Save</span>
        </button>
        <button
          onClick={generateAllBadges}
          disabled={!!generating}
          title={state.wcif ? `Generate badges for everyone in ${state.wcif.name || state.wcif.id}` : "Load a competition first"}
          className="flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Printer size={14} />
          {generating ? (generating.total ? `Generating ${generating.done}/${generating.total}…` : "Starting…") : "Generate PDF"}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ---------- left rail + panel ---------- */}
        <div className="w-16 shrink-0 bg-white border-r border-neutral-200 flex flex-col items-stretch py-2 gap-1">
          {LEFT_TABS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(active ? null : t.id)}
                className={`mx-1.5 flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] ${active ? "bg-blue-50 text-blue-700" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"}`}
              >
                <Icon size={19} />
                {t.label}
              </button>
            );
          })}
          <div className="flex-1" />
          <button onClick={() => setShowShortcuts(true)} className="mx-1.5 flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800" title="Keyboard shortcuts (?)">
            <Keyboard size={19} />
            Shortcuts
          </button>
        </div>

        {activeTab && (
          <div className="w-80 shrink-0 bg-white border-r border-neutral-200 flex flex-col min-h-0">
            <div className="h-11 shrink-0 flex items-center justify-between px-4 border-b border-neutral-100">
              <div className="text-sm font-semibold">{LEFT_TABS.find((t) => t.id === activeTab)?.label}</div>
              <button onClick={() => setActiveTab(null)} className="text-neutral-400 hover:text-neutral-700" title="Close panel">
                <PanelLeftClose size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {activeTab === "elements" && (
                <div className="p-4 space-y-4">
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(TYPE_META).map(([type, meta]) => {
                      const Icon = meta.icon;
                      return (
                        <button
                          key={type}
                          onClick={() => (type === "schedule" ? handleAddSchedule() : addField(type))}
                          className="flex flex-col items-center justify-center gap-2 h-20 rounded-lg border border-neutral-200 bg-neutral-50 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 text-xs text-neutral-700"
                        >
                          <Icon size={22} />
                          {meta.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="text-[11px] text-neutral-400 leading-relaxed">
                    Tip: paste an image or some text copied from anywhere (Ctrl+V) to drop it straight onto the badge. Press <kbd className="px-1 border border-neutral-300 rounded">?</kbd> for all shortcuts.
                  </div>
                </div>
              )}

              {activeTab === "layers" && (
                <div className="p-3">
                  <div className="text-[11px] text-neutral-400 mb-2 px-1">Top is frontmost. Drag to reorder; Shift/Ctrl+click to select several.</div>
                  <div className="space-y-0.5">
                    {[...fields].reverse().map((f) => {
                      const Icon = TYPE_META[f.type].icon;
                      const isSelected = selectedIds.includes(f.id);
                      return (
                        <div
                          key={f.id}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            setDraggingFieldId(f.id);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (draggingFieldId) reorderFields(draggingFieldId, f.id);
                            setDraggingFieldId(null);
                          }}
                          onDragEnd={() => setDraggingFieldId(null)}
                          onClick={(e) => {
                            if (e.shiftKey || e.ctrlKey || e.metaKey) setSelectedIds((ids) => (ids.includes(f.id) ? ids.filter((i) => i !== f.id) : [...ids, f.id]));
                            else setSelectedIds([f.id]);
                          }}
                          className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm cursor-pointer select-none ${isSelected ? "bg-blue-50 text-blue-700" : "hover:bg-neutral-50 text-neutral-700"} ${draggingFieldId === f.id ? "opacity-40" : ""}`}
                        >
                          <GripVertical size={13} className="text-neutral-300 cursor-grab shrink-0" />
                          <Icon size={14} className="shrink-0" />
                          <span className="flex-1 truncate">{fieldDisplayName(f)}</span>
                          {outsideIds.includes(f.id) && (
                            <span title="Goes past the safe margin — it may get cut off when printing" className="text-amber-500 shrink-0">
                              <TriangleAlert size={13} />
                            </span>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFields((fs) => fs.filter((x) => x.id !== f.id));
                            }}
                            className="text-neutral-300 hover:text-red-500 shrink-0 opacity-0 group-hover:opacity-100"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      );
                    })}
                    {fields.length === 0 && <div className="text-xs text-neutral-400 px-1">No elements on the {side} yet — add some from Elements.</div>}
                  </div>
                </div>
              )}

              {activeTab === "competition" && (
                <div>
                  <div className="p-4 space-y-3">
                    {state.wcif ? (
                      <div className="rounded-lg bg-emerald-50 text-emerald-900 px-3 py-2 text-sm">
                        <div className="font-medium">{state.wcif.name || state.wcif.id}</div>
                        <div className="text-xs text-emerald-700">{personCount} people get a badge</div>
                      </div>
                    ) : (
                      <div className="text-xs text-neutral-500">Load the competition's WCIF to preview its schedule and generate everyone's badges.</div>
                    )}
                    <label className="flex items-center justify-center gap-1.5 text-sm px-3 py-2 border border-blue-300 bg-blue-50 text-blue-700 rounded-md cursor-pointer hover:bg-blue-100">
                      <FileUp size={14} />
                      {state.wcif ? "Load another WCIF file" : "Load WCIF file"}
                      <input
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) loadWcifData(file);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <form
                      className="flex gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (compIdInput.trim()) loadWcifData(compIdInput.trim());
                      }}
                    >
                      <input value={compIdInput} onChange={(e) => setCompIdInput(e.target.value)} placeholder="…or a WCA competition ID" className="flex-1 min-w-0 text-sm px-2 py-1.5 border border-neutral-300 rounded-md" />
                      <button type="submit" className="text-sm px-3 py-1.5 border border-neutral-300 rounded-md hover:bg-neutral-50">
                        Load
                      </button>
                    </form>
                  </div>
                  <RoleMappingPanel roleMapping={state.roleMapping} onChange={updateRoleMapping} persons={state.wcif ? badgeablePersons(state.wcif) : null} />
                  <SchedulePanel
                    texts={scheduleTexts}
                    labels={state.scheduleLabels}
                    onLabelChange={setScheduleLabel}
                    mbldSubmission={state.mbldSubmission}
                    onMbldChange={updateMbldSubmission}
                    mergedRounds={state.mergedRounds}
                    onMergedRoundsChange={(codes) => updateScheduleSettings({ mergedRounds: codes })}
                  />
                  <StageColorsPanel stages={state.sampleData.stages || []} stageColors={state.stageColors} onChange={setStageColor} />
                </div>
              )}

              {activeTab === "background" && (
                <div>
                  <div className="p-4 space-y-2">
                    <div className="text-xs text-neutral-500">Background of the {side}.</div>
                    <div className="flex gap-2">
                      <label className="flex-1 flex items-center justify-center gap-1.5 text-sm px-3 py-2 border border-neutral-300 rounded-md cursor-pointer hover:bg-neutral-50">
                        <Upload size={14} />
                        {sideData.background ? "Replace image" : "Upload image"}
                        <input type="file" accept="image/*" className="hidden" onChange={onBgUpload} />
                      </label>
                      {sideData.background && (
                        <button onClick={() => updateSide({ background: null })} className="text-sm px-3 py-2 border border-neutral-300 rounded-md hover:bg-neutral-50 text-neutral-600" title="Remove background">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  <TintPanel tint={sideData.tint} sampleData={state.sampleData} onChange={updateTint} />
                  <BackgroundMapPanel bgMap={sideData.backgroundMap} sampleData={state.sampleData} onChange={updateBackgroundMap} />
                </div>
              )}

              {activeTab === "fonts" && (
                <FontsPanel fonts={state.fonts} onUpload={uploadFont} onRename={renameFontDisplay} onRemove={removeFont} onAddGooglePreset={addGoogleFontPreset} addingGoogleFont={addingGoogleFont} />
              )}

              {activeTab === "data" && <DataPanel sampleData={state.sampleData} updateSampleValue={updateSampleValue} addSampleKey={addSampleKey} removeSampleKey={removeSampleKey} />}
            </div>
          </div>
        )}

        {/* ---------- canvas ---------- */}
        <div className="flex-1 min-w-0 relative">
          <div
            ref={viewportRef}
            onPointerDown={onViewportPointerDown}
            className="absolute inset-0 overflow-auto"
            style={{ cursor: panning ? "grabbing" : spaceDown ? "grab" : "default" }}
          >
            <div style={{ minWidth: "100%", minHeight: "100%", width: pw * zoom + 2 * VIEWPORT_PAD, height: ph * zoom + 2 * VIEWPORT_PAD, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: pw * zoom, height: ph * zoom, flexShrink: 0 }}>
                <div
                  ref={canvasRef}
                  style={{ width: pw, height: ph, backgroundColor: "#ffffff", position: "relative", transform: `scale(${zoom})`, transformOrigin: "top left", pointerEvents: spaceDown ? "none" : undefined }}
                  className="shadow-lg ring-1 ring-neutral-300 overflow-hidden"
                >
                  {bgMapEnabled ? (
                    bgMapSrc && <img src={bgMapSrc} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    sideData.background && (
                      <>
                        <img src={sideData.background} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: sideData.tint.enabled ? "grayscale(1)" : "none" }} />
                        {sideData.tint.enabled && <div style={{ position: "absolute", inset: 0, background: tintColor, mixBlendMode: "multiply" }} />}
                      </>
                    )
                  )}
                  {fields.map((f) => (
                    <FieldBox
                      key={f.id}
                      field={f}
                      scale={SCALE}
                      selected={selectedIds.includes(f.id)}
                      showHandles={selectedIds.length === 1 && selectedIds[0] === f.id}
                      outsideMargin={outsideIds.includes(f.id)}
                      sampleData={state.sampleData}
                      onPointerDownMove={(e) => startDrag(e, f, "move")}
                      onPointerDownResize={(e) => startDrag(e, f, "resize")}
                    />
                  ))}
                  {sideData.safeMarginMm > 0 && (
                    <div style={{ position: "absolute", inset: sideData.safeMarginMm * SCALE, border: "1px dashed rgba(236, 72, 153, 0.8)", pointerEvents: "none" }} />
                  )}
                  {guides.x !== null && <div style={{ position: "absolute", left: guides.x * SCALE, top: 0, bottom: 0, width: 1 / zoom, background: "#2563eb", pointerEvents: "none" }} />}
                  {guides.y !== null && <div style={{ position: "absolute", top: guides.y * SCALE, left: 0, right: 0, height: 1 / zoom, background: "#2563eb", pointerEvents: "none" }} />}
                </div>
              </div>
            </div>
          </div>

          {marquee && (
            <div
              style={{ position: "fixed", left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top, border: "1px solid #3b82f6", background: "rgba(59,130,246,0.08)", pointerEvents: "none", zIndex: 40 }}
            />
          )}

          {/* zoom controls */}
          <div className="absolute bottom-3 right-3 flex items-center gap-0.5 bg-white rounded-lg shadow-md border border-neutral-200 px-1 py-1 text-sm">
            <button onClick={() => zoomStep(-1)} className={iconButton} title="Zoom out (Ctrl −)">
              <ZoomOut size={15} />
            </button>
            <button onClick={() => zoomTo(pctToZoom(100))} className="w-14 text-center text-xs tabular-nums text-neutral-700 hover:bg-neutral-100 rounded py-1" title="Actual size (Ctrl 1)">
              {Math.round(zoomToPct(zoom))}%
            </button>
            <button onClick={() => zoomStep(1)} className={iconButton} title="Zoom in (Ctrl +)">
              <ZoomIn size={15} />
            </button>
            <div className="w-px h-5 bg-neutral-200 mx-0.5" />
            <button onClick={() => setZoom(fitZoom())} className={iconButton} title="Fit to screen (Ctrl 0)">
              <Maximize size={15} />
            </button>
          </div>
        </div>

        {/* ---------- right: properties of the selection (hidden otherwise) ---------- */}
        {selectedFields.length > 0 && (
          <div className="w-80 shrink-0 bg-white border-l border-neutral-200 overflow-y-auto">
            <div className="p-4 space-y-3 border-b border-neutral-200">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-neutral-500 uppercase">
                  {selectedField ? TYPE_META[selectedField.type].label : `${selectedFields.length} elements`}
                </div>
                <div className="flex items-center gap-0.5">
                  <button onClick={duplicateSelection} className={iconButton} title="Duplicate (Ctrl+D)">
                    <CopyPlus size={15} />
                  </button>
                  <button onClick={deleteSelection} className={`${iconButton} hover:text-red-600`} title="Delete (Del)">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <div>
                <div className="text-[11px] text-neutral-500 mb-1">{selectedFields.length === 1 ? "Align to page" : "Align"}</div>
                <div className="flex items-center gap-0.5">
                  {[
                    ["left", AlignHorizontalJustifyStart, "Align left"],
                    ["hcenter", AlignHorizontalJustifyCenter, "Align centers horizontally"],
                    ["right", AlignHorizontalJustifyEnd, "Align right"],
                    ["top", AlignVerticalJustifyStart, "Align top"],
                    ["vcenter", AlignVerticalJustifyCenter, "Align centers vertically"],
                    ["bottom", AlignVerticalJustifyEnd, "Align bottom"],
                  ].map(([how, Icon, title]) => (
                    <button key={how} onClick={() => alignSelection(how)} className={iconButton} title={title}>
                      <Icon size={16} />
                    </button>
                  ))}
                  {selectedFields.length >= 3 && (
                    <>
                      <div className="w-px h-5 bg-neutral-200 mx-0.5" />
                      <button onClick={() => distributeSelection("h")} className={iconButton} title="Distribute horizontally">
                        <AlignHorizontalDistributeCenter size={16} />
                      </button>
                      <button onClick={() => distributeSelection("v")} className={iconButton} title="Distribute vertically">
                        <AlignVerticalDistributeCenter size={16} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-neutral-500 mb-1">Order</div>
                <div className="flex items-center gap-0.5">
                  <button onClick={() => reorderSelection("front")} className={iconButton} title="Bring to front (Ctrl+Shift+])">
                    <BringToFront size={16} />
                  </button>
                  <button onClick={() => reorderSelection("forward")} className={iconButton} title="Bring forward (Ctrl+])">
                    <ArrowUp size={16} />
                  </button>
                  <button onClick={() => reorderSelection("backward")} className={iconButton} title="Send backward (Ctrl+[)">
                    <ArrowDown size={16} />
                  </button>
                  <button onClick={() => reorderSelection("back")} className={iconButton} title="Send to back (Ctrl+Shift+[)">
                    <SendToBack size={16} />
                  </button>
                </div>
              </div>
            </div>

          {selectedField && (
            <PropertiesPanel
              field={selectedField}
              sampleData={state.sampleData}
              fontOptions={allFontOptions}
              fontLabel={fontLabel}
              pageWidth={sideData.page.width_mm}
              pageHeight={sideData.page.height_mm}
              onChange={(patch) => updateField(selectedField.id, patch)}
              scheduleTimezone={state.scheduleTimezone}
              detectedScheduleTimezone={detectedScheduleTimezone}
              onScheduleTimezoneChange={setScheduleTimezone}
              onSyncCountryFlags={() => syncCountryFlagsForField(selectedField.id)}
              hasWcif={!!state.wcif}
            />
          )}
          </div>
        )}
      </div>

      {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
    </div>
  );
}

// Top-bar menu for the competition: the public WCIF straight from the WCA
// by competition ID, or a WCIF file (e.g. the full one downloaded from the
// competition's admin pages).
function CompetitionMenu({ loaded, onLoadId, onOpenFile, onManage, onClose }) {
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="fixed inset-0 z-30" onPointerDown={onClose} />
      <div className="absolute right-0 top-full mt-1.5 z-40 w-80 bg-white rounded-lg shadow-xl border border-neutral-200 p-3 space-y-3 text-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (id.trim()) run(() => onLoadId(id.trim()));
          }}
        >
          <div className="text-[11px] font-semibold text-neutral-500 mb-1">From the WCA website</div>
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="Competition ID, e.g. SpanishChampionship2026"
              className="flex-1 min-w-0 text-sm px-2 py-1.5 border border-neutral-300 rounded-md"
            />
            <button type="submit" disabled={busy || !id.trim()} className="px-3 py-1.5 rounded-md bg-blue-600 text-white disabled:opacity-50">
              {busy ? "…" : "Load"}
            </button>
          </div>
          <div className="text-[10px] text-neutral-400 mt-1">The ID is the last part of the competition's address: worldcubeassociation.org/competitions/<b>ID</b>.</div>
        </form>
        <div>
          <div className="text-[11px] font-semibold text-neutral-500 mb-1">From a file</div>
          <label className="flex items-center justify-center gap-1.5 px-3 py-1.5 border border-neutral-300 rounded-md cursor-pointer hover:bg-neutral-50">
            <FileUp size={14} /> Open WCIF file…
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) run(() => onOpenFile(file));
              }}
            />
          </label>
        </div>
        {loaded && (
          <button onClick={onManage} className="w-full text-left text-xs text-blue-600 hover:underline pt-2 border-t border-neutral-100">
            Role mapping, schedule and stage colors for {loaded.name || loaded.id} →
          </button>
        )}
      </div>
    </>
  );
}

function FieldBox({ field, scale, selected, showHandles, outsideMargin, sampleData, onPointerDownMove, onPointerDownResize }) {
  const w = fieldBoxWidthMm(field) * scale;
  const textWraps = field.type === "text" && field.wrap;
  const align = field.align || "left";

  // Schedule height is DERIVED from row count (fixed header/subheader/row
  // heights), not a free-form field.h_mm — this is what keeps two schedule
  // fields (e.g. one per day) visually aligned when placed side by side,
  // since a 5-row day and an 8-row day both use the exact same row height.
  let scheduleVisibleRows = null;
  let scheduleHeaderTitle = null;
  let scheduleHeightPx = null;
  if (field.type === "schedule") {
    const resolved = resolveScheduleRows(field, sampleData);
    scheduleVisibleRows = resolved.visibleRows;
    scheduleHeaderTitle = resolved.headerTitle;
    scheduleHeightPx = SCHEDULE_HEADER_HEIGHT_PX + SCHEDULE_SUBHEADER_HEIGHT_PX + scheduleVisibleRows.length * SCHEDULE_ROW_HEIGHT_PX + SCHEDULE_BOTTOM_PADDING_PX;
  }

  // Task Key height is likewise derived — tallest of the two columns
  // (task codes are always exactly 4; stages vary by competition).
  let taskKeyRows = null;
  let taskKeyHeightPx = null;
  if (field.type === "taskkey") {
    taskKeyRows = resolveTaskKeyRows(field, sampleData);
    const rowCount = Math.max(taskKeyRows.taskRows.length, taskKeyRows.stageRows.length);
    taskKeyHeightPx = TASKKEY_HEADER_HEIGHT_PX + rowCount * TASKKEY_ROW_HEIGHT_PX;
  }

  // Text: points -> preview px (1 pt = 25.4/72 mm, at `scale` px per mm),
  // measured with the same font the preview draws in, so a text frame
  // breaks lines exactly where textLayout.js will in the PDF.
  const ptPx = (scale * 25.4) / 72;
  const isTextFrame = field.type === "text" && field.textKind === "frame";
  let textFont = null;
  let textValue = null;
  let textColor = null;
  let measureText = null;
  let frameLayout = null;
  let fontMetrics = null;
  if (field.type === "text") {
    const isCustom = !BUILTIN_FONTS.includes(field.font);
    textFont = { family: isCustom ? `"${field.font}", sans-serif` : "Helvetica, Arial, sans-serif", weight: field.font === "Helvetica-Bold" ? 700 : 400 };
    textValue = applyTextCase(resolveTextValue(field, sampleData), field.textCase);
    textColor = resolveTextColor(field, sampleData);
    measureText = canvasTextMeasurer(textFont, field.letterSpacing || 0);
    if (isTextFrame) {
      fontMetrics = canvasFontMetrics(textFont);
      frameLayout = layoutTextFrame(textValue, field.frame, { measure: measureText, lineHeight: field.lineHeight || 1.05, breakStyle: field.breakStyle || "break-word", fixedSize: field.size || 12, capHeight: fontMetrics.capHeight });
    }
  }

  let h = field.type === "schedule" ? scheduleHeightPx : field.type === "taskkey" ? taskKeyHeightPx : fieldBoxHeightMm(field) * scale;
  if (isTextFrame && field.frame.auto_height) h = (frameLayout.blockHeight + 2 * frameLayout.padding) * ptPx;
  const pointBox = field.type === "text" && !isTextFrame && field.boxHeightMm > 0;

  const style = {
    position: "absolute",
    left: field.x_mm * scale,
    top: field.y_mm * scale,
    width: field.type === "text" && !isTextFrame ? (textWraps ? w : "auto") : w,
    height: field.type === "text" && !isTextFrame ? (pointBox ? field.boxHeightMm * scale : "auto") : h,
    outline: selected ? "1.5px solid #2563eb" : outsideMargin ? "1.5px dashed #f59e0b" : "1px dashed rgba(0,0,0,0.25)",
    cursor: "move",
    userSelect: "none",
    // Unwrapped point text is anchored at X by its alignment (left edge /
    // center / right edge), so the whole box shifts — not just the text —
    // and its outline (and box height) stays around the text. Translate is
    // listed last so it applies before the rotation, which keeps pivoting
    // on the X/Y anchor like the PDF does.
    transform: [field.rotate ? `rotate(-${field.rotate}deg)` : null, field.type === "text" && !isTextFrame && !textWraps ? anchorTransform(align) : null].filter(Boolean).join(" ") || undefined,
    transformOrigin: "top left",
  };

  let content;
  if (field.type === "text" && isTextFrame) {
    const { lines, size, lineHeight, baselines, padding, innerW, overflow } = frameLayout;
    // Each line box is placed so its baseline (where CSS puts it: half the
    // leading plus the font's ascent) lands on the layout's baseline.
    const baselineInLine = ((lineHeight - (fontMetrics.ascent + fontMetrics.descent) * size) / 2 + fontMetrics.ascent * size) * ptPx;
    content = (
      <>
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: padding * ptPx,
              top: (padding + baselines[i]) * ptPx - baselineInLine,
              width: innerW * ptPx,
              height: lineHeight * ptPx,
              fontSize: size * ptPx,
              lineHeight: `${lineHeight * ptPx}px`,
              fontWeight: textFont.weight,
              fontFamily: textFont.family,
              color: textColor,
              letterSpacing: `${(field.letterSpacing || 0) * ptPx}px`,
              whiteSpace: "pre",
              textAlign: align,
            }}
          >
            {line}
          </div>
        ))}
        {overflow && (
          // Like Affinity's overflow marker: the text doesn't fit the frame
          // even at its smallest size. Editor-only, never printed.
          <div title="Text doesn't fit this frame" style={{ position: "absolute", right: -5, bottom: -5, width: 10, height: 10, background: "#dc2626", border: "1.5px solid #fff", borderRadius: 2 }} />
        )}
      </>
    );
  } else if (field.type === "text") {
    const fontSize =
      field.fontMode === "autofit"
        ? shrinkToWidth(textValue, { min: field.size_min || 8, max: field.size_max || 16, maxWidth: (field.max_width_mm || 60) * MM_TO_PT, measure: measureText })
        : field.size;
    const text = (
      <div
        data-text-content
        style={{
          fontSize: fontSize * ptPx,
          fontWeight: textFont.weight,
          fontFamily: textFont.family,
          color: textColor,
          lineHeight: field.lineHeight || 1.05,
          letterSpacing: `${(field.letterSpacing || 0) * ptPx}px`,
          // Without wrap, only explicit line breaks break lines — as in the
          // PDF. ("pre-line" also wrapped long text at the page edge.)
          whiteSpace: textWraps ? "pre-wrap" : "pre",
          wordBreak: textWraps ? field.breakStyle || "break-word" : undefined,
          overflowWrap: textWraps ? "anywhere" : undefined,
          width: textWraps ? "100%" : undefined,
          textAlign: align,
          display: textWraps ? undefined : "inline-block",
        }}
      >
        {textValue}
      </div>
    );
    // In a box (see drawTextField in pdfExport.js): the text block at its
    // top, middle or bottom, by flex alignment of the block's own height.
    content = pointBox ? (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: { middle: "center", bottom: "flex-end" }[field.vAlign] || "flex-start" }}>
        {text}
      </div>
    ) : (
      text
    );
  } else if (field.type === "image") {
    let src = field.preview;
    let label = field.path?.split("/").pop() || "image";
    if (field.mapped) {
      const m = resolveMapping(field, sampleData, "image");
      src = m ? m.preview : field.fallbackPreview;
      label = m ? m.path?.split("/").pop() : field.fallbackPath?.split("/").pop() || "no match";
    }
    content = src ? <CroppedImage src={src} crop={field.crop} fit={field.fit || "contain"} boxW={w} boxH={h} /> : <div className="w-full h-full flex items-center justify-center bg-neutral-200/70 text-[9px] text-neutral-500 rounded text-center px-1">{label}</div>;
  } else if (field.type === "colorblock") {
    const color = resolveMapping(field, sampleData, "color");
    const label = field.labelSource ? sampleData[field.labelSource] : null;
    content = (
      <div className="w-full h-full flex items-center px-2" style={{ background: hexToRgba(color, field.opacity ?? 100), color: field.labelColor || "#fff", fontSize: 11, fontWeight: 700 }}>
        {label ? String(label).toUpperCase() : ""}
      </div>
    );
  } else if (field.type === "qr") {
    let target = field.target || "";
    try {
      target = target.replace(/\{(\w+)\}/g, (_, k) => sampleData[k] ?? `{${k}}`);
    } catch (e) {}
    content = (
      <div className="w-full h-full border border-neutral-400 bg-white flex flex-col items-center justify-center gap-0.5 p-1">
        <QrCode size={Math.min(w, h) * 0.55} strokeWidth={1.2} />
        <div className="text-[6px] text-neutral-400 truncate w-full text-center">{target}</div>
      </div>
    );
  } else if (field.type === "schedule") {
    const headerTitle = scheduleHeaderTitle;
    const visibleRows = scheduleVisibleRows;
    content = (
      <div
        className="w-full h-full bg-white flex flex-col overflow-hidden select-none leading-none"
        style={{ fontFamily: SCHEDULE_FONT_FAMILY, color: "#000000", border: `1px solid ${SCHEDULE_COLORS.border}`, boxSizing: "border-box" }}
      >
        {/* Day title bar */}
        <div
          className="text-center font-bold tracking-wide shrink-0 flex items-center justify-center"
          style={{ height: SCHEDULE_HEADER_HEIGHT_PX, boxSizing: "border-box", background: SCHEDULE_COLORS.headerBg, color: SCHEDULE_COLORS.headerText, fontSize: SCHEDULE_FONT_SIZE_PX, borderBottom: `1px solid ${SCHEDULE_COLORS.border}` }}
        >
          {headerTitle}
        </div>

        {/* Table Content Container */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ fontSize: SCHEDULE_FONT_SIZE_PX }}>
          {/* Column Subheaders */}
          <div
            className="flex font-semibold shrink-0 text-center items-center"
            style={{ height: SCHEDULE_SUBHEADER_HEIGHT_PX, boxSizing: "border-box", background: SCHEDULE_COLORS.subheaderBg, borderBottom: `1px solid ${SCHEDULE_COLORS.border}` }}
          >
            <span className="w-10 h-full flex items-center justify-center shrink-0" style={{ borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>{field.columnLabels?.time || "Time"}</span>
            <span className="flex-1 h-full flex items-center justify-center" style={{ borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>{field.columnLabels?.event || "Event"}</span>
            <span className="w-9 h-full flex items-center justify-center shrink-0">{field.columnLabels?.task || "Task"}</span>
          </div>

          {/* Rows — grouped into "blocks": a normal row stays a single row,
              but consecutive round-2+ rows merge into one taller cell on
              the Task column (time/event stay separate per row), with a
              single larger "QR" label spanning the merge. Pinned to fixed
              row heights throughout, with a small gap after the last block
              baked into the box's total height. */}
          <div className="flex flex-col overflow-hidden" style={{ paddingBottom: SCHEDULE_BOTTOM_PADDING_PX }}>
            {(() => {
              // Build blocks: consecutive non-special rows flagged isSubsequentRound merge together.
              const blocks = [];
              let idx = 0;
              while (idx < visibleRows.length) {
                const r = visibleRows[idx];
                const isQR = !r.isSpecial && r.isSubsequentRound;
                if (isQR) {
                  let j = idx;
                  while (j < visibleRows.length && !visibleRows[j].isSpecial && visibleRows[j].isSubsequentRound) j++;
                  blocks.push({ type: "qr-group", rows: visibleRows.slice(idx, j) });
                  idx = j;
                } else {
                  blocks.push({ type: "single", row: r });
                  idx++;
                }
              }

              return blocks.map((block, bi) => {
                const borderTop = bi > 0 ? `1px solid ${SCHEDULE_COLORS.border}` : undefined;

                if (block.type === "qr-group") {
                  const rows = block.rows;
                  const groupHeight = rows.length * SCHEDULE_ROW_HEIGHT_PX;
                  return (
                    <div key={bi} className="flex items-stretch bg-white shrink-0" style={{ height: groupHeight, boxSizing: "border-box", borderTop }}>
                      {/* Left: stacked Time+Event pairs, one per merged row */}
                      <div className="flex-1 flex flex-col">
                        {rows.map((r, k) => (
                          <div
                            key={k}
                            className="flex items-stretch"
                            style={{ height: SCHEDULE_ROW_HEIGHT_PX, boxSizing: "border-box", borderTop: k > 0 ? `1px solid ${SCHEDULE_COLORS.border}` : undefined }}
                          >
                            <div className="w-10 flex items-center justify-center font-medium shrink-0 px-0.5" style={{ background: SCHEDULE_COLORS.timeCellBg, borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>
                              {r.time}
                            </div>
                            <div className="flex-1 flex items-center justify-center font-bold truncate px-1" style={{ borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>
                              {r.event}
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* Right: one merged Task cell reading "QR" — always
                          plain white background, never tinted by the
                          row's stage color (that tint is for the task
                          code cells like "C"/"J"/"R"/"S", not a QR slot). */}
                      <div
                        className="w-9 flex items-center justify-center font-bold shrink-0 px-0.5 bg-white"
                        style={{ fontSize: SCHEDULE_QR_FONT_SIZE_PX }}
                      >
                        QR
                      </div>
                    </div>
                  );
                }

                const r = block.row;
                const isSpecial = isSpecialScheduleRow(r);
                const specialBg = /lunch|dinner/i.test(r.activityCode || r.event) ? SCHEDULE_COLORS.lunchBg : SCHEDULE_COLORS.otherSpecialBg;

                return (
                  <div
                    key={bi}
                    className="flex items-stretch bg-white shrink-0"
                    style={{
                      height: SCHEDULE_ROW_HEIGHT_PX,
                      boxSizing: "border-box",
                      borderTop,
                      backgroundColor: r.color ? hexToRgba(r.color, SCHEDULE_COLORS.rowTint) : undefined,
                    }}
                  >
                    {/* Time Cell */}
                    <div className="w-10 flex items-center justify-center font-medium shrink-0 px-0.5" style={{ background: SCHEDULE_COLORS.timeCellBg, borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>
                      {r.time}
                    </div>

                    {isSpecial ? (
                      /* Combined Span for Lunch, Opening, Awards, etc. */
                      <div className="flex-1 flex items-center justify-center font-bold uppercase tracking-wider" style={{ backgroundColor: r.specialColor || specialBg }}>
                        {r.event}
                      </div>
                    ) : (
                      <>
                        {/* Event Cell */}
                        <div className="flex-1 flex items-center justify-center font-bold truncate px-1" style={{ borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>
                          {r.event}
                        </div>

                        {/* Task Cell */}
                        <div className="w-9 flex items-center justify-center font-bold shrink-0 px-0.5" style={{ backgroundColor: r.color ? hexToRgba(r.color, SCHEDULE_COLORS.taskCellTint) : undefined }}>
                          {r.task || `<e${bi}>`}
                        </div>
                      </>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>
    );
  } else if (field.type === "taskkey") {
    const { taskRows, stageRows } = taskKeyRows;
    const rowCount = Math.max(taskRows.length, stageRows.length);
    content = (
      <div
        className="w-full h-full bg-white flex overflow-hidden select-none leading-none"
        style={{ fontFamily: SCHEDULE_FONT_FAMILY, color: "#000000", border: `1px solid ${SCHEDULE_COLORS.border}`, boxSizing: "border-box" }}
      >
        {/* Column 1: task code key */}
        <div className="flex-1 flex flex-col" style={{ borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>
          <div
            className="flex items-center justify-center font-semibold shrink-0"
            style={{ height: TASKKEY_HEADER_HEIGHT_PX, boxSizing: "border-box", background: SCHEDULE_COLORS.subheaderBg, borderBottom: `1px solid ${SCHEDULE_COLORS.border}`, fontSize: SCHEDULE_FONT_SIZE_PX }}
          >
            Task
          </div>
          {Array.from({ length: rowCount }).map((_, i) => {
            const t = taskRows[i];
            return (
              <div
                key={i}
                className="flex items-center px-1.5 shrink-0"
                style={{ height: TASKKEY_ROW_HEIGHT_PX, boxSizing: "border-box", borderTop: i > 0 ? `1px solid ${SCHEDULE_COLORS.border}` : undefined, fontSize: SCHEDULE_FONT_SIZE_PX }}
              >
                {t ? (
                  <>
                    <span className="font-bold">{t.code}</span>
                    <span className="mx-1">=</span>
                    <span>{t.label}</span>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Column 2: stage color key */}
        <div className="flex-1 flex flex-col">
          <div
            className="flex items-center justify-center font-semibold shrink-0"
            style={{ height: TASKKEY_HEADER_HEIGHT_PX, boxSizing: "border-box", background: SCHEDULE_COLORS.subheaderBg, borderBottom: `1px solid ${SCHEDULE_COLORS.border}`, fontSize: SCHEDULE_FONT_SIZE_PX }}
          >
            Stage
          </div>
          {Array.from({ length: rowCount }).map((_, i) => {
            const s = stageRows[i];
            return (
              <div
                key={i}
                className="flex items-center px-1.5 shrink-0 font-bold"
                style={{
                  height: TASKKEY_ROW_HEIGHT_PX,
                  boxSizing: "border-box",
                  borderTop: i > 0 ? `1px solid ${SCHEDULE_COLORS.border}` : undefined,
                  fontSize: SCHEDULE_FONT_SIZE_PX,
                  background: s ? s.color : undefined,
                  color: "#000000",
                }}
              >
                {s ? s.name : ""}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={style} data-field-id={field.id} data-field-type={isTextFrame ? "textframe" : field.type} onPointerDown={onPointerDownMove}>
      {content}
      {showHandles && (field.type !== "text" || textWraps || isTextFrame) && (
        <div
          onPointerDown={onPointerDownResize}
          style={{ position: "absolute", right: -4, bottom: -4, width: 10, height: 10, background: "#2563eb", borderRadius: 2, cursor: field.type === "schedule" || field.type === "taskkey" || (isTextFrame && field.frame.auto_height) ? "ew-resize" : "nwse-resize" }}
        />
      )}
    </div>
  );
}

function AlignField({ value, onChange }) {
  const opts = [
    { v: "left", I: AlignLeft },
    { v: "center", I: AlignCenter },
    { v: "right", I: AlignRight },
  ];
  return (
    <div>
      <div className="text-[11px] text-neutral-500 mb-1">Alignment</div>
      <div className="flex gap-1">
        {opts.map(({ v, I }) => (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`flex-1 flex items-center justify-center py-1.5 border rounded-md ${(value || "left") === v ? "border-blue-400 bg-blue-50 text-blue-700" : "border-neutral-300 hover:bg-neutral-50 text-neutral-600"}`}
          >
            <I size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

// Shared by every "value -> image" mapping UI (the mapped image field,
// background-images-by-value): reads a batch of files at once and derives
// each mapping's `value` straight from the filename (extension stripped),
// so a folder of e.g. "PT.png", "US.png", "BR.png" becomes one mapping per
// country with zero manual typing — built for the country-flag-per-field
// use case, but works for any file-per-value folder.
function readImageFilesAsMappingEntries(fileList) {
  const files = Array.from(fileList || []);
  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const value = file.name.replace(/\.[^./]+$/, ""); // "PT.png" -> "PT"
            resolve({ value, path: `assets/${file.name}`, preview: reader.result });
          };
          reader.readAsDataURL(file);
        })
    )
  );
}

// Merges freshly-read entries into the existing mapping list by `value` —
// an entry whose value already exists gets its image replaced in place
// rather than appended as a duplicate, so re-running a bulk upload (e.g.
// after fixing one flag file) is safe to repeat.
function upsertMappingsByValue(existing, newEntries) {
  const byValue = new Map(existing.map((m) => [m.value, m]));
  for (const entry of newEntries) byValue.set(entry.value, { ...byValue.get(entry.value), ...entry });
  return Array.from(byValue.values());
}

function MappingEditor({ mapSource, mappings, kind, sampleKeys, onSourceChange, onAdd, onUpdate, onRemove, onBulkFiles }) {
  return (
    <div>
      <SelectField label={`${kind === "color" ? "Color" : "Image"} driven by`} value={mapSource} onChange={onSourceChange} options={sampleKeys} />
      <div className="text-[11px] text-neutral-500 mt-2 mb-1">Mappings</div>
      <div className="space-y-1.5">
        {mappings.map((m, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input value={m.value} onChange={(e) => onUpdate(i, { value: e.target.value })} placeholder="value" className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0" />
            {kind === "color" ? (
              <input type="color" value={m.color} onChange={(e) => onUpdate(i, { color: e.target.value })} className="w-7 h-7 border border-neutral-300 rounded cursor-pointer" />
            ) : (
              <MiniImageUpload value={m} onUpdate={(patch) => onUpdate(i, patch)} />
            )}
            <button onClick={() => onRemove(i)} className="text-neutral-400 hover:text-red-500">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-1.5">
        <button onClick={onAdd} className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
          <Plus size={11} /> Add mapping
        </button>
        {kind === "image" && onBulkFiles && (
          <label className="flex items-center gap-1 text-xs text-blue-600 hover:underline cursor-pointer">
            <Upload size={11} /> Bulk upload by filename
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) onBulkFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}

function MiniImageUpload({ value, onUpdate }) {
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onUpdate({ preview: reader.result, path: value.path || `assets/${file.name}` });
    reader.readAsDataURL(file);
  };
  return (
    <label className="flex items-center justify-center w-7 h-7 border border-neutral-300 rounded cursor-pointer hover:bg-neutral-50 overflow-hidden shrink-0">
      {value.preview ? <img src={value.preview} alt="" className="w-full h-full object-cover" /> : <Upload size={12} className="text-neutral-400" />}
      <input type="file" accept="image/*" className="hidden" onChange={onFile} />
    </label>
  );
}

function TintPanel({ tint, sampleData, onChange }) {
  const updateEntry = (i, patch) => onChange({ mappings: tint.mappings.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  return (
    <div className="p-4 space-y-3 border-t border-neutral-200 overflow-y-auto">
      <div className="text-xs font-semibold text-neutral-500 flex items-center gap-1.5">
        <Droplet size={12} /> BACKGROUND TINT
      </div>
      <label className="flex items-center gap-1.5 text-xs text-neutral-600">
        <input type="checkbox" checked={tint.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        Enabled
      </label>
      <MappingEditor
        mapSource={tint.mapSource}
        mappings={tint.mappings}
        kind="color"
        sampleKeys={Object.keys(sampleData)}
        onSourceChange={(v) => onChange({ mapSource: v })}
        onAdd={() => onChange({ mappings: [...tint.mappings, { value: "new_value", color: "#888888" }] })}
        onUpdate={updateEntry}
        onRemove={(i) => onChange({ mappings: tint.mappings.filter((_, idx) => idx !== i) })}
      />
      <ColorField label="Fallback color" value={tint.fallbackColor} onChange={(v) => onChange({ fallbackColor: v })} />
    </div>
  );
}

function BackgroundMapPanel({ bgMap, sampleData, onChange }) {
  const updateEntry = (i, patch) => onChange({ mappings: bgMap.mappings.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  const onFallbackFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange({ fallbackPreview: reader.result, fallbackPath: bgMap.fallbackPath || `assets/${file.name}` });
    reader.readAsDataURL(file);
  };
  return (
    <div className="p-4 space-y-3 border-t border-neutral-200 overflow-y-auto">
      <div className="text-xs font-semibold text-neutral-500 flex items-center gap-1.5">
        <ImageIcon size={12} /> BACKGROUND IMAGES BY VALUE
      </div>
      <label className="flex items-center gap-1.5 text-xs text-neutral-600">
        <input type="checkbox" checked={bgMap.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        Enabled — replaces the single background + tint entirely
      </label>
      <MappingEditor
        mapSource={bgMap.mapSource}
        mappings={bgMap.mappings}
        kind="image"
        sampleKeys={Object.keys(sampleData)}
        onSourceChange={(v) => onChange({ mapSource: v })}
        onAdd={() => onChange({ mappings: [...bgMap.mappings, { value: "new_value", path: "", preview: null }] })}
        onUpdate={updateEntry}
        onRemove={(i) => onChange({ mappings: bgMap.mappings.filter((_, idx) => idx !== i) })}
        onBulkFiles={(fileList) => readImageFilesAsMappingEntries(fileList).then((entries) => onChange({ mappings: upsertMappingsByValue(bgMap.mappings, entries) }))}
      />
      <div>
        <div className="text-[11px] text-neutral-500 mb-1">Fallback background (unmatched values)</div>
        <div className="flex items-center gap-2">
          <label className="flex items-center justify-center w-10 h-10 border border-neutral-300 rounded cursor-pointer hover:bg-neutral-50 overflow-hidden shrink-0">
            {bgMap.fallbackPreview ? <img src={bgMap.fallbackPreview} alt="" className="w-full h-full object-cover" /> : <Upload size={14} className="text-neutral-400" />}
            <input type="file" accept="image/*" className="hidden" onChange={onFallbackFile} />
          </label>
          <input
            type="text"
            value={bgMap.fallbackPath}
            onChange={(e) => onChange({ fallbackPath: e.target.value })}
            className="flex-1 text-xs px-2 py-1.5 border border-neutral-300 rounded-md min-w-0"
          />
        </div>
      </div>
    </div>
  );
}

function RoleMappingPanel({ roleMapping, onChange, persons }) {
  const rules = roleMapping.rules || [];
  // With a WCIF loaded: how many people each rule catches (first match wins).
  const tally = persons ? countByRule(roleMapping, persons) : null;
  const people = (n) => `${n} ${n === 1 ? "person" : "people"}`;

  const updateRule = (i, patch) => onChange({ rules: rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  const addRule = () => onChange({ rules: [...rules, { wcaRole: "", label: "" }] });
  const removeRule = (i) => onChange({ rules: rules.filter((_, idx) => idx !== i) });
  const moveRule = (i, dir) => {
    const newIdx = i + dir;
    if (newIdx < 0 || newIdx >= rules.length) return;
    const next = [...rules];
    [next[i], next[newIdx]] = [next[newIdx], next[i]];
    onChange({ rules: next });
  };

  return (
    <div className="p-4 space-y-3 border-t border-neutral-200 overflow-y-auto">
      <div className="text-xs font-semibold text-neutral-500 flex items-center gap-1.5">
        <Users size={12} /> ROLE MAPPING
      </div>
      <div className="text-[11px] text-neutral-400">
        Maps a competitor's WCIF role(s) to the "role" value used throughout the template (text, tint, background images, etc). Checked top to bottom — the first matching rule wins, since a person can hold more than one role at once (e.g. an organizer who's also judging). Anyone matching nothing below gets the fallback. Join roles with "+" (e.g. delegate+organizer) for people who have all of them — keep those above the single roles. Loading a WCIF adds every role and combination it contains.
      </div>

      <div className="space-y-1.5">
        {rules.map((rule, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="flex flex-col shrink-0">
              <button onClick={() => moveRule(i, -1)} disabled={i === 0} className="text-neutral-400 hover:text-neutral-700 disabled:opacity-20 disabled:hover:text-neutral-400 leading-none" title="Higher priority">
                <ChevronUp size={13} />
              </button>
              <button onClick={() => moveRule(i, 1)} disabled={i === rules.length - 1} className="text-neutral-400 hover:text-neutral-700 disabled:opacity-20 disabled:hover:text-neutral-400 leading-none" title="Lower priority">
                <ChevronDown size={13} />
              </button>
            </div>
            <input
              value={rule.wcaRole}
              onChange={(e) => updateRule(i, { wcaRole: e.target.value })}
              placeholder="WCIF role, e.g. staff-judge"
              className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0 font-mono"
            />
            <span className="text-neutral-300 text-xs">→</span>
            <input
              value={rule.label}
              onChange={(e) => updateRule(i, { label: e.target.value })}
              placeholder="role value, e.g. judge"
              className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0"
            />
            {tally && (
              <span className={`text-[10px] w-6 text-right shrink-0 ${tally.counts[i] ? "text-neutral-500" : "text-neutral-300"}`} title={people(tally.counts[i])}>
                {tally.counts[i]}
              </span>
            )}
            <button onClick={() => removeRule(i)} className="text-neutral-400 hover:text-red-500 shrink-0">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {rules.length === 0 && <div className="text-xs text-neutral-400">No rules yet — everyone gets the fallback below.</div>}
      </div>
      <button onClick={addRule} className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
        <Plus size={11} /> Add rule
      </button>

      <div>
        <div className="text-[11px] text-neutral-500 mb-1">Fallback (no rule matched){tally ? ` — ${people(tally.fallback)}` : ""}</div>
        <input
          value={roleMapping.fallback || ""}
          onChange={(e) => onChange({ fallback: e.target.value })}
          placeholder="competitor"
          className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md"
        />
      </div>

      <div className="text-[10px] text-neutral-400">
        WCA role strings per the WCIF spec include: delegate, trainee-delegate, organizer, staff-judge, staff-scrambler, staff-runner, staff-dataentry, staff-announcer.
      </div>
    </div>
  );
}

// Global schedule settings: renames for the texts the WCIF produces, and the
// MBLD cube submission task. Per-table settings (day, title, column
// headers, hidden activities) stay on each schedule field.
function SchedulePanel({ texts, labels, onLabelChange, mbldSubmission, onMbldChange, mergedRounds, onMergedRoundsChange }) {
  const merged = new Set(mergedRounds);
  const toggleRound = (code) => {
    const next = new Set(merged);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onMergedRoundsChange([...next]);
  };
  // Only rounds actually split into groups are worth offering.
  const mergeable = (texts?.laterRounds || []).filter((r) => r.groups > 1);

  const renameRow = (kind, key, defaultText) => (
    <div key={key} className="flex items-center gap-1.5">
      <span className="w-28 text-[11px] text-neutral-500 truncate shrink-0" title={kind === "activities" ? key : defaultText}>
        {defaultText}
      </span>
      <span className="text-neutral-300 text-xs">→</span>
      <input
        type="text"
        value={labels[kind]?.[key] || ""}
        placeholder={defaultText}
        onChange={(e) => onLabelChange(kind, key, e.target.value)}
        className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0"
      />
    </div>
  );

  return (
    <div className="p-4 space-y-4 border-t border-neutral-200 overflow-y-auto">
      <div className="text-xs font-semibold text-neutral-500 flex items-center gap-1.5">
        <Rows3 size={12} /> SCHEDULE
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold text-neutral-600">One row per round</div>
          {mergeable.length > 0 && (
            <div className="flex gap-2 text-[11px]">
              <button onClick={() => onMergedRoundsChange(mergeable.map((r) => r.code))} className="text-blue-600 hover:underline">All</button>
              <button onClick={() => onMergedRoundsChange([])} className="text-blue-600 hover:underline">None</button>
            </div>
          )}
        </div>
        <div className="text-[10px] text-neutral-400">
          Tick a round to show all its groups as a single row, starting at its first group (e.g. 8 rows of "3x3x3 Final" become one). Only later rounds are listed — in round 1 each person has a different task in each group.
        </div>
        {mergeable.map((r) => (
          <label key={r.code} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={merged.has(r.code)} onChange={() => toggleRound(r.code)} />
            <span className="flex-1">{r.label}</span>
            <span className="text-[10px] text-neutral-400">{r.groups} groups</span>
          </label>
        ))}
        {texts && mergeable.length === 0 && <div className="text-xs text-neutral-400">No later round in this competition has more than one group.</div>}
        {!texts && <div className="text-xs text-neutral-400">Load a WCIF to choose rounds.</div>}
      </div>

      <div className="space-y-2 border-t border-neutral-200 pt-3">
        <div className="text-[11px] font-semibold text-neutral-600">MBLD cube submission</div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!mbldSubmission.enabled} onChange={(e) => onMbldChange({ enabled: e.target.checked })} />
          Show it as a task
        </label>
        {mbldSubmission.enabled && (
          <>
            <label className="flex items-center gap-2 text-xs">
              <span className="text-neutral-500">Task for MBLD competitors</span>
              <input
                type="text"
                value={mbldSubmission.task || ""}
                placeholder="C"
                maxLength={3}
                onChange={(e) => onMbldChange({ task: e.target.value })}
                className="w-14 text-xs px-2 py-1 border border-neutral-300 rounded-md text-center font-bold"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!mbldSubmission.hideForOthers} onChange={(e) => onMbldChange({ hideForOthers: e.target.checked })} />
              Hide it from everyone else
            </label>
          </>
        )}
        <div className="text-[10px] text-neutral-400">
          People assigned to the submission itself (e.g. staff collecting cubes) get their usual task letter. Competitors get the task above for each attempt they're assigned to compete in — or, before groups exist, if they're registered for MBLD.
        </div>
      </div>

      {texts ? (
        <>
          <div className="space-y-1.5 border-t border-neutral-200 pt-3">
            <div className="text-[11px] font-semibold text-neutral-600">Event names</div>
            <div className="text-[10px] text-neutral-400">Replaces the event part of every row, e.g. "3x3 OH R1 - G2" → "OH R1 - G2". Leave blank to keep the default.</div>
            {texts.events.map((ev) => renameRow("events", ev.id, ev.defaultText))}
          </div>
          <div className="space-y-1.5 border-t border-neutral-200 pt-3">
            <div className="text-[11px] font-semibold text-neutral-600">Other activities</div>
            <div className="text-[10px] text-neutral-400">Breaks and other non-event rows, as named in the WCIF.</div>
            {texts.activities.map((a) => renameRow("activities", a.name, a.defaultText))}
          </div>
        </>
      ) : (
        <div className="text-xs text-neutral-400 border-t border-neutral-200 pt-3">Load a WCIF to rename its events and activities.</div>
      )}
    </div>
  );
}

// <input type="color"> only accepts #rrggbb, but WCIF allows #rgb too.
const toSixDigitHex = (hex) => (/^#[0-9a-f]{3}$/i.test(hex || "") ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex);

function StageColorsPanel({ stages, stageColors, onChange }) {
  return (
    <div className="p-4 space-y-3 border-t border-neutral-200 overflow-y-auto">
      <div className="text-xs font-semibold text-neutral-500 flex items-center gap-1.5">
        <SwatchBook size={12} /> STAGE COLORS
      </div>
      <div className="text-[11px] text-neutral-400">
        Colors come from the WCA website by default. Pick a different one for any stage (e.g. a pastel tone that prints better) — it's used in the schedule rows and the task key of every badge, and saved with the template.
      </div>

      <div className="space-y-1.5">
        {stages.map((s) => {
          const wcaColor = s.wcaColor || s.color;
          const overridden = !!stageColors[s.name];
          return (
            <div key={s.name} className="flex items-center gap-2">
              <input type="color" value={toSixDigitHex(s.color)} onChange={(e) => onChange(s.name, e.target.value)} className="w-8 h-7 border border-neutral-300 rounded cursor-pointer shrink-0" />
              <span className="flex-1 text-sm truncate">{s.name}</span>
              {overridden && (
                <button onClick={() => onChange(s.name, null)} className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-800 shrink-0" title={`Back to the WCA color (${wcaColor})`}>
                  <span className="w-3 h-3 rounded-sm border border-neutral-300" style={{ background: wcaColor }} />
                  Reset
                </button>
              )}
            </div>
          );
        })}
        {stages.length === 0 && <div className="text-xs text-neutral-400">Load a WCIF first — its stages (or rooms) are listed here.</div>}
      </div>
    </div>
  );
}

function FontsPanel({ fonts, onUpload, onRename, onRemove, onAddGooglePreset, addingGoogleFont }) {
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (file) onUpload(file);
    e.target.value = "";
  };
  const addedPresetLabels = new Set(fonts.map((f) => f.displayName));
  return (
    <div className="p-4 space-y-3 border-t border-neutral-200 overflow-y-auto">
      <div className="text-xs font-semibold text-neutral-500 flex items-center gap-1.5">
        <Type size={12} /> CUSTOM FONTS
      </div>
      <div className="text-[11px] text-neutral-400">Upload .ttf, .otf or .woff files. Each becomes selectable in any text field's font picker.</div>
      <label className="flex items-center justify-center gap-1.5 text-sm px-3 py-2 border border-dashed border-neutral-300 rounded-md cursor-pointer hover:bg-neutral-50 text-neutral-600">
        <Upload size={14} />
        Upload font file
        <input type="file" accept=".ttf,.otf,.woff,.woff2" className="hidden" onChange={onFile} />
      </label>

      {onAddGooglePreset && (
        <div>
          <div className="text-[11px] text-neutral-400 mb-1.5">Or add straight from Google Fonts — no download/upload needed:</div>
          <div className="flex flex-wrap gap-1.5">
            {GOOGLE_FONT_PRESETS.map((preset) => {
              const added = addedPresetLabels.has(preset.label);
              const loading = addingGoogleFont === preset.label;
              return (
                <button
                  key={preset.label}
                  onClick={() => onAddGooglePreset(preset)}
                  disabled={added || loading || !!addingGoogleFont}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-neutral-300 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span style={{ fontWeight: preset.weight === "700" ? 700 : 400 }}>{preset.label}</span>
                  {added ? <span className="text-neutral-400">— added</span> : loading ? <span className="text-neutral-400">— fetching…</span> : <Plus size={11} className="text-blue-600" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {fonts.map((f) => (
          <div key={f.id} className="border border-neutral-200 rounded-md p-2">
            <div className="flex items-center gap-1.5">
              <input value={f.displayName} onChange={(e) => onRename(f.id, e.target.value)} className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0" />
              <button onClick={() => onRemove(f.id)} className="text-neutral-400 hover:text-red-500">
                <Trash2 size={13} />
              </button>
            </div>
            {f.needsReupload ? (
              <div className="text-[10px] text-amber-600 mt-1.5">Imported — re-upload this file to render it here again.</div>
            ) : (
              <div style={{ fontFamily: `"${f.family}", sans-serif` }} className="text-lg mt-1.5 truncate">
                The quick brown fox
              </div>
            )}
            <div className="text-[10px] text-neutral-400 mt-0.5 truncate">{f.filename}</div>
          </div>
        ))}
        {fonts.length === 0 && <div className="text-xs text-neutral-400">No custom fonts uploaded yet.</div>}
      </div>
    </div>
  );
}

function PropertiesPanel({ field, sampleData, fontOptions, fontLabel, pageWidth, pageHeight, onChange, scheduleTimezone, detectedScheduleTimezone, onScheduleTimezoneChange, onSyncCountryFlags, hasWcif }) {
  const round1 = (v) => Math.round(v * 10) / 10;
  const fieldHeightMm = () => {
    if (field.type === "schedule") {
      const rows = resolveScheduleRows(field, sampleData).visibleRows.length;
      return (SCHEDULE_HEADER_HEIGHT_PX + SCHEDULE_SUBHEADER_HEIGHT_PX + rows * SCHEDULE_ROW_HEIGHT_PX + SCHEDULE_BOTTOM_PADDING_PX) / SCALE;
    }
    if (field.type === "taskkey") {
      const { taskRows, stageRows } = resolveTaskKeyRows(field, sampleData);
      const rowCount = Math.max(taskRows.length, stageRows.length);
      return (TASKKEY_HEADER_HEIGHT_PX + rowCount * TASKKEY_ROW_HEIGHT_PX) / SCALE;
    }
    return fieldBoxHeightMm(field);
  };
  const centerX = () => {
    if (field.type === "text" && !field.wrap) {
      onChange({ align: "center", x_mm: round1(pageWidth / 2) });
    } else {
      onChange({ x_mm: round1((pageWidth - fieldBoxWidthMm(field)) / 2) });
    }
  };
  const centerY = () => onChange({ y_mm: round1((pageHeight - fieldHeightMm()) / 2) });

  const updateMapping = (i, patch) => onChange({ mappings: field.mappings.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  const addMapping = () => onChange({ mappings: [...field.mappings, field.type === "image" ? { value: "new_value", path: "", preview: null } : { value: "new_value", color: "#888888" }] });
  const removeMapping = (i) => onChange({ mappings: field.mappings.filter((_, idx) => idx !== i) });

  const updateValueMap = (i, patch) => onChange({ valueMap: field.valueMap.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  const addValueMap = () => onChange({ valueMap: [...(field.valueMap || []), { value: "new_value", label: "Display text" }] });
  const removeValueMap = (i) => onChange({ valueMap: field.valueMap.filter((_, idx) => idx !== i) });

  return (
    <div className="p-4 space-y-3 border-t border-neutral-200 overflow-y-auto">
      <div className="text-xs font-semibold text-neutral-500">PROPERTIES</div>

      <div className="grid grid-cols-2 gap-2">
        <NumField label="X (mm)" value={field.x_mm} onChange={(v) => onChange({ x_mm: v })} />
        <NumField label="Y (mm)" value={field.y_mm} onChange={(v) => onChange({ y_mm: v })} />
      </div>
      <div className="flex gap-2">
        <button onClick={centerX} className="flex-1 text-xs px-2 py-1.5 border border-neutral-300 rounded-md hover:bg-neutral-50 text-neutral-600">
          Center horizontally
        </button>
        <button onClick={centerY} className="flex-1 text-xs px-2 py-1.5 border border-neutral-300 rounded-md hover:bg-neutral-50 text-neutral-600">
          Center vertically
        </button>
      </div>

      {field.type !== "text" && field.type !== "schedule" && field.type !== "taskkey" && field.type !== "qr" && (
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Width (mm)" value={field.w_mm} onChange={(v) => onChange({ w_mm: v })} />
          <NumField label="Height (mm)" value={field.h_mm} onChange={(v) => onChange({ h_mm: v })} />
        </div>
      )}

      {field.type === "qr" && (
        <NumField label="Size (mm)" value={field.size_mm} onChange={(v) => onChange({ size_mm: v })} />
      )}

      {(field.type === "schedule" || field.type === "taskkey") && (
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Width (mm)" value={field.w_mm} onChange={(v) => onChange({ w_mm: v })} />
          <div>
            <div className="text-[11px] text-neutral-500 mb-1">Height (mm)</div>
            <div className="text-sm px-2 py-1.5 border border-neutral-200 rounded-md bg-neutral-50 text-neutral-500">
              {round1(fieldHeightMm())} (auto)
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="text-[11px] text-neutral-500 mb-1 flex items-center gap-1">
          <RotateCw size={11} /> Rotation (°)
        </div>
        <input type="number" value={field.rotate || 0} onChange={(e) => onChange({ rotate: Number(e.target.value) })} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md" />
      </div>

      {field.type === "text" && (
        <>
          <div className="flex flex-col gap-1.5 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={!field.bindMode || field.bindMode === "field"} onChange={() => onChange({ bindMode: "field" })} />
              Bound to one data field
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={field.bindMode === "template"} onChange={() => onChange({ bindMode: "template" })} />
              Template (combine fields + text)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={field.bindMode === "static"} onChange={() => onChange({ bindMode: "static" })} />
              Same on every badge
            </label>
          </div>

          {field.bindMode === "static" && (
            <div>
              <div className="text-[11px] text-neutral-500 mb-1">Text (Enter for a line break)</div>
              <textarea value={field.staticText || ""} onChange={(e) => onChange({ staticText: e.target.value })} rows={2} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md resize-y" placeholder="e.g. WCA Euro 2026 · Arnhem" />
            </div>
          )}

          {field.bindMode === "template" && (
            <div>
              <div className="text-[11px] text-neutral-500 mb-1">Template (use {"{field}"} placeholders, or {"{field|fallback}"} to show fallback text when a value is missing/empty. Enter for a line break)</div>
              <textarea value={field.template || ""} onChange={(e) => onChange({ template: e.target.value })} rows={2} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md resize-y font-mono" placeholder="e.g. {wcaId|NEWCOMER} - ID {registrantId}" />
              <div className="text-[10px] text-neutral-400 mt-1">Available: {Object.keys(sampleData).map((k) => `{${k}}`).join("  ")}</div>
            </div>
          )}

          {(!field.bindMode || field.bindMode === "field") && (
            <>
              <SelectField label="Bound to" value={field.source} onChange={(v) => onChange({ source: v })} options={Object.keys(sampleData)} />
              <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                <input type="checkbox" checked={field.useValueMap} onChange={(e) => onChange({ useValueMap: e.target.checked })} />
                Map displayed value
              </label>
              {field.useValueMap && (
                <div>
                  <label className="flex items-center gap-1.5 text-xs text-neutral-600 mb-1.5">
                    <input type="checkbox" checked={!!field.genderVariants} onChange={(e) => onChange({ genderVariants: e.target.checked })} />
                    Different text by gender
                  </label>
                  <div className="text-[11px] text-neutral-500 mb-1">
                    Raw value → displayed text (unmapped values show as-is). Enter for a line break in the display text.
                    {field.genderVariants && " F / M: text for women / men (WCIF gender); left empty, or for gender \"o\", the main text is used."}
                  </div>
                  <div className="space-y-1.5">
                    {(field.valueMap || []).map((m, i) => (
                      <div key={i} className={field.genderVariants ? "space-y-1 pb-1.5 border-b border-neutral-100" : ""}>
                        <div className="flex items-start gap-1.5">
                          <input value={m.value} onChange={(e) => updateValueMap(i, { value: e.target.value })} placeholder="raw value" className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0" />
                          <textarea value={m.label} onChange={(e) => updateValueMap(i, { label: e.target.value })} placeholder="display text" rows={1} className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0 resize-y" />
                          <button onClick={() => removeValueMap(i)} className="text-neutral-400 hover:text-red-500 mt-1">
                            <Trash2 size={12} />
                          </button>
                        </div>
                        {field.genderVariants && (
                          <div className="flex items-center gap-1.5 pr-5">
                            {[
                              ["label_f", "F"],
                              ["label_m", "M"],
                            ].map(([key, tag]) => (
                              <label key={key} className="flex-1 flex items-center gap-1 min-w-0">
                                <span className="text-[10px] font-semibold text-neutral-400 w-3">{tag}</span>
                                <input value={m[key] || ""} onChange={(e) => updateValueMap(i, { [key]: e.target.value })} placeholder={m.label} className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0" />
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <button onClick={addValueMap} className="mt-1.5 flex items-center gap-1 text-xs text-blue-600 hover:underline">
                    <Plus size={11} /> Add mapping
                  </button>
                </div>
              )}
            </>
          )}

          <div className="grid grid-cols-2 gap-1 p-0.5 bg-neutral-100 rounded-md text-xs">
            {[["point", "Point text"], ["frame", "Text frame"]].map(([kind, label]) => (
              <button
                key={kind}
                onClick={() => {
                  if ((field.textKind || "point") === kind) return;
                  // Unwrapped point text's X is its anchor (left edge /
                  // center / right edge, per alignment); a frame's X is its
                  // left edge, so shift to keep the text where it was.
                  // Wrapped point text is already a box from X: keep X and
                  // carry its width over.
                  const frame = { ...DEFAULT_FRAME, ...(field.frame || {}), ...(field.wrap && kind === "frame" ? { w_mm: field.w_mm } : {}) };
                  const anchor = field.wrap ? 0 : field.align === "center" ? frame.w_mm / 2 : field.align === "right" ? frame.w_mm : 0;
                  const x_mm = Math.round((kind === "frame" ? field.x_mm - anchor : field.x_mm + anchor) * 10) / 10;
                  onChange({ textKind: kind, frame, x_mm });
                }}
                className={`py-1 rounded ${(field.textKind || "point") === kind ? "bg-white shadow-sm font-medium text-neutral-900" : "text-neutral-500"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-neutral-400 -mt-1">
            {field.textKind === "frame"
              ? "The text is laid out inside a box: it shrinks, wraps and aligns within it. Drag the corner handle to resize."
              : "Anchored at one point; it grows from there."}
          </div>

          <AlignField value={field.align} onChange={(v) => onChange({ align: v })} />
          <SelectField label="Case" value={field.textCase || "none"} onChange={(v) => onChange({ textCase: v })} options={["none", "upper", "lower", "title"]} />
          {field.textKind === "frame" ? (
            <TextFrameOptions
              field={field}
              onChange={onChange}
              fontSelect={
                <div>
                  <div className="text-[11px] text-neutral-500 mb-1">Font</div>
                  <select value={field.font} onChange={(e) => onChange({ font: e.target.value })} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md">
                    {fontOptions.map((f) => (
                      <option key={f} value={f}>
                        {fontLabel(f)}
                      </option>
                    ))}
                  </select>
                </div>
              }
            />
          ) : (
            <>
              <div className="border-t border-neutral-100 pt-3">
                <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                  <input type="checkbox" checked={field.wrap} onChange={(e) => onChange({ wrap: e.target.checked })} />
                  Wrap to a fixed width (multi-line)
                </label>
                {field.wrap && (
                  <div className="mt-2 space-y-2">
                    <NumField label="Width (mm)" value={field.w_mm} onChange={(v) => onChange({ w_mm: v })} />
                    <SelectField label="Break style" value={field.breakStyle || "break-word"} onChange={(v) => onChange({ breakStyle: v })} options={["break-word", "break-all"]} />
                    <div className="text-[10px] text-neutral-400">"break-all" splits mid-word (e.g. COMPE / TITOR); "break-word" only breaks at spaces when possible.</div>
                    <NumField label="Line height" value={field.lineHeight || 1.05} onChange={(v) => onChange({ lineHeight: v })} />
                  </div>
                )}
                {!field.wrap && <div className="text-[10px] text-neutral-400 mt-1.5">Without wrap, alignment treats X as the anchor point (left edge / center / right edge of the text).</div>}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <NumField label="Box height (mm)" value={field.boxHeightMm || 0} onChange={(v) => onChange({ boxHeightMm: Math.max(0, v) })} />
                <SelectField label="Vertical align" value={field.vAlign || "top"} onChange={(v) => onChange({ vAlign: v })} options={["top", "middle", "bottom"]} />
              </div>
              <div className="text-[10px] text-neutral-400 -mt-2">
                {field.boxHeightMm > 0
                  ? "The text sits at the top, middle (same space above and below) or bottom of a box this tall, starting at Y — like a spreadsheet cell."
                  : "Set a box height (0 = none) to align the text vertically inside it."}
              </div>

              <div>
                <div className="text-[11px] text-neutral-500 mb-1">Font</div>
                <select value={field.font} onChange={(e) => onChange({ font: e.target.value })} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md">
                  {fontOptions.map((f) => (
                    <option key={f} value={f}>
                      {fontLabel(f)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={field.fontMode === "fixed"} onChange={() => onChange({ fontMode: "fixed" })} />
                  Fixed size
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={field.fontMode === "autofit"} onChange={() => onChange({ fontMode: "autofit" })} />
                  Auto-fit
                </label>
              </div>
              {field.fontMode === "fixed" ? (
                <NumField label="Size (pt)" value={field.size} onChange={(v) => onChange({ size: v })} />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <NumField label="Min pt" value={field.size_min || 8} onChange={(v) => onChange({ size_min: v })} />
                  <NumField label="Max pt" value={field.size_max || 16} onChange={(v) => onChange({ size_max: v })} />
                  <NumField label="Max width (mm)" value={field.max_width_mm || 60} onChange={(v) => onChange({ max_width_mm: v })} />
                </div>
              )}
            </>
          )}
          <NumField label="Letter spacing (pt)" value={field.letterSpacing || 0} onChange={(v) => onChange({ letterSpacing: v })} />
          <ColorField label="Color" value={field.color} onChange={(v) => onChange({ color: v })} />
          <TextColorMapControls field={field} sampleData={sampleData} onChange={onChange} />
        </>
      )}

      {field.type === "image" && (
        <>
          <label className="flex items-center gap-1.5 text-xs text-neutral-600">
            <input type="checkbox" checked={field.mapped} onChange={(e) => onChange({ mapped: e.target.checked })} />
            Use value-based image mapping
          </label>
          {!field.mapped ? (
            <>
              <div>
                <div className="text-[11px] text-neutral-500 mb-1">Asset path (used at generation time)</div>
                <input type="text" value={field.path} onChange={(e) => onChange({ path: e.target.value })} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md" />
              </div>
              <label className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-neutral-300 rounded-md cursor-pointer hover:bg-neutral-50 w-fit">
                <Upload size={14} />
                Preview image
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => onChange({ preview: reader.result });
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
            </>
          ) : (
            <>
              <MappingEditor
                mapSource={field.mapSource}
                mappings={field.mappings}
                kind="image"
                sampleKeys={Object.keys(sampleData)}
                onSourceChange={(v) => onChange({ mapSource: v })}
                onAdd={addMapping}
                onUpdate={updateMapping}
                onRemove={removeMapping}
                onBulkFiles={(fileList) => readImageFilesAsMappingEntries(fileList).then((entries) => onChange({ mappings: upsertMappingsByValue(field.mappings, entries) }))}
              />
              {field.mapSource === "countryIso2" && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={onSyncCountryFlags}
                    disabled={!hasWcif}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:underline disabled:text-neutral-400 disabled:no-underline disabled:cursor-not-allowed"
                  >
                    <Upload size={11} /> Sync flags from loaded WCIF
                  </button>
                  {!hasWcif && <span className="text-[10px] text-neutral-400">(load a WCIF first)</span>}
                </div>
              )}
              <div>
                <div className="text-[11px] text-neutral-500 mb-1">Fallback asset path</div>
                <input type="text" value={field.fallbackPath} onChange={(e) => onChange({ fallbackPath: e.target.value })} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md" />
              </div>
            </>
          )}
          <ImageCropControls field={field} sampleData={sampleData} onChange={onChange} />
        </>
      )}

      {field.type === "colorblock" && (
        <>
          <MappingEditor mapSource={field.mapSource} mappings={field.mappings} kind="color" sampleKeys={Object.keys(sampleData)} onSourceChange={(v) => onChange({ mapSource: v })} onAdd={addMapping} onUpdate={updateMapping} onRemove={removeMapping} />
          <ColorField label="Fallback color" value={field.fallbackColor} onChange={(v) => onChange({ fallbackColor: v })} />
          <div>
            <div className="text-[11px] text-neutral-500 mb-1">Opacity ({field.opacity ?? 100}%)</div>
            <input type="range" min="0" max="100" value={field.opacity ?? 100} onChange={(e) => onChange({ opacity: Number(e.target.value) })} className="w-full" />
          </div>
          <SelectField label="Label text (optional)" value={field.labelSource || ""} onChange={(v) => onChange({ labelSource: v || null })} options={["", ...Object.keys(sampleData)]} />
          <ColorField label="Label color" value={field.labelColor} onChange={(v) => onChange({ labelColor: v })} />
        </>
      )}

      {field.type === "qr" && (
        <div>
          <div className="text-[11px] text-neutral-500 mb-1">Target URL (use {"{field}"} placeholders)</div>
          <input type="text" value={field.target} onChange={(e) => onChange({ target: e.target.value })} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md" />
        </div>
      )}

      {field.type === "schedule" && (() => {
        const dayIdx = field.dayIndex || 0;
        const scheduleDays = sampleData.schedules ? Object.keys(sampleData.schedules).sort() : [];
        const activeDayKey = scheduleDays[dayIdx];
        const allDayRows = (activeDayKey && sampleData.schedules[activeDayKey]) || [];

        // Filter for activities starting with 'other-' or special entries
        const otherActivities = allDayRows.filter(
          (r) => (r.activityCode && r.activityCode.startsWith("other")) || r.isSpecial
        );

        const excluded = new Set(field.excludedIds || []);

        const toggleActivity = (uniqueId) => {
          const next = new Set(excluded);
          if (next.has(uniqueId)) {
            next.delete(uniqueId); // Include it back
          } else {
            next.add(uniqueId);    // Exclude it
          }
          onChange({ excludedIds: Array.from(next) });
        };

        return (
          <div className="space-y-3">
            <label className="block">
              <div className="text-[11px] text-neutral-500 mb-1">
                Timezone <span className="text-neutral-400">(applies to every schedule field, not just this one)</span>
              </div>
              <input
                type="text"
                value={scheduleTimezone || ""}
                onChange={(e) => onScheduleTimezoneChange(e.target.value)}
                placeholder={detectedScheduleTimezone ? `Auto — from WCIF: ${detectedScheduleTimezone}` : "Auto (e.g. Europe/Lisbon)"}
                className={`w-full text-xs px-2 py-1.5 border rounded-md font-mono ${scheduleTimezone && !isValidTimezone(scheduleTimezone) ? "border-red-400 bg-red-50" : "border-neutral-300"}`}
              />
              {scheduleTimezone && !isValidTimezone(scheduleTimezone) ? (
                <div className="text-[10px] text-red-500 mt-1">Not a recognized IANA timezone name — times will fall back to raw UTC until this is fixed or cleared.</div>
              ) : (
                <div className="text-[10px] text-neutral-400 mt-1">
                  IANA name (e.g. "Europe/Lisbon", "America/Sao_Paulo"). Leave blank to use the competition venue's own timezone
                  {detectedScheduleTimezone ? ` (currently ${detectedScheduleTimezone})` : ""} — this follows daylight saving automatically, so it stays correct without manual adjustment.
                </div>
              )}
            </label>

            <NumField
              label="Day Index (0 = Day 1, 1 = Day 2...)"
              value={field.dayIndex || 0}
              onChange={(v) => onChange({ dayIndex: Math.max(0, Math.round(v)) })}
            />

            <label className="block">
              <div className="text-[11px] text-neutral-500 mb-1">Header Title Override</div>
              <input
                type="text"
                placeholder="Auto (e.g. Friday, October 9th)"
                value={field.customTitle || ""}
                onChange={(e) => onChange({ customTitle: e.target.value })}
                className="w-full text-xs px-2 py-1.5 border border-neutral-300 rounded-md"
              />
            </label>

            <div>
              <div className="text-[11px] text-neutral-500 mb-1">Column headers</div>
              <div className="grid grid-cols-3 gap-1.5">
                {[["time", "Time"], ["event", "Event"], ["task", "Task"]].map(([key, fallback]) => (
                  <input
                    key={key}
                    type="text"
                    placeholder={fallback}
                    value={field.columnLabels?.[key] || ""}
                    onChange={(e) => onChange({ columnLabels: { ...field.columnLabels, [key]: e.target.value } })}
                    className="w-full text-xs px-2 py-1.5 border border-neutral-300 rounded-md min-w-0"
                  />
                ))}
              </div>
              <div className="text-[10px] text-neutral-400 mt-1">Event and activity names are renamed for every table under "Schedule" in the toolbar.</div>
            </div>

            {/* Other / Special Activities Toggle List */}
            <div className="border-t border-neutral-200 pt-2.5">
              <div className="text-[11px] font-semibold text-neutral-600 mb-1.5">
                Included Non-Event Activities
              </div>
              <div className="text-[10px] text-neutral-400 mb-2">
                Uncheck any items that should be removed from this badge table:
              </div>

              {otherActivities.length > 0 ? (
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {otherActivities.map((act, idx) => {
                    const uniqueId = String(act.id || `${act.time}_${act.event}`);
                    const isChecked = !excluded.has(uniqueId);

                    return (
                      <label
                        key={uniqueId}
                        className="flex items-center gap-2 text-xs text-neutral-700 bg-neutral-50 p-1.5 rounded border border-neutral-200 cursor-pointer hover:bg-neutral-100"
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleActivity(uniqueId)}
                          className="rounded border-neutral-300"
                        />
                        <div className="flex-1 truncate">
                          <span className="font-mono text-[10px] text-neutral-400 mr-1.5">
                            {act.time}
                          </span>
                          <span className="font-medium">{act.event}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[11px] text-neutral-400 italic">
                  No "other" activities found on this day.
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {field.type === "taskkey" && (() => {
        const { stageRows } = resolveTaskKeyRows(field, sampleData);
        const names = field.stageNames || [];
        const updateName = (i, value) => {
          const next = [...names];
          next[i] = value;
          onChange({ stageNames: next });
        };
        return (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-neutral-600">Stage names</div>
            <div className="text-[10px] text-neutral-400 mb-1">
              Names come from the loaded competition by default — edit any of them below to override just the label (color still follows the real stage; change it under "Stage colors" in the toolbar).
            </div>
            {stageRows.map((s, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-sm border border-neutral-300 shrink-0" style={{ background: s.color }} />
                <input
                  type="text"
                  value={names[i] ?? s.name}
                  onChange={(e) => updateName(i, e.target.value)}
                  className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0"
                />
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

function DataPanel({ sampleData, updateSampleValue, addSampleKey, removeSampleKey }) {
  return (
    <div>
      <div className="p-4">
        <div className="text-xs font-semibold text-neutral-500 mb-2">SAMPLE BADGE DATA</div>
        <div className="text-[11px] text-neutral-400 mb-2">Used to preview this one badge. Color/image mappings, text value-mappings and templates live on each element — select one to edit it.</div>
        <div className="space-y-2">
          {Object.entries(sampleData).map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5">
              <span className="text-xs text-neutral-500 w-24 truncate">{k}</span>
              <input value={v} onChange={(e) => updateSampleValue(k, e.target.value)} className="flex-1 text-sm px-2 py-1 border border-neutral-300 rounded-md min-w-0" />
              <button onClick={() => removeSampleKey(k)} className="text-neutral-400 hover:text-red-500">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <button onClick={addSampleKey} className="mt-2 flex items-center gap-1 text-xs text-blue-600 hover:underline">
          <Plus size={12} /> Add field
        </button>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }) {
  return (
    <label className="block">
      <div className="text-[11px] text-neutral-500 mb-1">{label}</div>
      <input type="number" step="0.5" value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md" />
    </label>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label className="block">
      <div className="text-[11px] text-neutral-500 mb-1">{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full text-sm px-2 py-1.5 border border-neutral-300 rounded-md">
        {options.map((o) => (
          <option key={o} value={o}>
            {o || "(none)"}
          </option>
        ))}
      </select>
    </label>
  );
}

// Text frame settings (see textLayout.js for what each one does).
function TextFrameOptions({ field, onChange, fontSelect }) {
  const frame = field.frame;
  const set = (patch) => onChange({ frame: { ...frame, ...patch } });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <NumField label="Width (mm)" value={frame.w_mm} onChange={(v) => set({ w_mm: v })} />
        {!frame.auto_height && <NumField label="Height (mm)" value={frame.h_mm} onChange={(v) => set({ h_mm: v })} />}
      </div>
      <label className="flex items-center gap-1.5 text-xs text-neutral-600">
        <input type="checkbox" checked={!!frame.auto_height} onChange={(e) => set({ auto_height: e.target.checked })} />
        Auto height (the frame grows with its text)
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumField label="Inset (mm)" value={frame.padding_mm || 0} onChange={(v) => set({ padding_mm: Math.max(0, v) })} />
        {!frame.auto_height && <SelectField label="Vertical align" value={frame.v_align} onChange={(v) => set({ v_align: v })} options={["top", "middle", "bottom"]} />}
      </div>

      {fontSelect}

      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={frame.fit === "fixed"} onChange={() => set({ fit: "fixed" })} />
          Fixed size
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={frame.fit !== "fixed"} onChange={() => set({ fit: "shrink" })} />
          Shrink to fit
        </label>
      </div>
      {frame.fit === "fixed" ? (
        <NumField label="Size (pt)" value={field.size} onChange={(v) => onChange({ size: v })} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Min pt" value={frame.size_min} onChange={(v) => set({ size_min: v })} />
            <NumField label="Max pt" value={frame.size_max} onChange={(v) => set({ size_max: v })} />
          </div>
          <NumField label="Break into lines below (pt)" value={frame.wrap_below || 0} onChange={(v) => set({ wrap_below: Math.max(0, v) })} />
          <div className="text-[10px] text-neutral-400 -mt-2">
            Keeps the text on one line while it fits at this size or bigger; below it, the text breaks into lines instead (and can grow back up). 0 = stay on one line down to the minimum.
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <NumField label="Min lines" value={frame.min_lines || 1} onChange={(v) => set({ min_lines: Math.max(1, Math.round(v)) })} />
        <NumField label="Max lines (0 = any)" value={frame.max_lines || 0} onChange={(v) => set({ max_lines: Math.max(0, Math.round(v)) })} />
      </div>
      {(frame.min_lines || 1) > 1 && (
        <div className="text-[10px] text-neutral-400 -mt-2">
          The text goes on at least this many lines when it has somewhere to break, with the words shared out evenly ("RUBÉN LÓPEZ" / "DE JUAN"). A single word stays on one line.
        </div>
      )}
      <NumField label="Line height" value={field.lineHeight || 1.05} onChange={(v) => onChange({ lineHeight: v })} />
      <SelectField label="Break style" value={field.breakStyle || "break-word"} onChange={(v) => onChange({ breakStyle: v })} options={["break-word", "break-all"]} />
      <SelectField label="If it still doesn't fit" value={frame.overflow} onChange={(v) => set({ overflow: v })} options={["visible", "clip", "ellipsis"]} />
      <div className="text-[10px] text-neutral-400 -mt-2">"clip" drops the lines that fall outside the frame; "ellipsis" also ends the last one with "…". A red marker on the frame means its text doesn't fit.</div>
    </div>
  );
}

// An image drawn the way placeImage (imageCrop.js) says — the same math
// pdfExport.js uses, so the preview shows exactly what gets printed.
function CroppedImage({ src, crop, fit, boxW, boxH }) {
  const [natural, setNatural] = useState(null);
  const ready = natural && natural.src === src;
  const p = ready ? placeImage(natural.w, natural.h, crop, fit, boxW, boxH) : null;
  const sx = p ? p.dw / p.sw : 0;
  const sy = p ? p.dh / p.sh : 0;
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      {/* The drawn area is p.dx..p.dx+p.dw; clipping to it keeps the rest of the image hidden. */}
      <div style={{ position: "absolute", left: p ? p.dx : 0, top: p ? p.dy : 0, width: p ? p.dw : "100%", height: p ? p.dh : "100%", overflow: "hidden" }}>
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => setNatural({ src, w: e.currentTarget.naturalWidth || 512, h: e.currentTarget.naturalHeight || 512 })}
          style={
            p
              ? { position: "absolute", maxWidth: "none", left: -p.sx * sx, top: -p.sy * sy, width: natural.w * sx, height: natural.h * sy }
              : { width: "100%", height: "100%", objectFit: "contain", opacity: 0 }
          }
        />
      </div>
    </div>
  );
}

// Fit mode + crop button for an image field. Mapped images share one crop
// (it's in fractions of the image, so it applies to each of them); the
// editor shows whichever image the sample data currently picks.
function ImageCropControls({ field, sampleData, onChange }) {
  const [editing, setEditing] = useState(false);
  const src = field.mapped ? resolveMapping(field, sampleData, "image")?.preview || field.fallbackPreview : field.preview;
  return (
    <div className="border-t border-neutral-100 pt-3 space-y-2">
      <div className="text-[11px] text-neutral-500">Fit in box</div>
      <div className="grid grid-cols-3 gap-1 p-0.5 bg-neutral-100 rounded-md text-xs">
        {[["contain", "Fit"], ["cover", "Fill"], ["stretch", "Stretch"]].map(([fit, label]) => (
          <button key={fit} onClick={() => onChange({ fit })} className={`py-1 rounded ${(field.fit || "contain") === fit ? "bg-white shadow-sm font-medium text-neutral-900" : "text-neutral-500"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="text-[10px] text-neutral-400">Fit shows the whole (cropped) image; Fill covers the box and trims what doesn't match its shape; Stretch distorts it to the box.</div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => setEditing(true)}
          disabled={!src}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-neutral-300 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Crop size={12} /> Crop…
        </button>
        {!isFullCrop(field.crop) && (
          <button onClick={() => onChange({ crop: { ...FULL_CROP } })} className="text-xs text-blue-600 hover:underline">
            Reset crop
          </button>
        )}
        {!src && <span className="text-[10px] text-neutral-400">Add a preview image first</span>}
      </div>
      {editing && src && <CropEditor src={src} crop={field.crop} frameAspect={field.w_mm / field.h_mm} onChange={(crop) => onChange({ crop })} onClose={() => setEditing(false)} />}
    </div>
  );
}

// Modal crop editor: drag the rectangle to move it, its corners to resize
// it. Changes apply live; "Match box shape" keeps the rectangle in the
// field's proportions, so Fit and Fill both show exactly the selected area.
function CropEditor({ src, crop, frameAspect, onChange, onClose }) {
  const [natural, setNatural] = useState(null);
  const [lockAspect, setLockAspect] = useState(false);
  const dragRef = useRef(null);
  const c = normalizeCrop(crop);

  const MAX_W = 560;
  const MAX_H = 420;
  const scale = natural ? Math.min(MAX_W / natural.w, MAX_H / natural.h) : 1;
  const dispW = natural ? natural.w * scale : MAX_W;
  const dispH = natural ? natural.h * scale : MAX_H;
  // Height (as a fraction of the image) that gives a crop of width-fraction
  // w the box's proportions.
  const lockedH = (w) => (w * dispW) / (dispH * frameAspect);

  const startDrag = (e, mode) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, orig: c };
    const move = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.startX) / dispW;
      const dy = (ev.clientY - d.startY) / dispH;
      const o = d.orig;
      if (d.mode === "move") {
        onChange(normalizeCrop({ ...o, x: Math.min(Math.max(o.x + dx, 0), 1 - o.w), y: Math.min(Math.max(o.y + dy, 0), 1 - o.h) }));
        return;
      }
      // Corner resize: the opposite corner stays put.
      const left = d.mode.includes("w");
      const top = d.mode.includes("n");
      const right = o.x + o.w;
      const bottom = o.y + o.h;
      let x1 = left ? Math.min(Math.max(o.x + dx, 0), right - 0.02) : o.x;
      let x2 = left ? right : Math.min(Math.max(right + dx, o.x + 0.02), 1);
      let y1 = top ? Math.min(Math.max(o.y + dy, 0), bottom - 0.02) : o.y;
      let y2 = top ? bottom : Math.min(Math.max(bottom + dy, o.y + 0.02), 1);
      if (lockAspect) {
        let w = x2 - x1;
        let h = lockedH(w);
        const maxH = top ? bottom : 1 - o.y;
        if (h > maxH) {
          h = maxH;
          w = (h * dispH * frameAspect) / dispW;
          if (left) x1 = x2 - w;
          else x2 = x1 + w;
        }
        if (top) y1 = bottom - h;
        else y2 = y1 + h;
      }
      onChange(normalizeCrop({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleLock = (on) => {
    setLockAspect(on);
    if (!on) return;
    // Snap the current rectangle to the box's proportions, keeping its center.
    let w = c.w;
    let h = lockedH(w);
    if (h > 1) {
      h = 1;
      w = (h * dispH * frameAspect) / dispW;
    }
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    onChange(normalizeCrop({ x: Math.min(Math.max(cx - w / 2, 0), 1 - w), y: Math.min(Math.max(cy - h / 2, 0), 1 - h), w, h }));
  };

  const handle = (mode, style) => (
    <div onPointerDown={(e) => startDrag(e, mode)} style={{ position: "absolute", width: 14, height: 14, background: "#fff", border: "2px solid #2563eb", borderRadius: 3, ...style }} />
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onPointerDown={onClose}>
      <div className="bg-white rounded-lg shadow-xl p-4 space-y-3 max-w-full" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <Crop size={14} /> Crop image
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
            <X size={16} />
          </button>
        </div>
        <div style={{ position: "relative", width: dispW, height: dispH, overflow: "hidden", userSelect: "none", background: "repeating-conic-gradient(#e5e5e5 0% 25%, #fff 0% 50%) 50% / 16px 16px" }}>
          <img
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 512, h: e.currentTarget.naturalHeight || 512 })}
            style={{ width: dispW, height: dispH, display: "block" }}
          />
          {natural && (
            <div
              data-crop-rect
              onPointerDown={(e) => startDrag(e, "move")}
              style={{
                position: "absolute",
                left: c.x * dispW,
                top: c.y * dispH,
                width: c.w * dispW,
                height: c.h * dispH,
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                outline: "1.5px solid #fff",
                cursor: "move",
              }}
            >
              {handle("nw", { left: -7, top: -7, cursor: "nwse-resize" })}
              {handle("ne", { right: -7, top: -7, cursor: "nesw-resize" })}
              {handle("sw", { left: -7, bottom: -7, cursor: "nesw-resize" })}
              {handle("se", { right: -7, bottom: -7, cursor: "nwse-resize" })}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-4">
          <label className="flex items-center gap-1.5 text-xs text-neutral-600">
            <input type="checkbox" checked={lockAspect} onChange={(e) => toggleLock(e.target.checked)} />
            Match box shape
          </label>
          <div className="flex items-center gap-2">
            <button onClick={() => onChange({ ...FULL_CROP })} className="text-xs px-3 py-1.5 border border-neutral-300 rounded-md hover:bg-neutral-50">
              Reset
            </button>
            <button onClick={onClose} className="text-xs px-3 py-1.5 bg-neutral-900 text-white rounded-md hover:bg-neutral-800">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// "Color depends on a value" for text fields: a color per value of one
// sample-data key (role by default); anything unmatched keeps the text's
// own color above.
function TextColorMapControls({ field, sampleData, onChange }) {
  const map = field.colorMap || { enabled: false, source: "role", mappings: [] };
  const set = (patch) => onChange({ colorMap: { ...map, ...patch } });
  const sampleKeys = Object.keys(sampleData).filter((k) => typeof sampleData[k] !== "object");
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 text-xs text-neutral-600">
        <input
          type="checkbox"
          checked={map.enabled}
          onChange={(e) =>
            set({ enabled: e.target.checked, ...(e.target.checked && map.mappings.length === 0 ? { mappings: [{ value: "organizer", color: "#f97316" }, { value: "delegate", color: "#dc2626" }] } : {}) })
          }
        />
        Color depends on a value
      </label>
      {map.enabled && (
        <>
          <MappingEditor
            mapSource={map.source}
            mappings={map.mappings}
            kind="color"
            sampleKeys={sampleKeys}
            onSourceChange={(v) => set({ source: v })}
            onAdd={() => set({ mappings: [...map.mappings, { value: "", color: field.color }] })}
            onUpdate={(i, patch) => set({ mappings: map.mappings.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) })}
            onRemove={(i) => set({ mappings: map.mappings.filter((_, idx) => idx !== i) })}
          />
          <div className="text-[10px] text-neutral-400">Values that match none of these keep the color above.</div>
        </>
      )}
    </div>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <label className="block">
      <div className="text-[11px] text-neutral-500 mb-1">{label}</div>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-full h-8 border border-neutral-300 rounded-md cursor-pointer" />
    </label>
  );
}