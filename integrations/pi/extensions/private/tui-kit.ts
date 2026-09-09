/* The real terminal primitives, isolated so `ui.ts` stays importable — and
 * therefore testable — without Pi's module tree on the resolution path. */

import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TuiKit } from "./ui.ts";

export const piTuiKit: TuiKit = {
  isEnter: (data) => matchesKey(data, Key.enter),
  // Ctrl+C and Escape both mean "get me out", never "cancel my key material
  // silently": both paths clear the buffer before invoking their callback.
  isExit: (data) => matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")),
  isBackspace: (data) => matchesKey(data, Key.backspace),
  isKillLine: (data) => matchesKey(data, Key.ctrl("u")),
  truncate: (text, width) => truncateToWidth(text, width),
  wrap: (text, width) => wrapTextWithAnsi(text, width),
};
