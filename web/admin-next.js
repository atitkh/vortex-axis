// The new admin page, built beside the classic one (docs/admin-revamp/ia.md). Preact with htm, vendored in
// web/preact.js, no build step. The parts: adm-core.js (data, API, drafts), adm-shell.js (frame, router, command
// bar), adm-devices.js and adm-settings.js (the Devices area), adm-tools.js (face, sketch, glow, microphone).
import { html, render } from "/web/preact.js";
import { App } from "/web/adm-shell.js";

render(html`<${App} />`, document.getElementById("root"));
