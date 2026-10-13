// Says which firmware this page installs (from the manifest the installer will use), and why it cannot when it cannot.
const version = document.getElementById("version");
const install = document.getElementById("install");

if (!window.isSecureContext) document.getElementById("insecure").hidden = false;

fetch("manifest.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((m) => {
    version.textContent = `firmware ${m.version}`;
    if (m.name) document.getElementById("what").textContent = m.name;
  })
  .catch(() => {
    version.textContent = "There is no firmware to install here yet. On your Axis admin page, the board's type page shows what is on the shelf.";
    install.hidden = true;
  });
