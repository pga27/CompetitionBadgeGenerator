import React, { useState, useRef, useCallback } from "react";
import {
  Type,
  Image as ImageIcon,
  Square,
  QrCode,
  Rows3,
  Trash2,
  Plus,
  Download,
  Upload,
  RotateCw,
  Palette,
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
} from "lucide-react";
import { buildCompetitorSchedules, buildGenericSchedule, buildStageList, resolveScheduleTimezone } from "./schedule.js";
import { generateBadgesPdf, downloadPdfBytes } from "./pdfExport.js";

const SCALE = 5.2; // px per mm
const MIN_MM = 4;
const TINT_ID = "__tint__";
const FONTS_ID = "__fonts__";
const BGMAP_ID = "__bgmap__";
const ROLEMAP_ID = "__rolemap__";
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
  if (field.type === "text") return field.wrap ? field.w_mm || 60 : 0;
  return field.w_mm || 20;
}
function fieldBoxHeightMm(field) {
  if (field.type === "qr") return field.size_mm || 16;
  if (field.type === "text") return 0;
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
    value = found ? found.label : raw;
  }
  return (field.customPrefix || "") + value;
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

function defaultSide(w, h, seedFields) {
  return {
    page: { width_mm: w, height_mm: h },
    background: null,
    backgroundName: "assets/background.png",
    tint: defaultTint(),
    backgroundMap: defaultBackgroundMap(),
    fields: seedFields || [],
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
  };
}

function initialState() {
  return {
    sampleData: {
      name: "Pedro Azevedo",
      role: "competitor",
      wcaId: "2018AZEV03",
      registrantId: "1",
      countryIso2: "PT",
      // No seeded schedule on purpose: until a WCIF is loaded (via "Load WCIF
      // JSON"), the schedule field renders its own generic placeholder rows
      // (see the schedule branch in FieldBox). Loading a WCIF fills this with
      // buildGenericSchedule()'s output — real dates/events/room colors, but
      // still placeholder tasks, never a specific person's real assignments.
      schedules: {},
      // Same story: empty until a WCIF is loaded, at which point it's the
      // competition's real stage names + colors (see buildStageList).
      // Until then the Task Key field falls back to generic placeholder
      // stages (see TASKKEY_FALLBACK_STAGES).
      stages: [],
    },

    // Empty = auto: use the competition venue's own timezone from the WCIF
    // (Venue.timezone, an Olson/IANA name — see resolveScheduleTimezone in
    // schedule.js). Set explicitly to override it, e.g. if the WCIF's
    // venue.timezone is missing/wrong, or to preview in a different zone.
    scheduleTimezone: "",

    // Maps a WCIF person's `roles` array (they can hold more than one at
    // once, e.g. an organizer who's also a judge) down to the single
    // "role" value used throughout the template (text mappings, tint,
    // background images, etc. — see the "ROLE FIELDS" panel). Rules are
    // checked in order; the first one whose wcaRole appears in the
    // person's roles wins, so priority between roles is an explicit
    // choice rather than code. Anyone matching no rule gets `fallback`.
    // Mirrors DEFAULT_ROLE_MAPPING in pdfExport.js exactly, so a template
    // saved before this feature existed keeps behaving the same way.
    roleMapping: {
      rules: [
        { wcaRole: "organizer", label: "organizer" },
        { wcaRole: "delegate", label: "delegate" },
      ],
      fallback: "competitor",
    },

    fonts: [],
    front: defaultSide(105, 148, [
      {
        id: uid("colorblock"),
        type: "colorblock",
        x_mm: 0,
        y_mm: 0,
        w_mm: 105,
        h_mm: 148,
        rotate: 0,
        mapSource: "role",
        fallbackColor: "#9CA3AF",
        opacity: 100,
        mappings: [
          { value: "competitor", color: "#5A8F2E" },
          { value: "delegate", color: "#ec1b1b" },
          { value: "organizer", color: "#4552e2" },
        ],
        labelSource: null,
        labelColor: "#FFFFFF",
      },
      {
        id: uid("text"),
        type: "text",
        x_mm: 8,
        y_mm: 10,
        rotate: 0,
        ...textFieldDefaults(),
        bindMode: "field",
        source: "role",
        useValueMap: true,
        valueMap: [
          { value: "competitor", label: "COMPETITOR" },
          { value: "delegate", label: "DELEGATE" },
          { value: "organizer", label: "ORGANIZER" },
        ],
        font: "Helvetica-Bold",
        size: 30,
        color: "#FFFFFF",
        align: "left",
        wrap: true,
        w_mm: 60,
        breakStyle: "break-all",
        lineHeight: 0.95,
      },
      {
        id: uid("text"),
        type: "text",
        x_mm: 8,
        y_mm: 108,
        rotate: 0,
        ...textFieldDefaults(),
        bindMode: "field",
        source: "name",
        font: "Helvetica-Bold",
        size: 12,
        color: "#FFFFFF",
        align: "center",
        wrap: true,
        w_mm: 90,
        breakStyle: "break-word",
      },
      {
        id: uid("text"),
        type: "text",
        x_mm: 8,
        y_mm: 116,
        rotate: 0,
        ...textFieldDefaults(),
        bindMode: "template",
        template: "{wcaId} - ID {registrantId}",
        font: "Helvetica",
        size: 10,
        color: "#FFFFFF",
        align: "center",
        wrap: true,
        w_mm: 90,
      },
      { id: uid("text"), type: "text", x_mm: 52, y_mm: 140, rotate: 0, ...textFieldDefaults(), bindMode: "static", staticText: "WCA EURO 2026 · ARNHEM NL", font: "Helvetica", size: 7, color: "#FFFFFF", align: "center" },
    ]),
    back: defaultSide(148, 105, [
      { id: uid("text"), type: "text", x_mm: 6, y_mm: 6, rotate: 90, ...textFieldDefaults(), bindMode: "field", source: "registrantId", customPrefix: "#", font: "Helvetica-Bold", size: 11, color: "#141414" },
      { id: uid("qr"), type: "qr", target: "https://www.worldcubeassociation.org/persons/{wcaId}", x_mm: 6, y_mm: 95, size_mm: 16 },
      { id: uid("qr"), type: "qr", target: "https://live.worldcubeassociation.org/", x_mm: 126, y_mm: 99, size_mm: 16 },
      { id: uid("schedule"), type: "schedule", x_mm: 26, y_mm: 6, w_mm: 96, h_mm: 96, dayIndex: 0 },
    ]),
  };
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
    sampleData: data.sample_data || { name: "Sample Name" },
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
    fonts: inflatedFonts,
    front: inflateSide(data.front, 105, 148),
    back: inflateSide(data.back, 148, 105),
  };
}

export default function BadgeDesigner() {
  const [state, setState] = useState(initialState);
  const [side, setSide] = useState("front");
  const [selectedId, setSelectedId] = useState(null);
  const [showData, setShowData] = useState(false);
  const [generating, setGenerating] = useState(null); // null | { done, total } | "error"
  const [guides, setGuides] = useState({ x: null, y: null });

  // Inside BadgeDesigner component:
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
      const genericSchedule = buildGenericSchedule(wcif, state.scheduleTimezone || undefined);
      const stages = buildStageList(wcif);

      // Populates any "driven by country" image field's mappings from the
      // flags actually needed for this WCIF's competitors (see
      // syncCountryFlagFields) — both sides, independently of which one is
      // currently showing.
      const [frontFields, backFields] = await Promise.all([syncCountryFlagFields(state.front.fields, wcif), syncCountryFlagFields(state.back.fields, wcif)]);

      setState((prev) => ({
        ...prev,
        wcif, // full raw WCIF, kept so "Generate PDF" can use REAL per-competitor data later
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
  const selectedField = selectedId && selectedId !== TINT_ID && selectedId !== FONTS_ID && selectedId !== BGMAP_ID && selectedId !== ROLEMAP_ID ? fields.find((f) => f.id === selectedId) : null;

  const updateSide = (patch) => setState((s) => ({ ...s, [side]: { ...s[side], ...patch } }));
  const updateField = (id, patch) => updateSide({ fields: sideData.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });

  // Manual re-sync for a single field — for when mapSource is set to
  // "country" AFTER a WCIF is already loaded (the automatic sync in
  // loadWcifData only fires at load time), or to pick up newly-added
  // flag files under src/assets/flags/ without reloading the WCIF.
  const syncCountryFlagsForField = async (fieldId) => {
    if (!state.wcif) {
      alert("Load a WCIF first (the \"Load WCIF JSON\" control) — flags are fetched per the competitors it contains.");
      return;
    }
    const entries = await fetchFlagMappingEntries(state.wcif);
    updateField(fieldId, { mappings: upsertMappingsByValue(sideData.fields.find((f) => f.id === fieldId)?.mappings || [], entries) });
  };
  const updateTint = (patch) => updateSide({ tint: { ...sideData.tint, ...patch } });
  const updateBackgroundMap = (patch) => updateSide({ backgroundMap: { ...sideData.backgroundMap, ...patch } });
  // Global, not per-side (like scheduleTimezone) — a person's role doesn't
  // change between the front and back of their own badge.
  const updateRoleMapping = (patch) => setState((s) => ({ ...s, roleMapping: { ...s.roleMapping, ...patch } }));

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
    if (type === "schedule") Object.assign(base, { w_mm: 60, h_mm: 40, dayIndex: 0, customTitle: "", excludedIds: [] });
    if (type === "taskkey") Object.assign(base, { w_mm: 70, stageNames: [] });
    updateSide({ fields: [...fields, base] });
    setSelectedId(base.id);
  };

  const removeField = (id) => {
    updateSide({ fields: fields.filter((f) => f.id !== id) });
    if (selectedId === id) setSelectedId(null);
  };

  // Field DEPTH (stacking order): both the canvas preview (fields.map at
  // render time — later array entries land later in the DOM, so they sit
  // visually on top) and pdfExport.js's draw loop (later entries painted
  // last onto the same PDF page) already treat `fields` array order as
  // depth order, back-to-front. So reordering is really just "let the
  // user rearrange this array" — nothing downstream needs to change.
  //
  // The sidebar list is shown reversed relative to storage, so the TOP
  // row is the FRONTMOST field (last in the actual array) — matching the
  // usual layers-panel convention (Figma, Photoshop, etc.), rather than
  // the less intuitive "front = bottom of the list".
  const [draggingFieldId, setDraggingFieldId] = useState(null);

  const reorderFields = (draggedId, targetId) => {
    if (draggedId === targetId) return;
    const displayOrder = [...fields].reverse();
    const fromIdx = displayOrder.findIndex((f) => f.id === draggedId);
    const toIdx = displayOrder.findIndex((f) => f.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = displayOrder.splice(fromIdx, 1);
    displayOrder.splice(toIdx, 0, moved);
    updateSide({ fields: [...displayOrder].reverse() });
  };

  // dir: -1 moves one step up the visible list (more toward the front),
  // +1 moves one step down (more toward the back).
  const moveFieldInList = (id, dir) => {
    const displayOrder = [...fields].reverse();
    const idx = displayOrder.findIndex((f) => f.id === id);
    if (idx === -1) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= displayOrder.length) return;
    [displayOrder[idx], displayOrder[newIdx]] = [displayOrder[newIdx], displayOrder[idx]];
    updateSide({ fields: [...displayOrder].reverse() });
  };

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
          schedules: buildGenericSchedule(prev.wcif, tz || undefined),
        };
      }
      return next;
    });
  };
  const detectedScheduleTimezone = state.wcif ? resolveScheduleTimezone(state.wcif) : null;

  const round1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sideRef = useRef(side);
  sideRef.current = side;

  const startDrag = useCallback((e, field, mode) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(field.id);
    dragRef.current = { id: field.id, mode, type: field.type, startX: e.clientX, startY: e.clientY, origX: field.x_mm, origY: field.y_mm, origW: fieldBoxWidthMm(field), origH: fieldBoxHeightMm(field) };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDragMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const s = stateRef.current;
    const sd = s[sideRef.current];
    const dx = (e.clientX - d.startX) / SCALE;
    const dy = (e.clientY - d.startY) / SCALE;
    const pw = sd.page.width_mm;
    const ph = sd.page.height_mm;
    if (d.mode === "move") {
      const rawX = clamp(d.origX + dx, 0, Math.max(pw - d.origW, 0));
      const rawY = clamp(d.origY + dy, 0, Math.max(ph - d.origH, 0));

      // Auto-alignment: snap to the page center or to other fields' edges/centers
      const SNAP_TOL = 1.2; // mm
      const w = d.origW;
      const h = d.origH;
      const others = sd.fields.filter((f) => f.id !== d.id);

      const candX = [
        (pw - w) / 2,
        ...others.flatMap((f) => {
          const fw = fieldBoxWidthMm(f); // 0 for a non-wrap text field, its real box width when wrapped
          return [f.x_mm, f.x_mm + fw - w, f.x_mm + fw / 2 - w / 2];
        }),
      ];
      const candY = [
        (ph - h) / 2,
        ...others.flatMap((f) => {
          const fh = fieldBoxHeightMm(f);
          return [f.y_mm, f.y_mm + fh - h, f.y_mm + fh / 2 - h / 2];
        }),
      ];

      let nx = rawX;
      let gx = null;
      for (const c of candX) {
        if (Math.abs(rawX - c) <= SNAP_TOL) {
          nx = c;
          gx = c + w / 2;
          break;
        }
      }
      let ny = rawY;
      let gy = null;
      for (const c of candY) {
        if (Math.abs(rawY - c) <= SNAP_TOL) {
          ny = c;
          gy = c + h / 2;
          break;
        }
      }

      setGuides({ x: gx, y: gy });
      applyFieldPatch(d.id, { x_mm: round1(nx), y_mm: round1(ny) });
    } else {
      const nw = clamp(d.origW + dx, MIN_MM, pw - d.origX);
      if (d.type === "schedule" || d.type === "taskkey") {
        // Height is derived, not draggable — width only.
        applyFieldPatch(d.id, { w_mm: round1(nw) });
      } else if (d.type === "qr") {
        // QR codes must stay square — a single size_mm, not independent
        // width/height (see drawQrField in pdfExport.js, which only ever
        // reads size_mm). Whichever axis the pointer moved further along
        // wins, so dragging diagonally, horizontally, or vertically from
        // the corner handle all behave the same way.
        const nh = clamp(d.origH + dy, MIN_MM, ph - d.origY);
        const newSize = Math.abs(nw - d.origW) >= Math.abs(nh - d.origH) ? nw : nh;
        const maxSize = Math.min(pw - d.origX, ph - d.origY);
        applyFieldPatch(d.id, { size_mm: round1(clamp(newSize, MIN_MM, maxSize)) });
      } else {
        const nh = clamp(d.origH + dy, MIN_MM, ph - d.origY);
        applyFieldPatch(d.id, { w_mm: round1(nw), h_mm: round1(nh) });
      }
    }
  };

  const applyFieldPatch = (id, patch) => {
    setState((s) => {
      const sd = s[sideRef.current];
      return { ...s, [sideRef.current]: { ...sd, fields: sd.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) } };
    });
  };

  const onDragEnd = () => {
    dragRef.current = null;
    setGuides({ x: null, y: null });
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
  };

  const onBgUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => updateSide({ background: reader.result });
    reader.readAsDataURL(file);
  };

  const updateSampleValue = (key, value) => setState((s) => ({ ...s, sampleData: { ...s.sampleData, [key]: value } }));
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
  const renameFontDisplay = (id, displayName) => setState((s) => ({ ...s, fonts: s.fonts.map((f) => (f.id === id ? { ...f, displayName } : f)) }));
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
            if (f.useValueMap) Object.assign(out, { value_map: f.valueMap });
          }
          Object.assign(out, { font: f.font, color: f.color, align: f.align || "left", letter_spacing: f.letterSpacing || 0, wrap: !!f.wrap });
          if (f.wrap) Object.assign(out, { w_mm: f.w_mm, break_style: f.breakStyle, line_height: f.lineHeight || 1.05 });
          if (f.fontMode === "autofit") Object.assign(out, { size_min: f.size_min, size_max: f.size_max, max_width_mm: f.max_width_mm || 60 });
          else out.size = f.size;
        } else if (f.type === "image") {
          Object.assign(out, { w_mm: f.w_mm, h_mm: f.h_mm, mapped: f.mapped });
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
          Object.assign(out, { w_mm: f.w_mm, h_mm: f.h_mm, dayIndex: f.dayIndex || 0, customTitle: f.customTitle || "", excludedIds: f.excludedIds || [] });
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
      fonts: fontsManifest,
      front: {
        page: state.front.page,
        background: state.front.backgroundName,
        background_data: state.front.background || null,
        background_tint: cleanTint(state.front.tint),
        background_map: cleanBgMap(state.front.backgroundMap),
        fields: cleanFields(state.front.fields),
      },
      back: {
        page: state.back.page,
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
      alert('Load a competition WCIF first (the "Load WCIF JSON" control) — the PDF is built from real competitors, not the sample preview data.');
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
        setSelectedId(null);
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

  return (
    <div className="w-full bg-neutral-100 text-neutral-900 flex flex-col" style={{ fontFamily: "system-ui, sans-serif", minHeight: 720 }}>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 bg-white border-b border-neutral-200">
        <div className="flex rounded-md overflow-hidden border border-neutral-300">
          {["front", "back"].map((s) => (
            <button
              key={s}
              onClick={() => {
                setSide(s);
                setSelectedId(null);
              }}
              className={`px-4 py-1.5 text-sm font-medium capitalize ${side === s ? "bg-neutral-900 text-white" : "bg-white text-neutral-600 hover:bg-neutral-50"}`}
            >
              {s}
            </button>
          ))}
        </div>

        <select onChange={(e) => applyPreset(PAGE_PRESETS[Number(e.target.value)])} className="text-xs px-2 py-1.5 border border-neutral-300 rounded-md text-neutral-700" defaultValue="">
          <option value="" disabled>
            Page size preset…
          </option>
          {PAGE_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1.5 text-xs text-neutral-500">
          <input type="number" value={sideData.page.width_mm} onChange={(e) => updateSide({ page: { ...sideData.page, width_mm: Number(e.target.value) } })} className="w-14 px-1.5 py-1 border border-neutral-300 rounded text-neutral-800" />
          <span>×</span>
          <input type="number" value={sideData.page.height_mm} onChange={(e) => updateSide({ page: { ...sideData.page, height_mm: Number(e.target.value) } })} className="w-14 px-1.5 py-1 border border-neutral-300 rounded text-neutral-800" />
          <span>mm</span>
        </div>

        <label className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-neutral-300 rounded-md cursor-pointer hover:bg-neutral-50">
          <Upload size={14} />
          Background
          <input type="file" accept="image/*" className="hidden" onChange={onBgUpload} />
        </label>

        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <input type="checkbox" checked={sideData.tint.enabled} onChange={(e) => updateTint({ enabled: e.target.checked })} />
          Tint background
        </label>
        <button onClick={() => setSelectedId(TINT_ID)} className={`flex items-center gap-1 text-xs px-2 py-1.5 border rounded-md ${selectedId === TINT_ID ? "border-blue-400 text-blue-700 bg-blue-50" : "border-neutral-300 hover:bg-neutral-50"}`}>
          <Droplet size={12} /> Tint colors
        </button>

        <button onClick={() => setSelectedId(BGMAP_ID)} className={`flex items-center gap-1 text-xs px-2 py-1.5 border rounded-md ${selectedId === BGMAP_ID ? "border-blue-400 text-blue-700 bg-blue-50" : "border-neutral-300 hover:bg-neutral-50"}`}>
          <ImageIcon size={12} /> Background images
        </button>

        <button onClick={() => setSelectedId(FONTS_ID)} className={`flex items-center gap-1 text-xs px-2 py-1.5 border rounded-md ${selectedId === FONTS_ID ? "border-blue-400 text-blue-700 bg-blue-50" : "border-neutral-300 hover:bg-neutral-50"}`}>
          <Type size={12} /> Fonts
        </button>

        <button onClick={() => setSelectedId(ROLEMAP_ID)} className={`flex items-center gap-1 text-xs px-2 py-1.5 border rounded-md ${selectedId === ROLEMAP_ID ? "border-blue-400 text-blue-700 bg-blue-50" : "border-neutral-300 hover:bg-neutral-50"}`}>
          <Users size={12} /> Role mapping
        </button>

        <div className="flex-1" />

        <button onClick={() => setShowData((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-neutral-300 rounded-md hover:bg-neutral-50">
          <Palette size={14} />
          Sample data
        </button>

        <label className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-neutral-300 rounded-md cursor-pointer hover:bg-neutral-50">
          <FileUp size={14} />
          Import
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importTemplate(file);
              e.target.value = "";
            }}
          />
        </label>

        <label className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-blue-400 bg-blue-50 text-blue-700 rounded-md cursor-pointer hover:bg-blue-100">
          <FileUp size={14} />
          Load WCIF JSON
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

        <button onClick={exportTemplate} className="flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 bg-neutral-900 text-white rounded-md hover:bg-neutral-800">
          <Download size={14} />
          Export template.json
        </button>

        <button
          onClick={generateAllBadges}
          disabled={!!generating}
          title={state.wcif ? `Generate badges for everyone in ${state.wcif.name || state.wcif.id}` : "Load a WCIF first"}
          className="flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Printer size={14} />
          {generating ? (generating.total ? `Generating ${generating.done}/${generating.total}…` : "Starting…") : "Generate PDF for all competitors"}
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
          <div onPointerDown={() => setSelectedId(null)} style={{ width: pw, height: ph, backgroundColor: "#ffffff", position: "relative" }} className="shadow-lg border border-neutral-300 rounded-sm overflow-hidden">
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
              <FieldBox key={f.id} field={f} scale={SCALE} selected={selectedId === f.id} sampleData={state.sampleData} onPointerDownMove={(e) => startDrag(e, f, "move")} onPointerDownResize={(e) => startDrag(e, f, "resize")} />
            ))}
            {guides.x !== null && (
              <div style={{ position: "absolute", left: guides.x * SCALE, top: 0, bottom: 0, width: 1, background: "#2563eb", pointerEvents: "none" }} />
            )}
            {guides.y !== null && (
              <div style={{ position: "absolute", top: guides.y * SCALE, left: 0, right: 0, height: 1, background: "#2563eb", pointerEvents: "none" }} />
            )}
          </div>
        </div>

        {showData ? (
          <DataPanel sampleData={state.sampleData} updateSampleValue={updateSampleValue} addSampleKey={addSampleKey} removeSampleKey={removeSampleKey} onClose={() => setShowData(false)} />
        ) : (
          <div className="w-80 bg-white border-l border-neutral-200 flex flex-col overflow-y-auto">
            <div className="p-4 border-b border-neutral-200">
              <div className="text-xs font-semibold text-neutral-500 mb-2">ADD FIELD</div>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(TYPE_META).map(([type, meta]) => {
                  const Icon = meta.icon;
                  return (
                    <button
                      key={type}
                      onClick={() => {
                        if (type === "schedule") {
                          handleAddSchedule();
                        } else {
                          addField(type);
                        }
                      }}
                      className="flex items-center gap-1.5 text-xs px-2 py-1.5 border border-neutral-300 rounded-md hover:bg-neutral-50"
                    >
                      <Plus size={12} />
                      <Icon size={13} />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="p-4 border-b border-neutral-200 max-h-48 overflow-y-auto">
              <div className="text-xs font-semibold text-neutral-500 mb-0.5">{side.toUpperCase()} FIELDS</div>
              <div className="text-[10px] text-neutral-400 mb-2">Drag to reorder, or use the arrows — top is frontmost</div>
              <div className="space-y-1">
                {[...fields].reverse().map((f, displayIdx, displayArr) => {
                  const Icon = TYPE_META[f.type].icon;
                  const fieldLabel = f.type === "text" ? (f.bindMode === "static" ? `"${(f.staticText || "").slice(0, 16)}"` : f.bindMode === "template" ? f.template || "(template)" : f.source) : TYPE_META[f.type].label;
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
                      onClick={() => setSelectedId(f.id)}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm cursor-pointer ${selectedId === f.id ? "bg-blue-50 text-blue-700" : "hover:bg-neutral-50 text-neutral-700"} ${draggingFieldId === f.id ? "opacity-40" : ""}`}
                    >
                      <GripVertical size={13} className="text-neutral-300 cursor-grab shrink-0" />
                      <Icon size={14} className="shrink-0" />
                      <span className="flex-1 truncate">{fieldLabel}</span>
                      <div className="flex flex-col shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            moveFieldInList(f.id, -1);
                          }}
                          disabled={displayIdx === 0}
                          className="text-neutral-400 hover:text-neutral-700 disabled:opacity-20 disabled:hover:text-neutral-400 leading-none"
                          title="Bring forward"
                        >
                          <ChevronUp size={13} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            moveFieldInList(f.id, 1);
                          }}
                          disabled={displayIdx === displayArr.length - 1}
                          className="text-neutral-400 hover:text-neutral-700 disabled:opacity-20 disabled:hover:text-neutral-400 leading-none"
                          title="Send backward"
                        >
                          <ChevronDown size={13} />
                        </button>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeField(f.id);
                        }}
                        className="text-neutral-400 hover:text-red-500 shrink-0"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
                {fields.length === 0 && <div className="text-xs text-neutral-400">No fields yet.</div>}
              </div>
            </div>

            {selectedId === TINT_ID && <TintPanel tint={sideData.tint} sampleData={state.sampleData} onChange={updateTint} />}
            {selectedId === BGMAP_ID && <BackgroundMapPanel bgMap={sideData.backgroundMap} sampleData={state.sampleData} onChange={updateBackgroundMap} />}
            {selectedId === FONTS_ID && (
              <FontsPanel
                fonts={state.fonts}
                onUpload={uploadFont}
                onRename={renameFontDisplay}
                onRemove={removeFont}
                onAddGooglePreset={addGoogleFontPreset}
                addingGoogleFont={addingGoogleFont}
              />
            )}
            {selectedId === ROLEMAP_ID && <RoleMappingPanel roleMapping={state.roleMapping} onChange={updateRoleMapping} />}
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
    </div>
  );
}

function FieldBox({ field, scale, selected, sampleData, onPointerDownMove, onPointerDownResize }) {
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

  const h = field.type === "schedule" ? scheduleHeightPx : field.type === "taskkey" ? taskKeyHeightPx : fieldBoxHeightMm(field) * scale;

  const style = {
    position: "absolute",
    left: field.x_mm * scale,
    top: field.y_mm * scale,
    width: field.type === "text" ? (textWraps ? w : "auto") : w,
    height: field.type === "text" ? "auto" : h,
    outline: selected ? "1.5px solid #2563eb" : "1px dashed rgba(0,0,0,0.25)",
    cursor: "move",
    userSelect: "none",
    transform: field.rotate ? `rotate(-${field.rotate}deg)` : undefined,
    transformOrigin: "top left",
  };

  let content;
  if (field.type === "text") {
    const isBuiltinBold = field.font === "Helvetica-Bold";
    const isCustom = !BUILTIN_FONTS.includes(field.font);
    const fontFamily = isCustom ? `"${field.font}", sans-serif` : "Helvetica, Arial, sans-serif";
    const fontWeight = isBuiltinBold ? 700 : 400;
    const fontSize = field.fontMode === "autofit" ? field.size_max : field.size;
    const value = resolveTextValue(field, sampleData);
    content = (
      <div
        style={{
          fontSize: fontSize * (scale / 2.6),
          fontWeight,
          fontFamily,
          color: field.color,
          lineHeight: field.lineHeight || 1.05,
          letterSpacing: `${(field.letterSpacing || 0) * (scale / 2.6)}px`,
          whiteSpace: textWraps ? "pre-wrap" : "pre-line",
          wordBreak: textWraps ? field.breakStyle || "break-word" : undefined,
          overflowWrap: textWraps ? "anywhere" : undefined,
          width: textWraps ? "100%" : undefined,
          textAlign: align,
          transform: textWraps ? undefined : anchorTransform(align),
          display: textWraps ? undefined : "inline-block",
        }}
      >
        {value}
      </div>
    );
  } else if (field.type === "image") {
    let src = field.preview;
    let label = field.path?.split("/").pop() || "image";
    if (field.mapped) {
      const m = resolveMapping(field, sampleData, "image");
      src = m ? m.preview : field.fallbackPreview;
      label = m ? m.path?.split("/").pop() : field.fallbackPath?.split("/").pop() || "no match";
    }
    content = src ? <img src={src} alt="" className="w-full h-full object-contain" /> : <div className="w-full h-full flex items-center justify-center bg-neutral-200/70 text-[9px] text-neutral-500 rounded text-center px-1">{label}</div>;
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
            <span className="w-10 h-full flex items-center justify-center shrink-0" style={{ borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>Time</span>
            <span className="flex-1 h-full flex items-center justify-center" style={{ borderRight: `1px solid ${SCHEDULE_COLORS.border}` }}>Event</span>
            <span className="w-9 h-full flex items-center justify-center shrink-0">Task</span>
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
                const isSpecial = r.isSpecial || /lunch|dinner|opening|awards|tutorial/i.test(r.event);
                const specialBg = /lunch|dinner/i.test(r.event) ? SCHEDULE_COLORS.lunchBg : SCHEDULE_COLORS.otherSpecialBg;

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
    <div style={style} onPointerDown={onPointerDownMove}>
      {content}
      {selected && (field.type !== "text" || textWraps) && (
        <div
          onPointerDown={onPointerDownResize}
          style={{ position: "absolute", right: -4, bottom: -4, width: 10, height: 10, background: "#2563eb", borderRadius: 2, cursor: field.type === "schedule" || field.type === "taskkey" ? "ew-resize" : "nwse-resize" }}
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

function RoleMappingPanel({ roleMapping, onChange }) {
  const rules = roleMapping.rules || [];

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
        Maps a competitor's WCIF role(s) to the "role" value used throughout the template (text, tint, background images, etc). Checked top to bottom — the first matching rule wins, since a person can hold more than one role at once (e.g. an organizer who's also judging). Anyone matching nothing below gets the fallback.
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
        <div className="text-[11px] text-neutral-500 mb-1">Fallback (no rule matched)</div>
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
                  <div className="text-[11px] text-neutral-500 mb-1">Raw value → displayed text (unmapped values show as-is). Enter for a line break in the display text.</div>
                  <div className="space-y-1.5">
                    {(field.valueMap || []).map((m, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <input value={m.value} onChange={(e) => updateValueMap(i, { value: e.target.value })} placeholder="raw value" className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0" />
                        <textarea value={m.label} onChange={(e) => updateValueMap(i, { label: e.target.value })} placeholder="display text" rows={1} className="flex-1 text-xs px-2 py-1 border border-neutral-300 rounded-md min-w-0 resize-y" />
                        <button onClick={() => removeValueMap(i)} className="text-neutral-400 hover:text-red-500 mt-1">
                          <Trash2 size={12} />
                        </button>
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

          <AlignField value={field.align} onChange={(v) => onChange({ align: v })} />

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
            </div>
          )}
          <NumField label="Letter spacing (pt)" value={field.letterSpacing || 0} onChange={(v) => onChange({ letterSpacing: v })} />
          <ColorField label="Color" value={field.color} onChange={(v) => onChange({ color: v })} />
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
              Names come from the loaded competition by default — edit any of them below to override just the label (color still follows the real stage).
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

function DataPanel({ sampleData, updateSampleValue, addSampleKey, removeSampleKey, onClose }) {
  return (
    <div className="w-80 bg-white border-l border-neutral-200 overflow-y-auto">
      <div className="flex items-center justify-between p-4 border-b border-neutral-200">
        <div className="text-sm font-semibold">Preview data</div>
        <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
          <X size={16} />
        </button>
      </div>
      <div className="p-4">
        <div className="text-xs font-semibold text-neutral-500 mb-2">SAMPLE BADGE DATA</div>
        <div className="text-[11px] text-neutral-400 mb-2">Used to preview this one badge. Color/image mappings, text value-mappings and templates live on each field — select a field to edit. Fonts live under the "Fonts" toolbar button.</div>
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

function ColorField({ label, value, onChange }) {
  return (
    <label className="block">
      <div className="text-[11px] text-neutral-500 mb-1">{label}</div>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-full h-8 border border-neutral-300 rounded-md cursor-pointer" />
    </label>
  );
}