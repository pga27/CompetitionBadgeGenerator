// Image cropping, shared by the editor preview (BadgeDesigner.jsx) and PDF
// generation (pdfExport.js) so both show exactly the same part of the
// image in the same place.
//
// An image field keeps `crop` — the part of the source image to use, as
// fractions of its width/height ({ x, y, w, h }, default the whole image) —
// and `fit`, how that part goes into the field's box:
// - "contain" (Fit): all of it, scaled to fit, centered (the original behavior).
// - "cover" (Fill): fills the box; whatever doesn't match the box's shape
//   is trimmed equally from both sides.
// - "stretch": fills the box, ignoring proportions.

export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

export function normalizeCrop(crop) {
  const c = { ...FULL_CROP, ...(crop || {}) };
  const x = Math.min(Math.max(c.x, 0), 1);
  const y = Math.min(Math.max(c.y, 0), 1);
  return { x, y, w: Math.min(Math.max(c.w, 0.01), 1 - x), h: Math.min(Math.max(c.h, 0.01), 1 - y) };
}

export function isFullCrop(crop) {
  const c = normalizeCrop(crop);
  return c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
}

/**
 * Where an image goes in a box. imgW/imgH: the source's pixel size; boxW/
 * boxH: the box, in any unit. Returns the source rectangle to take (sx, sy,
 * sw, sh, in source pixels) and where it lands in the box (dx, dy, dw, dh,
 * in box units, from the box's top-left).
 */
export function placeImage(imgW, imgH, crop, fit, boxW, boxH) {
  const c = normalizeCrop(crop);
  let sx = c.x * imgW;
  let sy = c.y * imgH;
  let sw = c.w * imgW;
  let sh = c.h * imgH;
  const boxAspect = boxW / boxH;

  if (fit === "cover") {
    // Trim the cropped part to the box's shape, keeping its center.
    if (sw / sh > boxAspect) {
      const nw = sh * boxAspect;
      sx += (sw - nw) / 2;
      sw = nw;
    } else {
      const nh = sw / boxAspect;
      sy += (sh - nh) / 2;
      sh = nh;
    }
    return { sx, sy, sw, sh, dx: 0, dy: 0, dw: boxW, dh: boxH };
  }
  if (fit === "stretch") return { sx, sy, sw, sh, dx: 0, dy: 0, dw: boxW, dh: boxH };

  // contain
  const aspect = sw / sh;
  const dw = aspect > boxAspect ? boxW : boxH * aspect;
  const dh = aspect > boxAspect ? boxW / aspect : boxH;
  return { sx, sy, sw, sh, dx: (boxW - dw) / 2, dy: (boxH - dh) / 2, dw, dh };
}
