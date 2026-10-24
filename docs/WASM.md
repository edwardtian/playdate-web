# Porting the Playdate Simulator to WebAssembly — findings and options

## What the SDK ships

`bin/PlaydateSimulator` is a 27 MB **stripped ELF** (Linux x86_64) linked against:

- GTK3 / GDK3 / Pango / Cairo / GdkPixbuf
- **WebKit2GTK 4.1** (the device screen and console are rendered as web content)
- X11, libudev, libpng, libunwind, libjavascriptcoregtk

It is **closed-source and stripped**. There is no source tree, and the runtime is a native desktop application whose UI is WebKit-hosted. Consequently:

- It cannot be compiled to WASM directly (no source, and GTK/WebKit/X11/udev have no browser equivalents).
- A binary-to-WASM translator (e.g. wasmblr-style static recompilation) is impractical for a 27 MB stripped GTK app with WebKit dependencies.

## Route A — server-side simulator + browser streaming (implemented)

This app runs the real simulator on a virtual X display and streams only the 400×240 framebuffer to the browser:

- `Xvfb :N -screen 0 1280x900x24 -listen tcp -extension GLX` (TCP display avoids needing root-owned `/tmp/.X11-unix`)
- `PlaydateSimulator game.pdx` with `GDK_BACKEND=x11` and `WEBKIT_DISABLE_COMPOSITING_MODE=1`
- `ffmpeg -f x11grab -draw_mouse 0 -video_size 400x240 -i 127.0.0.1:N.0+X,Y -r 30 -f mjpeg pipe:1`
- input via `xdotool` (XTEST): arrows = D-pad, `s` = A, `a` = B; mouse wheel = crank (4°/click); clicks on the docked checkbox and MENU button

Fidelity is maximal: Lua runtime, `pdex` C code, CoreLibs, audio, sprite/collision semantics are the official ones. This is why it was chosen over an emulator port.

Limits: per-session native process (~100–200 MB RSS), ~30 fps JPEG stream (~5–10 KB/frame at q=6), and one X display per session. The design caps concurrent sessions and reaps idle ones.

## Route B — open-source emulator cores compiled to WASM

Two MIT-licensed projects execute real `.pdx` bundles (Lua games):

### Cranked — https://github.com/TheLogicMaster/Cranked
- C, MIT, early-stage Playdate console emulator.
- Groundwork for Lua and C games, but sprites, audio, and graphics effects are incomplete.

### Pyplaydate — https://github.com/alanstr-moreno/Pyplaydate
- Python HLE runtime (lupa + pygame-ce) that loads real compiled `.pdx` files.
- Decodes `.pdz/.pdi/.pdt/.pft/.pda`; reimplements `playdate.*` (`graphics`, `sound`, `sprite`, `geometry`, `display`, `button`, `file`).
- Explicitly supports homebrew/unencrypted games only; Catalog encryption (`0x40000000`) is unsupported.
- Requires Lua 5.4 compiled with `LUA_32BITS` (Playdate bytecode is 32-bit).

### WASM feasibility notes

- **Lua VM:** Playdate compiles `.pdz` for a 32-bit Lua VM. A browser port must embed Lua 5.4 with `LUA_32BITS` (Emscripten can compile Lua; `lupa`'s Python binding does not translate directly to WASM). A C Lua host with the SDK API reimplemented is the cleanest WASM path.
- **Assets:** `.pdi` (1-bit images), `.pft` (fonts), `.pdt` (tilemaps), `.pda` (audio, PCM/IMA ADPCM) must be decoded in JS/WASM. They are simple formats and can be decoded client-side.
- **Audio:** Web Audio API replaces the native mixer; synth waveforms/ADSR are implementable in JS.
- **Input/crank:** browser events map to the same buttons/crank semantics.
- **Licensing:** CoreLibs and SDK assets are governed by the Playdate SDK license; a public WASM runtime should avoid bundling SDK binaries and instead implement the API independently.

### Suggested WASM roadmap

1. Build a C host (Emscripten) embedding Lua 5.4 with `LUA_32BITS`.
2. Port `.pdx` container parsing and asset decoders to C/JS.
3. Implement `playdate.graphics` primitives on a canvas/WebGL 1-bit framebuffer.
4. Implement `playdate.sound` via Web Audio; `playdate.sprite` in JS.
5. Run against the SDK examples as regression tests (Flippy Fish, CollisionMaskTest, Level 1-1).
6. Add encrypted-Catalog detection and clear error messaging.

## Recommendation

For fidelity and immediate usability, keep Route A (real simulator streaming). For a fully client-side, zero-server deployment, pursue Route B with Cranked/Pyplaydate as reference implementations, starting with the Lua 5.4 32-bit VM and the graphics/sprite APIs.
