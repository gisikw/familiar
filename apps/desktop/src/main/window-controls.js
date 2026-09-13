// Keep platform-specific native chrome changes isolated and unit-testable.
function hideMacWindowButtons(window, platform = process.platform) {
  if (platform === "darwin") {
    // Supported Electron API: hide, rather than move, the native traffic lights.
    window.setWindowButtonVisibility(false);
  }
}

module.exports = { hideMacWindowButtons };
