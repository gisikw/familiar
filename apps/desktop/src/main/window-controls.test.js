const assert = require("node:assert/strict");
const test = require("node:test");
const { hideMacWindowButtons } = require("./window-controls");

test("hides native window buttons on macOS", () => {
  const calls = [];
  hideMacWindowButtons(
    { setWindowButtonVisibility: (visible) => calls.push(visible) },
    "darwin"
  );
  assert.deepEqual(calls, [false]);
});

for (const platform of ["win32", "linux"]) {
  test(`leaves native window buttons unchanged on ${platform}`, () => {
    const window = {
      setWindowButtonVisibility: () => assert.fail("must remain macOS-only"),
    };
    hideMacWindowButtons(window, platform);
  });
}
