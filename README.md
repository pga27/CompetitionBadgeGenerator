# Competition Badge Generator

Design badges for WCA competitions and print one for every competitor, each with their own name, role, schedule and tasks.

- A visual editor for the badge (front and back): text, images, color blocks, QR codes, schedule tables and a task key.
- Load a competition by its WCA ID, or open a WCIF file, to preview its schedule and generate everyone's badges.
- Exports a single print-ready PDF with every competitor's badge.

## Running it

```bash
npm install
npm run dev
```

Then open the address it prints (`http://localhost:5173/CompetitionBadgeGenerator/` by default). On Windows you can instead double-click `start-badge-designer.bat`, which installs what's missing, starts the app and opens it in the browser.

Press `?` in the editor to see the keyboard shortcuts.

## Credits

- **[Pedro Azevedo](https://github.com/pga27)** — creator. Built Competition Badge Generator and its badge designer (text, images, color blocks, QR codes, schedule tables and the task key), loading a competition's WCIF with each person's schedule and tasks, values driven by role or country (including country flags), template save and load, and print-ready PDF generation with font fallback for names in other scripts.
- **[Rubén López de Juan](https://github.com/ruben-lopez-dejuan)** — collaborator. Added stages in WCIF schedules and printable stage colors; schedule options (renaming events and activities, the MBLD cube submission task, one row per round); text frames and image cropping; per-value text colors, gender variants and role combinations; the editor's redesign (layout, undo/redo, multi-select, zoom, keyboard shortcuts and clipboard); loading a competition by its WCA ID; and the Windows launcher.
