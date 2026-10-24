import { Keyboard, X } from "lucide-react";

// "Ctrl" reads "⌘" on a Mac; the shortcuts accept either key everywhere.
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const SHORTCUT_GROUPS = [
  {
    title: "Edit",
    items: [
      [[MOD, "Z"], "Undo"],
      [[MOD, "Shift", "Z"], "Redo (also " + MOD + "+Y)"],
      [[MOD, "C"], "Copy"],
      [[MOD, "X"], "Cut"],
      [[MOD, "V"], "Paste — also images and text from other apps"],
      [[MOD, "D"], "Duplicate"],
      [["Delete"], "Delete (also Backspace)"],
    ],
  },
  {
    title: "Select & move",
    items: [
      [["Click"], "Select"],
      [["Shift", "Click"], "Add to / remove from the selection"],
      [["Drag on empty space"], "Select everything the box touches"],
      [[MOD, "A"], "Select all"],
      [["Esc"], "Deselect"],
      [["←↑→↓"], "Move 1 mm"],
      [["Shift", "←↑→↓"], "Move 10 mm"],
    ],
  },
  {
    title: "Order",
    items: [
      [[MOD, "]"], "Bring forward (also " + MOD + "+↑)"],
      [[MOD, "["], "Send backward (also " + MOD + "+↓)"],
      [[MOD, "Shift", "]"], "Bring to front (also " + MOD + "+Shift+↑)"],
      [[MOD, "Shift", "["], "Send to back (also " + MOD + "+Shift+↓)"],
    ],
  },
  {
    title: "View",
    items: [
      [[MOD, "+"], "Zoom in"],
      [[MOD, "−"], "Zoom out"],
      [[MOD, "0"], "Fit to screen"],
      [[MOD, "1"], "Actual size (100%)"],
      [[MOD, "Scroll"], "Zoom at the pointer"],
      [["Space", "Drag"], "Pan (also the middle mouse button)"],
    ],
  },
  {
    title: "File",
    items: [
      [[MOD, "S"], "Save template (template.json)"],
      [[MOD, "O"], "Open template"],
      [["?"], "Show these shortcuts"],
    ],
  },
];

export default function ShortcutsDialog({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onPointerDown={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <div className="flex items-center gap-2 font-semibold">
            <Keyboard size={16} /> Keyboard shortcuts
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700" title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-5 px-5 py-4">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 mb-2">{group.title}</div>
              <div className="space-y-1.5">
                {group.items.map(([keys, label]) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-neutral-700">{label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {keys.map((k) => (
                        <kbd key={k} className="text-[11px] px-1.5 py-0.5 rounded border border-neutral-300 bg-neutral-50 text-neutral-600 font-sans">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
