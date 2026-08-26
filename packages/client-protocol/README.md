# @familiar/client-protocol

Zero-runtime-dependency TypeScript types and validators for the public Familiar client ↔ Interface Gateway protocol. See [PROTOCOL.md](PROTOCOL.md).

```ts
import { validateMessage } from "@familiar/client-protocol";
const result = validateMessage(JSON.parse(frame));
```

Run `bun test` and `bun run typecheck`.
