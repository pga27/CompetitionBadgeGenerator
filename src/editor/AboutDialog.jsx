import { BadgeCheck, ExternalLink, X } from "lucide-react";

// Who made what. Keep in step with the "Credits" section of README.md.
const PEOPLE = [
  {
    name: "Pedro Azevedo",
    role: "Creator",
    url: "https://github.com/pga27",
    handle: "pga27",
    did: [
      "Created Competition Badge Generator and its badge designer: text, images, color blocks, QR codes, schedule tables and the task key",
      "Loading a competition's WCIF, with each person's schedule and tasks",
      "Values driven by role or country, including country flags",
      "Template save and load",
      "Print-ready PDF generation, with font fallback for names in other scripts",
    ],
  },
  {
    name: "Rubén López de Juan",
    role: "Collaborator",
    url: "https://github.com/ruben-lopez-dejuan",
    handle: "ruben-lopez-dejuan",
    did: [
      "Stages in WCIF schedules and printable stage colors",
      "Schedule options: renaming events and activities, the MBLD cube submission task, one row per round",
      "Text frames (shrink to fit, line breaking, vertical centering, min/max lines) and image cropping",
      "Per-value text colors, gender variants and role combinations",
      "The editor's redesign: layout, undo/redo, multi-select, zoom, keyboard shortcuts and clipboard",
      "Loading a competition by its WCA ID, and the Windows launcher",
    ],
  },
];

export default function AboutDialog({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onPointerDown={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <div className="flex items-center gap-2 font-semibold">
            <BadgeCheck size={18} className="text-blue-600" /> Competition Badge Generator
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700" title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-5">
          <p className="text-sm text-neutral-600">Design badges for WCA competitions and print one for every competitor, with their own schedule and tasks.</p>
          {PEOPLE.map((p) => (
            <div key={p.name}>
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <span className="font-semibold">{p.name}</span>
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600">{p.role}</span>
                </div>
                <a href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-600 hover:underline shrink-0">
                  github.com/{p.handle} <ExternalLink size={11} />
                </a>
              </div>
              <ul className="mt-1.5 space-y-1 text-sm text-neutral-600 list-disc pl-5">
                {p.did.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
