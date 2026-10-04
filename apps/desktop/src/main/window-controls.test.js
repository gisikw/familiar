const assert = require("node:assert/strict");
const test = require("node:test");
const { windowChromeOptions } = require("./window-controls");

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform}: frameless, with no native titlebar left over the content`, () => {
    const opts = windowChromeOptions(platform);
    assert.equal(opts.frame, false);
    // "hidden"/"hiddenInset"/"customButtonsOnHover" keep a native titlebar view
    // that eats clicks in the top ~28pt of the page.
    assert.equal(opts.titleBarStyle, undefined);
    assert.equal(opts.titleBarOverlay, undefined);
  });
}
