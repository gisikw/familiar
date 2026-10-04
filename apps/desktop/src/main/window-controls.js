// Keep platform-specific native chrome choices isolated and unit-testable.
//
// The window is truly frameless everywhere. On macOS we deliberately do NOT use
// titleBarStyle "hidden"/"hiddenInset": those keep the native titlebar view
// (~28pt) over the top of the content, invisible once the traffic lights are
// hidden, and it swallows mouse events there — the top half of every topbar
// control (and of docked devtools tabs) went dead. The served page provides the
// drag handle instead: its topbar is -webkit-app-region: drag, controls no-drag.
function windowChromeOptions(_platform = process.platform) {
  return { frame: false };
}

module.exports = { windowChromeOptions };
