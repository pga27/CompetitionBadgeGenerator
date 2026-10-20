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
//   size_max that fits the frame without splitting any word in two. Only
//   if nothing fits even at size_min do lines also break after hyphens,
//   and only if that doesn't fit either are words split, per break style.
//   With wrap_below set, shrinking first tries to keep the text on a
//   single line down to that size, and only then breaks it into more lines
//   (which may let it grow back up to size_max).
// - max_lines: 0 = as many as fit.
// - min_lines: put the text on at least this many lines when it has
//   somewhere to break, with the words shared out evenly between them
//   ("RUBÉN LÓPEZ" / "DE JUAN"); a single unbreakable word stays one line.
// - auto_height: the frame grows with its text instead of having a height.
// - overflow, for text that still doesn't fit: "visible" (draw it all),
//   "clip" (drop the lines that fall outside), "ellipsis" (same, ending the
//   last line with "…").
// - v_align top/middle/bottom and padding_mm (inset on every side).
//   Vertical alignment goes by the letters, not the line boxes: from the
//   top of the capitals on the first line to the baseline of the last one
//   (capHeight = cap height / font size, from the font). "middle" leaves
//   the same space above the capitals as below the last baseline, so names
//   in capitals look centered; lowercase descenders hang below that.
//   The layout returns each line's baseline, so both renderers put every
//   line in exactly the same place regardless of how they size line boxes.

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
  min_lines: 1,
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
// kept. "break-word" breaks at spaces and after hyphens, and only splits a
// word that can't fit on a line of its own; "break-all" may split anywhere.
export function wrapText(text, size, maxWidth, measure, breakStyle = "break-word") {
  return wrapTextInfo(text, size, maxWidth, measure, breakStyle, true).lines;
}

// wrapText, plus whether some word had to be split across lines. With
// hyphens false, "break-word" breaks at spaces only.
function wrapTextInfo(text, size, maxWidth, measure, breakStyle, hyphens) {
  const lines = [];
  let splitWord = false;
  const fitsWidth = (s) => measure(s, size) <= maxWidth;

  // Pushes as many leading characters of `word` as fit on a line, repeatedly.
  const splitLongWord = (word) => {
    let rest = word;
    while (rest && !fitsWidth(rest)) {
      splitWord = true;
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
    const pieces = hyphens ? breakPoints(paragraph) : paragraph.split(" ").map((word, i) => ({ text: word, sep: i > 0 ? " " : "" }));
    for (const { text: piece, sep } of pieces) {
      const trial = current ? `${current}${sep}${piece}` : piece;
      if (fitsWidth(trial)) {
        current = trial;
      } else {
        if (current) lines.push(current);
        current = splitLongWord(piece);
      }
    }
    lines.push(current);
  }
  return { lines, splitWord };
}

// The pieces a line may break between: words (joined back with a space)
// and, inside a hyphenated word, the parts after each hyphen (joined with
// nothing), so "García-Pérez" can break as "García-" / "Pérez". Breaking
// there doesn't count as splitting a word.
export function breakPoints(paragraph) {
  const pieces = [];
  paragraph.split(" ").forEach((word, i) => {
    const parts = word.match(/[^-‐–]*[-‐–]+|[^-‐–]+$/g) || [word];
    parts.forEach((part, j) => pieces.push({ text: part, sep: j > 0 ? "" : i > 0 ? " " : "" }));
  });
  return pieces;
}

// `text` split into `count` lines (fewer if it has fewer break points) with
// the words shared out as evenly as possible — the split whose widest line
// is narrowest. Null when there's nothing to split (one word, or text with
// its own line breaks).
function balancedLines(text, count, size, measure, hyphens) {
  if (text.includes("\n")) return null;
  const pieces = hyphens ? breakPoints(text) : text.split(" ").map((word, i) => ({ text: word, sep: i > 0 ? " " : "" }));
  if (pieces.length < 2) return null;
  const k = Math.min(count, pieces.length);
  const join = (from, to) => pieces.slice(from, to).map((p, i) => (i > 0 ? p.sep : "") + p.text).join("");
  const memo = new Map();
  // Best split of pieces[from..] into n lines: { width of its widest line, line ends }.
  const best = (from, n) => {
    const key = `${from}:${n}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (n === 1) {
      result = { width: measure(join(from, pieces.length), size), ends: [pieces.length] };
    } else {
      result = { width: Infinity, ends: [] };
      for (let to = from + 1; to <= pieces.length - (n - 1); to++) {
        const rest = best(to, n - 1);
        const width = Math.max(measure(join(from, to), size), rest.width);
        if (width < result.width) result = { width, ends: [to, ...rest.ends] };
      }
    }
    memo.set(key, result);
    return result;
  };
  let from = 0;
  return best(0, k).ends.map((to) => {
    const line = join(from, to);
    from = to;
    return line;
  });
}

/**
 * Lays out `text` in a frame. Returns { size, lines, lineHeight,
 * blockHeight, baselines, overflow, padding, innerW }: font size in pt,
 * the lines to draw, the distance between them, the height the lines take
 * (what auto height grows to), each line's baseline measured down from the
 * frame's inner top (padding excluded), and whether the text didn't fit.
 */
export function layoutTextFrame(text, frame, { measure, lineHeight = 1.05, breakStyle = "break-word", fixedSize = 12, capHeight = 0.72 }) {
  const f = { ...DEFAULT_FRAME, ...frame };
  const pad = (f.padding_mm || 0) * MM_TO_PT;
  const innerW = Math.max(f.w_mm * MM_TO_PT - 2 * pad, 1);
  const innerH = f.auto_height ? Infinity : Math.max(f.h_mm * MM_TO_PT - 2 * pad, 1);
  const maxLines = f.max_lines > 0 ? f.max_lines : Infinity;

  const minLines = Math.min(Math.max(f.min_lines || 1, 1), maxLines);
  // How many lines min_lines can actually ask for: no more than the text
  // has pieces to break into, counting hyphens (so a lone "GARCÍA-PÉREZ"
  // still gets its two lines, once spaces alone can't give them).
  const reachableLines = text.includes("\n") ? 1 : Math.min(minLines, breakPoints(text).length);

  // Wrapped lines at `size`; when that gives fewer than min_lines, the
  // words shared out evenly over min_lines lines instead (tooWide if one
  // of those lines is still wider than the frame).
  const linesAt = (size, style = breakStyle, hyphens = true) => {
    const r = wrapTextInfo(text, size, innerW, measure, style, hyphens);
    if (r.lines.length >= minLines) return r;
    const balanced = balancedLines(text, minLines, size, measure, hyphens);
    if (!balanced) return r;
    return { lines: balanced, splitWord: false, tooWide: balanced.some((l) => measure(l, size) > innerW) };
  };
  const heightOf = (n, size) => n * size * lineHeight;
  const fits = (lines, size, allowedLines) => lines.length <= allowedLines && heightOf(lines.length, size) <= innerH + 0.01;

  let size;
  let lines;
  let found = false;
  let usedHyphens = true; // whether the chosen lines may break after hyphens
  let wholeWordLayout = false; // whether they break only between pieces (no split words)
  if (f.fit === "shrink") {
    const max = Math.max(f.size_max, f.size_min);
    const min = Math.min(f.size_max, f.size_min);
    const singleLineFloor = f.wrap_below > 0 ? Math.min(Math.max(f.wrap_below, min), max) : min;
    // wholeWords: only accept sizes where every word stays whole; otherwise
    // words may be split per the break style. hyphens: whether lines may
    // also break after a hyphen ("GARCÍA-" / "PÉREZ").
    const search = (style, wholeWords, hyphens) => {
      const ok = (r, s, allowed) => fits(r.lines, s, allowed) && !(wholeWords && r.splitWord) && !r.tooWide && r.lines.length >= reachableLines;
      // 1. One line, from the biggest size down to the wrap threshold
      // (skipped when at least two lines are required).
      for (let s = max; minLines === 1 && s >= singleLineFloor - 1e-9 && !found; s -= SIZE_STEP) {
        const r = linesAt(s, style, hyphens);
        if (ok(r, s, 1)) [size, lines, found, wholeWordLayout] = [s, r.lines, true, wholeWords && !r.splitWord];
      }
      // 2. Then as many lines as allowed, again from the biggest size.
      for (let s = max; s >= min - 1e-9 && !found; s -= SIZE_STEP) {
        const r = linesAt(s, style, hyphens);
        if (ok(r, s, maxLines)) [size, lines, found, wholeWordLayout] = [s, r.lines, true, wholeWords && !r.splitWord];
      }
      if (found) usedHyphens = hyphens;
    };
    // Least to most invasive, each only if the previous fits at no size:
    // breaking at spaces only, then also after hyphens (a hyphenated
    // surname too long for a line even at the minimum size), then
    // splitting words per the break style.
    search("break-word", true, false);
    if (!found) search("break-word", true, true);
    if (!found) search(breakStyle, false, true);
    if (!found) [size, lines] = [min, linesAt(min).lines];
  } else {
    size = fixedSize;
    // Same order at a fixed size: after a hyphen only if some word would
    // otherwise have to be split.
    const spacesOnly = linesAt(size, breakStyle, false);
    const useHyphens = spacesOnly.splitWord || spacesOnly.tooWide;
    const r = useHyphens ? linesAt(size) : spacesOnly;
    // Even lines too wide for the frame: fall back to plain wrapping.
    lines = r.tooWide ? wrapTextInfo(text, size, innerW, measure, breakStyle, true).lines : r.lines;
    usedHyphens = useHyphens;
    wholeWordLayout = !r.tooWide && !r.splitWord;
    found = fits(lines, size, maxLines);
  }

  // With min_lines on, share the words out evenly over however many lines
  // were chosen ("RUBÉN LÓPEZ DE" / "JUAN" -> "RUBÉN LÓPEZ" / "DE JUAN").
  // Its widest line is never wider than the original's, so it still fits.
  if (minLines > 1 && wholeWordLayout && lines.length > 1) {
    const balanced = balancedLines(text, lines.length, size, measure, usedHyphens);
    if (balanced && balanced.length === lines.length) lines = balanced;
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
  const step = size * lineHeight;
  const cap = capHeight * size;
  // Letters span from the first line's cap top to the last line's baseline.
  const inkHeight = Math.max(lines.length - 1, 0) * step + cap;
  const boxH = Number.isFinite(innerH) ? innerH : blockHeight;
  let capTop = 0;
  if (f.v_align === "middle") capTop = (boxH - inkHeight) / 2;
  else if (f.v_align === "bottom") capTop = boxH - inkHeight;
  if (f.auto_height) capTop = (blockHeight - inkHeight) / 2; // grows with the text: keep it centered in its own lines
  const baselines = lines.map((_, i) => capTop + cap + i * step);

  return { size, lines, lineHeight: step, blockHeight, baselines, overflow, padding: pad, innerW };
}

// Point-text auto-fit (the older, single-anchor text mode): the largest
// size between min and max at which every line is at most maxWidth wide.
export function shrinkToWidth(text, { min, max, maxWidth, measure }) {
  let size = max;
  const widest = (s) => Math.max(...text.split("\n").map((line) => measure(line, s)));
  while (widest(size) > maxWidth && size > min) size -= SIZE_STEP;
  return size;
}
