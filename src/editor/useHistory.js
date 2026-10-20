import { useCallback, useRef, useState } from "react";

// Undo/redo for the editor's document state.
//
// setDoc(updater, key) works like a React state setter (a value or a
// function of the previous state) and records the previous state so undo
// can go back to it. Edits that belong together share a key and become a
// single history entry:
// - "gesture:…" keys (one drag, one resize) always merge, however long the
//   gesture takes;
// - any other key merges with the previous edit when it has the same key
//   and comes within MERGE_MS — e.g. typing into one property box.
// Edits without a key are always their own entry.
//
// The state lives in a ref as well as in React state so that several
// setDoc calls in one tick each see the previous one's result, and so the
// history bookkeeping happens outside React's updater functions (which
// StrictMode runs twice).

const LIMIT = 200;
const MERGE_MS = 1200;

export function useHistory(initial) {
  const [view, setView] = useState(() => ({ doc: typeof initial === "function" ? initial() : initial, canUndo: false, canRedo: false }));
  const current = useRef(view.doc);
  const stacks = useRef({ past: [], future: [], lastKey: null, lastTime: 0 });

  const publish = useCallback(() => {
    const h = stacks.current;
    setView({ doc: current.current, canUndo: h.past.length > 0, canRedo: h.future.length > 0 });
  }, []);

  const setDoc = useCallback(
    (updater, key) => {
      const prev = current.current;
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next === prev) return;
      const h = stacks.current;
      const now = Date.now();
      const merge = key && key === h.lastKey && (key.startsWith("gesture:") || now - h.lastTime < MERGE_MS);
      if (!merge) {
        h.past.push(prev);
        if (h.past.length > LIMIT) h.past.shift();
      }
      h.future = [];
      h.lastKey = key || null;
      h.lastTime = now;
      current.current = next;
      publish();
    },
    [publish]
  );

  const jump = useCallback(
    (from, to) => {
      const h = stacks.current;
      if (h[from].length === 0) return false;
      h[to].push(current.current);
      current.current = h[from].pop();
      h.lastKey = null;
      publish();
      return true;
    },
    [publish]
  );
  const undo = useCallback(() => jump("past", "future"), [jump]);
  const redo = useCallback(() => jump("future", "past"), [jump]);

  return { doc: view.doc, setDoc, undo, redo, canUndo: view.canUndo, canRedo: view.canRedo };
}
