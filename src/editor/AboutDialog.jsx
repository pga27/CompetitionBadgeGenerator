import { BadgeCheck, ExternalLink, X } from "lucide-react";

// Keep in step with the "Credits" section of README.md.
const PEOPLE = [
  { name: "Pedro Azevedo", role: "Creator", url: "https://github.com/pga27", handle: "pga27" },
  { name: "Rubén López de Juan", role: "Collaborator", url: "https://github.com/ruben-lopez-dejuan", handle: "ruben-lopez-dejuan" },
];

export default function AboutDialog({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onPointerDown={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <div className="flex items-center gap-2 font-semibold">
            <BadgeCheck size={18} className="text-blue-600" /> Competition Badge Generator
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700" title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-neutral-600">Design badges for WCA competitions and print one for every competitor, with their own schedule and tasks.</p>
          <div className="space-y-2.5">
            {PEOPLE.map((p) => (
              <div key={p.name} className="flex items-center justify-between gap-3">
                <div>
                  <span className="font-semibold">{p.name}</span>
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600">{p.role}</span>
                </div>
                <a href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-600 hover:underline shrink-0">
                  github.com/{p.handle} <ExternalLink size={11} />
                </a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
