// Fonts ready to use without uploading anything: picked from Google Fonts
// and only downloaded when someone chooses one. A chosen font is then
// stored in the template like an uploaded one (see loadLibraryFont in
// BadgeDesigner.jsx), so the PDF and the saved template don't need the
// internet afterwards.
//
// Each entry is one weight of a family, registered under its own family
// name (libraryFamily) — separate from the tiny preview subsets loaded by
// loadLibraryPreviews, which only contain the letters of the names.

const FAMILIES = [
  // [category, family, weights]
  ["Sans serif", "Inter", [400, 700, 900]],
  ["Sans serif", "Roboto", [400, 700]],
  ["Sans serif", "Open Sans", [400, 700]],
  ["Sans serif", "Lato", [400, 900]],
  ["Sans serif", "Montserrat", [400, 700, 900]],
  ["Sans serif", "Poppins", [400, 600, 800]],
  ["Sans serif", "Rubik", [400, 700]],
  ["Sans serif", "Nunito", [400, 800]],
  ["Sans serif", "Work Sans", [400, 700]],
  ["Sans serif", "Raleway", [400, 800]],
  ["Sans serif", "Titillium Web", [400, 700]],
  ["Sans serif", "Kanit", [400, 700]],
  ["Sans serif", "Exo 2", [400, 800]],
  ["Condensed", "Oswald", [400, 700]],
  ["Condensed", "Barlow Condensed", [600, 800]],
  ["Condensed", "Bebas Neue", [400]],
  ["Condensed", "Anton", [400]],
  ["Condensed", "Fjalla One", [400]],
  ["Serif", "Playfair Display", [400, 700]],
  ["Serif", "Merriweather", [400, 900]],
  ["Serif", "Lora", [400, 700]],
  ["Serif", "Roboto Slab", [400, 700]],
  ["Serif", "Libre Baskerville", [400, 700]],
  ["Serif", "Cinzel", [400, 700, 900]],
  ["Display", "Archivo Black", [400]],
  ["Display", "Russo One", [400]],
  ["Display", "Righteous", [400]],
  ["Display", "Bungee", [400]],
  ["Display", "Orbitron", [400, 900]],
  ["Display", "Audiowide", [400]],
  ["Display", "Black Ops One", [400]],
  ["Display", "Press Start 2P", [400]],
  ["Handwriting", "Permanent Marker", [400]],
  ["Handwriting", "Lobster", [400]],
  ["Handwriting", "Pacifico", [400]],
  ["Handwriting", "Caveat", [400, 700]],
  ["Monospace", "Roboto Mono", [400, 700]],
  ["Monospace", "Source Code Pro", [400, 700]],
];

const WEIGHT_NAMES = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

export const FONT_LIBRARY = FAMILIES.flatMap(([category, family, weights]) =>
  weights.map((weight) => ({
    id: `${family}-${weight}`,
    family,
    weight,
    category,
    label: weights.length > 1 || weight !== 400 ? `${family} ${WEIGHT_NAMES[weight] || weight}`.trim() : family,
  }))
);

export const FONT_LIBRARY_CATEGORIES = [...new Set(FAMILIES.map(([category]) => category))];

// The family name a library font is registered under once loaded (its
// field.font value), e.g. "lib-Montserrat-700".
export function libraryFamily(entry) {
  return `lib-${entry.family.replace(/\s+/g, "")}-${entry.weight}`;
}

// One Google Fonts stylesheet with just the letters of the library's names,
// in every family and weight, so the picker can show each name in its own
// font for a few KB instead of downloading every font.
export function libraryPreviewUrl() {
  const byFamily = new Map();
  for (const e of FONT_LIBRARY) byFamily.set(e.family, [...(byFamily.get(e.family) || []), e.weight]);
  const families = [...byFamily].map(([family, weights]) => `family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${[...new Set(weights)].sort((a, b) => a - b).join(";")}`);
  const letters = [...new Set(FONT_LIBRARY.map((e) => e.label).join(""))].join("");
  return `https://fonts.googleapis.com/css2?${families.join("&")}&text=${encodeURIComponent(letters)}&display=swap`;
}

export function loadLibraryPreviews() {
  if (typeof document === "undefined" || document.getElementById("font-library-previews")) return;
  const link = document.createElement("link");
  link.id = "font-library-previews";
  link.rel = "stylesheet";
  link.href = libraryPreviewUrl();
  document.head.appendChild(link);
}
