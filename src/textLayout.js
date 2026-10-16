// Text frame layout, shared by the editor preview (BadgeDesigner.jsx) and
// PDF generation (pdfExport.js) so both break lines and pick font sizes the
// same way. Everything here is in points; the caller supplies `measure`,
// which returns a string's width in points at a given size (letter spacing
// included) — canvas measureText in the browser preview, the embedded PDF
// fonts' metrics in pdfExport.js.
//
// A text frame works like frame text in Affinity: a fixed-width box whose
// text wraps inside it, with:
// - fit "fixed": one size; "shrink": the largest size between size_min and
//   size_max that fits the frame. With wrap_below set, shrinking first tries
//   to keep the text on a single line down to that size, and only then
//   breaks it into more lines (which may let it grow back up to size_max).
// - max_lines: 0 = as many as fit.
// - auto_height: the frame grows with its text instead of having a height.
// - overflow, for text that still doesn't fit: "visible" (draw it all),
//   "clip" (drop the lines that fall outside), "ellipsis" (same, ending the
//   last line with "…").
// - v_align top/middle/bottom and padding_mm (inset on every side).

const SIZE_STEP = 0.5;
const MM_TO_PT = 72 / 25.4;
const ELLIPSIS = "…";

export const DEFAULT_FRAME = {
  w_mm: 60,
  h_mm: 15,
  auto_height: false,
  fit: "shrink",
  size_min: 8,
  size_max: 24,
  wrap_below: 0,
  max_lines: 0,
  v_align: "top",
  padding_mm: 0,
  overflow: "visible",
};

export function applyTextCase(text, textCase) {
  if (textCase === "upper") return text.toUpperCase();
  if (textCase === "lower") return text.toLowerCase();
  if (textCase === "title") return text.toLowerCase().replace(/(^|[\s\-'(])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  return text;
}

// Splits `text` into lines no wider than maxWidth. Hard "\n" breaks are
// kept. "break-word" breaks at spaces and only splits a word that can't fit
// on a line of its own; "break-all" may split anywhere.
export function wrapText(text, size, maxWidth, measure, breakStyle = "break-word") {
  const lines = [];
  const fitsWidth = (s) => measure(s, size) <= maxWidth;

  // Pushes as many leading characters of `word` as fit on a line, repeatedly.
  const splitLongWord = (word) => {
    let rest = word;
    while (rest && !fitsWidth(rest)) {
      let n = 1;
      while (n < rest.length && fitsWidth(rest.slice(0, n + 1))) n++;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    return rest;
  };

  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    if (breakStyle === "break-all") {
      const rest = splitLongWord(paragraph);
      if (rest) lines.push(rest);
      continue;
    }
    let current = "";
    for (const word of paragraph.split(" ")) {
      const trial = current ? `${current} ${word}` : word;
      if (fitsWidth(trial)) {
        current = trial;
      } else {
        if (current) lines.push(current);
        current = splitLongWord(word);
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Lays out `text` in a frame. Returns { size, lines, lineHeight,
 * blockHeight, offsetY, overflow }: font size in pt, the lines to draw,
 * the distance between their tops, the drawn block's height, how far below
 * the frame's top inset the first line starts (vertical alignment), and
 * whether the text didn't fit.
 */
export function layoutTextFrame(text, frame, { measure, lineHeight = 1.05, breakStyle = "break-word", fixedSize = 12 }) {
  const f = { ...DEFAULT_FRAME, ...frame };
  const pad = (f.padding_mm || 0) * MM_TO_PT;
  const innerW = Math.max(f.w_mm * MM_TO_PT - 2 * pad, 1);
  const innerH = f.auto_height ? Infinity : Math.max(f.h_mm * MM_TO_PT - 2 * pad, 1);
  const maxLines = f.max_lines > 0 ? f.max_lines : Infinity;

  const linesAt = (size) => wrapText(text, size, innerW, measure, breakStyle);
  const heightOf = (n, size) => n * size * lineHeight;
  const fits = (lines, size, allowedLines) => lines.length <= allowedLines && heightOf(lines.length, size) <= innerH + 0.01;

  let size;
  let lines;
  let found = false;
  if (f.fit === "shrink") {
    const max = Math.max(f.size_max, f.size_min);
    const min = Math.min(f.size_max, f.size_min);
    const singleLineFloor = f.wrap_below > 0 ? Math.min(Math.max(f.wrap_below, min), max) : min;
    // 1. One line, from the biggest size down to the wrap threshold.
    for (let s = max; s >= singleLineFloor - 1e-9 && !found; s -= SIZE_STEP) {
      const l = linesAt(s);
      if (fits(l, s, 1)) [size, lines, found] = [s, l, true];
    }
    // 2. Then as many lines as allowed, again from the biggest size.
    for (let s = max; s >= min - 1e-9 && !found; s -= SIZE_STEP) {
      const l = linesAt(s);
      if (fits(l, s, maxLines)) [size, lines, found] = [s, l, true];
    }
    if (!found) [size, lines] = [min, linesAt(min)];
  } else {
    size = fixedSize;
    lines = linesAt(size);
    found = fits(lines, size, maxLines);
  }

  const overflow = !found;
  if (overflow && f.overflow !== "visible") {
    let keep = Math.min(lines.length, maxLines);
    while (keep > 1 && heightOf(keep, size) > innerH + 0.01) keep--;
    if (keep < lines.length) {
      lines = lines.slice(0, keep);
      if (f.overflow === "ellipsis" && keep > 0) {
        let last = lines[keep - 1];
        while (last && measure(last + ELLIPSIS, size) > innerW) last = last.slice(0, -1);
        lines[keep - 1] = last.trimEnd() + ELLIPSIS;
      }
    }
  }

  const blockHeight = heightOf(lines.length, size);
  let offsetY = 0;
  if (Number.isFinite(innerH) && blockHeight < innerH) {
    if (f.v_align === "middle") offsetY = (innerH - blockHeight) / 2;
    else if (f.v_align === "bottom") offsetY = innerH - blockHeight;
  }

  return { size, lines, lineHeight: size * lineHeight, blockHeight, offsetY, overflow, padding: pad, innerW };
}

// Point-text auto-fit (the older, single-anchor text mode): the largest
// size between min and max at which every line is at most maxWidth wide.
export function shrinkToWidth(text, { min, max, maxWidth, measure }) {
  let size = max;
  const widest = (s) => Math.max(...text.split("\n").map((line) => measure(line, s)));
  while (widest(size) > maxWidth && size > min) size -= SIZE_STEP;
  return size;
}
