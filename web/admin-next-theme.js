// Runs before the new admin page is drawn, so it never flashes the wrong theme.
// The choice (dark, light or system) is kept in this browser; dark unless chosen otherwise.
(function () {
  var chosen = "dark";
  try {
    chosen = localStorage.getItem("axis.theme") || "dark";
  } catch (e) {}
  var light = chosen === "light" || (chosen === "system" && window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document.documentElement.dataset.themeChoice = chosen;
})();
