# Familiar viewer

The viewer is a Rust TUI that embeds one `tmux attach` PTY per client. It is not wired to production callers yet.

## Run

The native VT library requires Zig 0.15. From the repository root:

```sh
nix shell nixpkgs#zig_0_15 -c cargo run --manifest-path services/viewer/Cargo.toml -- \
  --presence-socket /absolute/path/to/presence.sock \
  --agents-socket /absolute/path/to/agents.sock
```

The viewer owns the host alternate screen and raw mode, draws placeholder `FAMILIAR` chrome, and starts a writable presence-session attach in the main rectangle. A vanished tmux session is nonfatal: the viewer keeps its chrome and displays a notice. There is intentionally no viewer-local quit key; disconnect the client or signal the process.

## Input and rendering limitations

Keyboard input uses plain xterm sequences. Application-cursor mode, arrows/navigation keys, F1–F12, basic Ctrl/Alt combinations, and bracketed paste are supported. Modified navigation/function-key variants, application-keypad mappings, the Kitty keyboard protocol, compose/IME subtleties, and viewer-local shortcuts are not yet encoded. Mouse capture and forwarding are deferred to Chunk 3.

The cursor position and DECTCEM visibility are read from libghostty-vt and mapped into the host frame. Synchronized-output mode is treated as a frame-coalescing hint. Graphics are deferred to Chunk 2, and the real jobs/sidebar UI is deferred to Chunk 4.

## Terminal core support

| Area | Chunk 1 status |
|---|---|
| Arbitrarily split byte streams, UTF-8, CSI/OSC/DCS | libghostty-vt streaming parser |
| Cursor, scrolling, primary/alternate screen | Supported |
| SGR 16-color, 256-color, RGB and basic attributes | Supported through cell accessors |
| Wide CJK/emoji and grapheme text | Supported; spacer cells have width 0 |
| Mouse modes/encodings, focus, paste, application cursor/keypad | Tracked |
| Synchronized output | Tracked and interpreted by libghostty-vt |
| DA/DSR and other PTY replies | Returned by `TerminalUpdate::replies` |
| Damage | Correct full-grid damage for nonempty writes; finer render-state damage is deferred |
| Kitty graphics | APC is parsed and swallowed safely; semantic event/image extraction is deferred to Chunk 2 |

The Rust boundary remains `terminal::TerminalCore`. Chunk 1 did not change that trait. `GhosttyTerminal` is the FFI-backed implementation.

## Vendored libghostty-vt

`vendor/libghostty-vt` is the MIT-licensed Ghostty source distribution (its `LICENSE` is included), pinned in `vendor/libghostty-vt.vendor.json` to Ghostty commit `c5a21edfcbc2d5b46540ad91b7980aca31f5f1f3` (`libghostty-vt-1.3.2-HEAD-+c5a21edfc.tar.gz`).

The build requires Zig 0.15. Cargo's `build.rs` invokes `${ZIG:-zig} build -Demit-lib-vt -Doptimize=ReleaseFast` and currently supports Linux x86_64/aarch64 GNU targets. If Zig is not installed, run Cargo in `nix shell nixpkgs#zig_0_15 -c ...`. Nix packaging and Zig availability in release builds are intentionally deferred to Chunk 5.

To refresh from a clean Ghostty checkout at the intended commit:

```sh
cd services/viewer
python3 scripts/vendor_libghostty_vt.py /path/to/ghostty
```

Review the resulting metadata, license, headers, and source diff. The helper builds Ghostty's `dist` target and replaces only this crate's vendor directory. `scripts/build_vendored_libghostty_vt.sh` is available for a direct smoke build.

## Deferred

Chunk 2 owns Kitty image/placement extraction and rendering. Fine-grained render-state damage is also deferred; the current conservative full-grid region is functionally correct. Chunk 5 must provide Zig 0.15 in Nix builds and should account for the native library's clean-build cost.
