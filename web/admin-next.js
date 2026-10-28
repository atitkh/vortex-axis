// The admin page, served at /admin; the classic page it replaced is gone since Axis 0.58.0. Preact with htm, vendored in
// web/preact.js, no build step. The parts: adm-core.js (data, API, drafts), adm-shell.js (frame, router, command
// bar), adm-devices.js and adm-settings.js (the Devices area), adm-tools.js (face, sketch, glow, microphone).
import { html, render } from "/web/preact.js";
import { App } from "/web/adm-shell.js";

render(html`<${App} />`, document.getElementById("root"));
