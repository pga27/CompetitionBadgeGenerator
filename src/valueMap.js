// "Map displayed value" for text fields: a raw value (e.g. role "delegate")
// shown as different text (e.g. "DELEGADO"). With gender variants on, an
// entry can also give the text to use for women (label_f) and men
// (label_m) — WCIF genders are "f", "m" and "o"; anyone else, or an empty
// variant, gets the entry's main label.
export function pickMappedLabel(entry, gender, genderVariants) {
  if (genderVariants) {
    if (gender === "f" && entry.label_f) return entry.label_f;
    if (gender === "m" && entry.label_m) return entry.label_m;
  }
  return entry.label;
}
