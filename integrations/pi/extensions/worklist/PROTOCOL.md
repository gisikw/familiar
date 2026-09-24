# Worklist client protocol

`familiar-services` is the sole owner of worklist, DND, and wake persistence.
Clients connect to `FAMILIAR_SERVICES_SOCKET` (default
`/run/familiar-services/familiar.sock`) and exchange one newline-delimited JSON
request and response:

```json
{"op":"worklist.enqueue","args":{"summary":"done","priority":2}}
{"ok":true,"result":{"item":{"id":"…"},"created":true}}
```

The Pi extension polls `worklist.list` every 15 seconds and retains delivery,
pacing, digest, and DND presentation policy. It uses `worklist.enqueue`,
`worklist.ack`, `worklist.withdraw`, `dnd.get`, and `dnd.set`; there is no file
fallback or dual-writing. Socket failures are surfaced to the UI/tool caller.
