import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import { FONT_LIBRARY, FONT_LIBRARY_CATEGORIES, libraryFamily, loadLibraryPreviews } from "../fontLibrary.js";

// The two fonts every PDF has without embedding anything.
const STANDARD = [
  { family: "Helvetica", label: "Helvetica", css: { fontFamily: "Helvetica, Arial, sans-serif", fontWeight: 400 } },
  { family: "Helvetica-Bold", label: "Helvetica Bold", css: { fontFamily: "Helvetica, Arial, sans-serif", fontWeight: 700 } },
];

// How to draw a font's name in that same font.
function sampleStyle(family, fonts) {
  const std = STANDARD.find((f) => f.family === family);
  if (std) return std.css;
  if (fonts.some((f) => f.family === family)) return { fontFamily: `"${family}", sans-serif` };
  return {};
}

function fontDisplayName(family, fonts) {
  return STANDARD.find((f) => f.family === family)?.label || fonts.find((f) => f.family === family)?.displayName || family;
}

// Font chooser for text fields: imported fonts, the two standard PDF fonts
// and the font library, each name shown in its own font. Picking a library
// font downloads it first (loadLibraryFont resolves to its family name, or
// null if that failed).
export default function FontPicker({ value, fonts, onChange, loadLibraryFont }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loadingId, setLoadingId] = useState(null);

  useEffect(() => {
    if (open) loadLibraryPreviews();
  }, [open]);

  const imported = fonts.filter((f) => !f.library);
  const q = query.trim().toLowerCase();
  const matches = (label) => !q || label.toLowerCase().includes(q);

  const pickLibrary = async (entry) => {
    setLoadingId(entry.id);
    const family = await loadLibraryFont(entry);
    setLoadingId(null);
    if (family) {
      onChange(family);
      setOpen(false);
    }
  };

  const row = (key, label, style, selected, onPick, extra) => (
    <button key={key} onClick={onPick} className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-blue-50 ${selected ? "bg-blue-50" : ""}`}>
      <span className="flex-1 truncate text-[15px] leading-tight" style={style}>
        {label}
      </span>
      {extra}
      {selected && <Check size={14} className="text-blue-600 shrink-0" />}
    </button>
  );
  const heading = (text) => <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{text}</div>;

  return (
    <div className="relative">
      <div className="text-[11px] text-neutral-500 mb-1">Font</div>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-2.5 py-1.5 border border-neutral-300 rounded-md text-left hover:bg-neutral-50">
        <span className="flex-1 truncate text-[15px]" style={sampleStyle(value, fonts)}>
          {fontDisplayName(value, fonts)}
        </span>
        <ChevronDown size={14} className="text-neutral-400 shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onPointerDown={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-white rounded-lg shadow-xl border border-neutral-200 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-neutral-100">
              <Search size={14} className="text-neutral-400" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search fonts" className="flex-1 text-sm outline-none min-w-0" />
            </div>
            <div className="max-h-80 overflow-y-auto pb-1">
              {imported.some((f) => matches(f.displayName)) && (
                <>
                  {heading("Imported")}
                  {imported
                    .filter((f) => matches(f.displayName))
                    .map((f) =>
                      row(f.family, f.displayName, f.needsReupload ? {} : { fontFamily: `"${f.family}", sans-serif` }, value === f.family, () => {
                        onChange(f.family);
                        setOpen(false);
                      })
                    )}
                </>
              )}
              {STANDARD.some((f) => matches(f.label)) && (
                <>
                  {heading("Standard")}
                  {STANDARD.filter((f) => matches(f.label)).map((f) =>
                    row(f.family, f.label, f.css, value === f.family, () => {
                      onChange(f.family);
                      setOpen(false);
                    })
                  )}
                </>
              )}
              {FONT_LIBRARY_CATEGORIES.map((category) => {
                const entries = FONT_LIBRARY.filter((e) => e.category === category && matches(e.label));
                if (entries.length === 0) return null;
                return (
                  <div key={category}>
                    {heading(category)}
                    {entries.map((entry) => {
                      const family = libraryFamily(entry);
                      const loaded = fonts.some((f) => f.family === family);
                      // Loaded: the full font. Not yet: the preview with just these letters.
                      const style = loaded ? { fontFamily: `"${family}", sans-serif` } : { fontFamily: `"${entry.family}", sans-serif`, fontWeight: entry.weight };
                      return row(
                        entry.id,
                        entry.label,
                        style,
                        value === family,
                        () => (loadingId ? null : pickLibrary(entry)),
                        loadingId === entry.id ? <Loader2 size={14} className="animate-spin text-neutral-400 shrink-0" /> : null
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
