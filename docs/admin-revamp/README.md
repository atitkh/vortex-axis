# Admin page revamp

Planning (2026-10-27): audit and mockups. Building: stages 0 to 3 are done (the page at `/admin-next`, its shell, the Devices area, the Overview and Activity); `progress.md` has the checklist and what is next.

- `audit.md`: every view, control, API call, route and behaviour of today's admin page, the UX problems with
  evidence, and where each feature goes in the new layout.
- `ia.md`: the sitemap, routes old and new, command bar, settings editor, layout system and tokens, the framework
  recommendation (Preact + htm, vendored, no build) and the migration in stages.
- `mockup-a.html`: direction A, sidebar with collapsible groups and a command bar (recommended). Open with `#overview`,
  `#device` or `#cmdk`. Renders: `mockup-a-overview.png`, `mockup-a-device.png`, `mockup-a-command.png`,
  `mockup-a-device-phone.png` (390 × 844).
- `mockup-b.html`: direction B, section tabs across the top with a contextual second bar. `#overview`, `#device`.
  Renders: `mockup-b-overview.png`, `mockup-b-device.png`.

The mockups are static: the data is made up, nothing is clickable, and the views are picked by the address.
They are written from `src/` by `node docs/admin-revamp/build.mjs`, which inlines `src/shared.css`, `src/shared.js`
and the real face (`web/icons.js`, `web/vortex.js`) so each file needs nothing else. Those inlined copies are snapshots
for the pictures, not a fifth copy of the face to keep in step. `node docs/admin-revamp/render.mjs` redraws the PNGs
with headless Chrome (`CHROME` or `google-chrome`, as `scripts/browser-check.mjs`).
- `progress.md`: what is built, the checklist of every audited control, what comes next.
- `shots.mjs`: screenshots of the new page against a throwaway Axis with pretend devices.
