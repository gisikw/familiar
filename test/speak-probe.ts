// Probe the speakable() markdown→speech reduction with a gnarly sample.
// Run: bun test/speak-probe.ts
import { speakable } from "../extensions/subscriber/text.ts";

const sample = "Here's the config:\n\n```js\nconst x = 1;\nlet y = x * 2;\n```\n\nAnd *that* covers `setup` completely.";
console.log(JSON.stringify(speakable(sample)));
