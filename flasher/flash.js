// Says which firmware this page installs (from the manifest the installer will use), and why it cannot when it cannot.
// With firmware for more than one kind of board (types.json lists them), a choice of board picks the manifest.
const version = document.getElementById("version");
const install = document.getElementById("install");
const choose = document.getElementById("choose");
const board = document.getElementById("board");

if (!window.isSecureContext) document.getElementById("insecure").hidden = false;

const show = (manifest) =>
  fetch(manifest)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((m) => {
      version.textContent = `firmware ${m.version}`;
      if (m.name) document.getElementById("what").textContent = m.name;
      install.setAttribute("manifest", manifest);
      install.hidden = false;
    })
    .catch(() => {
      version.textContent = "There is no firmware to install here yet. On your Axis admin page, the board's type page shows what is on the shelf.";
      install.hidden = true;
    });

fetch("types.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((types) => {
    if (!Array.isArray(types) || types.length === 0) return show("manifest.json");
    if (types.length > 1) {
      for (const t of types) {
        const option = document.createElement("option");
        option.value = t.manifest;
        option.textContent = t.name || t.type;
        board.append(option);
      }
      board.addEventListener("change", () => show(board.value));
      choose.hidden = false;
    }
    return show(types[0].manifest);
  })
  .catch(() => show("manifest.json"));
