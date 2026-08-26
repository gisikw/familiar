# Familiar Viewer

`familiar-viewer` is a disposable native terminal client. It embeds a writable
Presence tmux attach and owns Familiar chrome, layout, input, colors, and pixels.
Browser and Electron clients use the same viewer through the gateway PTY bridge.

```sh
familiar-viewer --presence-socket /absolute/state/presence/tmux.sock \
  --render-url http://127.0.0.1:9940/v1/render/golem
```

`--render-url` / `FAMILIAR_RENDER_URL` is optional; without it the sidebar is
clean and Presence-only. The URL is Familiar-owned, not a plugin endpoint. A
background long poll receives bounded `left-nav` semantic trees. Only
`tree|branch|item` are rendered. An item can select an exact same-host terminal
socket/session; the viewer checks liveness immediately before preserving its
spawn-first, writable PTY switch. Dead or malformed targets are nonclickable.
No plugin components or painting enter the process.

Run tests from the root viewer shell:

```sh
nix develop .#viewer -c cargo test --manifest-path services/viewer/Cargo.toml --all-targets
```
