// Shared by both mockups, after the face code (icons.js and vortex.js, inlined by build.mjs).
// The view comes from the address: #overview, #device, #cmdk (overview with the command bar open).
(function () {
  const hash = location.hash.slice(1) || "overview";
  const [view, ...flags] = hash.split("+");
  document.body.dataset.view = view === "cmdk" ? "overview" : view;
  if (view === "cmdk" || flags.includes("cmdk")) document.body.classList.add("k-open");

  // Faces: data-face="idle|listening|thinking|speaking|offline", drawn already settled on their look.
  const looks = { idle: IDLE[0][1], offline: LOOKS.offline, listening: LOOKS.listening, thinking: LOOKS.thinking, speaking: LOOKS.speaking, setup: LOOKS.setup };
  const pick = { idle: 0, idle2: 6, idle3: 7, idle4: 3 };
  for (const canvas of document.querySelectorAll("canvas[data-face]")) {
    const kind = canvas.dataset.face;
    const look = kind.startsWith("idle") ? IDLE[pick[kind] ?? 0][1] : looks[kind];
    const mode = kind.startsWith("idle") ? "idle" : kind;
    const face = new Vortex(canvas);
    face.calm = false;
    face.now = { ...look };
    face.hold(look, mode);
    if (canvas.dataset.icon) face.setIcon(canvas.dataset.icon);
  }

  // The round board's edge glow: a ring faded in from the edge like the firmware's (admin.js glowMap), drawn deeper so it reads at this size.
  for (const canvas of document.querySelectorAll("canvas[data-glow]")) {
    const [r, g, b] = canvas.dataset.glow.split(",").map(Number);
    const size = canvas.width;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    const depth = 12 * (size / 466) * 3.2;
    const strength = 1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = size / 2 - Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2);
      const o = (y * size + x) * 4;
      img.data[o + 3] = 255;
      if (d < 0 || d >= depth) continue;
      const f = 1 - d / depth;
      const a = strength * f * f;
      img.data[o] = r * a * 255; img.data[o + 1] = g * a * 255; img.data[o + 2] = b * a * 255;
    }
    ctx.putImageData(img, 0, 0);
  }
})();
