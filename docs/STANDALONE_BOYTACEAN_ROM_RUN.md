# Standalone GB Studio ROM via Native Boytacean SDL

Guide for running a GB Studio ROM through the native Boytacean SDL frontend as a standalone test — on a Windows PC or on ROCKNIX handheld devices such as RG35XXSP / RG35XX H — without the browser/WASM frontend.

Path placeholders:

| Placeholder | Meaning |
|-------------|---------|
| `<repo>` | Root of your Boytacean checkout (e.g. `D:\GBStudio\boytacean`) |
| `PATH_TO_ROM.gb` | Full path to your GB Studio ROM file |
| `<PC_LAN_IP>` | LAN IP of the PC running the Node bridge |

For cross-compiling and deploying the ARM64 binary to ROCKNIX H700, see [ROCKNIX_H700_NATIVE_BOYTACEAN.md](ROCKNIX_H700_NATIVE_BOYTACEAN.md).

## Overview

The native Boytacean SDL frontend can run a GB Studio ROM directly — no browser, no WASM build, no static web server.

The same serial Node bridge used by the web frontend works with SDL via:

```text
--device node
--node-url http://localhost:3000/api/gb-message
```

On a handheld, `localhost` must be replaced by the PC's LAN IP so the device can reach the bridge over Wi-Fi:

```text
--node-url http://<PC_LAN_IP>:3000/api/gb-message
```

## End-to-end flow

```text
GB Studio ROM
→ native Boytacean SDL (Windows PC or ROCKNIX handheld)
→ HTTP POST (serial Node bridge device)
→ PC Node bridge (bridge-server/server.js)
→ Ollama
→ serial reply injected back into the ROM
```

The current protocol still uses `WAIT` responses and cached final-reply polling while Ollama generates a hint.

---

## Windows PC setup

### Prerequisites

- Boytacean repo checked out (example: `D:\GBStudio\boytacean`)
- Rust / Cargo installed (`rustup default stable-msvc` recommended on Windows)
- SDL frontend built (see [Windows build notes](#windows-build-notes) if `cargo run` fails)

### Terminal 1 — Node bridge

```powershell
cd D:\GBStudio\boytacean
node bridge-server\server.js
```

Expected log:

```text
[GB bridge server] listening on http://0.0.0.0:3000
```

If Ollama is part of your hint flow, ensure it is running and the model is pulled (e.g. `qwen2.5:3b`). See [ROCKNIX_H700_NATIVE_BOYTACEAN.md](ROCKNIX_H700_NATIVE_BOYTACEAN.md#lan-node--ollama-bridge) for Ollama setup.

### Terminal 2 — Emulator

```powershell
cd D:\GBStudio\boytacean
cargo run -p boytacean-sdl -- --device node --node-url http://localhost:3000/api/gb-message "PATH_TO_ROM.gb"
```

Replace `PATH_TO_ROM.gb` with the actual path to your GB Studio ROM.

### Optional: local helper scripts

You can wrap the bridge and emulator commands in local PowerShell scripts for convenience, for example:

- `run_bridge_okinawa.ps1` — starts `node bridge-server\server.js`
- `run_boytacean_rom_okinawa.ps1` — runs `cargo run -p boytacean-sdl` with your ROM path and `--node-url`

These scripts are useful when they encode personal paths or project-specific ROM names. **Do not commit them** if they contain machine-specific paths or other local configuration.

---

## Windows build notes

This section is troubleshooting only — not required for the main run flow if `cargo run -p boytacean-sdl` already works.

| Requirement | Notes |
|-------------|-------|
| Rust / Cargo | Install via [rustup](https://rustup.rs/); use MSVC toolchain on Windows |
| vcpkg | Required for SDL dependencies; install with `cargo install cargo-vcpkg` |
| SDL triplet | `x64-windows-static-md` (configured in `frontends/sdl/Cargo.toml`) |

Typical first-time SDL build:

```powershell
cd D:\GBStudio\boytacean
cargo install cargo-vcpkg
cargo vcpkg build
cargo build -p boytacean-sdl --release
```

### Static SDL linking issues

vcpkg may install libraries named `SDL2-static.lib`, `SDL2_image-static.lib`, and `SDL2_mixer-static.lib` instead of `SDL2.lib`. If linking fails, you may need to:

1. Point the linker at the vcpkg `lib` folder for your triplet (e.g. `%VCPKG_ROOT%\installed\x64-windows-static-md\lib`).
2. Add required Windows system libraries via `RUSTFLAGS`, for example:

```powershell
$env:VCPKG_ROOT = "$env:USERPROFILE\vcpkg"
$env:RUSTFLAGS = "-C link-arg=advapi32.lib"
cargo run -p boytacean-sdl -- --device node --node-url http://localhost:3000/api/gb-message "PATH_TO_ROM.gb"
```

For more vcpkg/SDL troubleshooting, see [frontends/sdl/README.md](../frontends/sdl/README.md).

---

## ROCKNIX handheld setup

Copy the `boytacean-sdl` binary and your ROM into:

```text
/storage/roms/ports/BoytaceanAI/
```

Create a Ports launcher at:

```text
/storage/roms/ports/BoytaceanAI.sh
```

Example launcher:

```sh
#!/bin/sh
cd /storage/roms/ports/BoytaceanAI
exec ./boytacean-sdl \
  --device node \
  --node-url http://<PC_LAN_IP>:3000/api/gb-message \
  your_rom.gb
```

Replace `your_rom.gb` with your ROM filename and `<PC_LAN_IP>` with the LAN IP of the PC running the Node bridge.

Make executable:

```sh
chmod +x /storage/roms/ports/BoytaceanAI/boytacean-sdl
chmod +x /storage/roms/ports/BoytaceanAI.sh
```

Launch from ROCKNIX: **Ports → BoytaceanAI**.

The PC must be on the same Wi-Fi/LAN, with the Node bridge listening on `0.0.0.0:3000` and Windows firewall allowing inbound TCP port `3000`.

---

## RG35XXSP note

If you use an **RG35XXSP** (or similar) with ROCKNIX:

1. Confirm the device **CPU architecture** and OS match the binary you deploy.
2. If the device is **H700 / aarch64** like the tested ROCKNIX target, the same ARM64 `boytacean-sdl` binary built for H700 may work without changes.
3. If the architecture differs (e.g. 32-bit ARM, different SoC), rebuild `boytacean-sdl` for the correct Rust target and verify SDL runtime libraries on the device (`ldd ./boytacean-sdl`).

See [ROCKNIX_H700_NATIVE_BOYTACEAN.md](ROCKNIX_H700_NATIVE_BOYTACEAN.md) for cross-compile and deployment details.

---

## Network test

Before launching the port on a handheld, confirm it can reach the PC bridge.

From the handheld (SSH or terminal):

```sh
wget -qO- \
  --post-data='{"message":"ASK:HINT:GO","prompt":"HINT:GO"}' \
  --header='Content-Type: application/json' \
  http://<PC_LAN_IP>:3000/api/gb-message
```

Expected reply: JSON containing `"reply":"WAIT"` or a cached hint such as `"GO EAST FIRST"`.

On Windows, find `<PC_LAN_IP>` with:

```powershell
ipconfig
```

Use the IPv4 address of your active Wi-Fi or Ethernet adapter.

---

## Known working flow

This setup has been verified end-to-end:

```text
GB Studio ROM
→ native Boytacean SDL
→ Node bridge (bridge-server/server.js)
→ Ollama
→ serial reply back into the ROM
```

Protocol behavior:

- The ROM sends newline-terminated serial lines (e.g. `ASK:HINT:GO`).
- SDL `NodeBridgeDevice` POSTs JSON to `/api/gb-message`.
- While Ollama generates, the bridge returns `WAIT`; the ROM polls until a final hint is cached and returned.
- Reply bytes are queued and injected into emulated serial input for GB Studio dialogue display.

SDL log markers when working:

```text
[NODE BRIDGE OUT] ASK:HINT:GO
[NODE BRIDGE SEND] ASK:HINT:GO
[NODE BRIDGE HTTP] status 200
[NODE BRIDGE IN] WAIT
[NODE BRIDGE IN] GO EAST FIRST
[NODE BRIDGE QUEUE] GO EAST FIRST
```

For full protocol details, see [GB_SERIAL_NODE_BRIDGE_IMPLEMENTATION.md](../GB_SERIAL_NODE_BRIDGE_IMPLEMENTATION.md) and [ROCKNIX_H700_NATIVE_BOYTACEAN.md](ROCKNIX_H700_NATIVE_BOYTACEAN.md#serial-request--reply-protocol).

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| ROM fails to open | Verify `PATH_TO_ROM.gb` / `your_rom.gb` path and filename; launcher `cd` directory must contain the ROM |
| Bridge connection fails | Confirm `node bridge-server\server.js` is running; check terminal for `[GB bridge server] listening` |
| Handheld cannot connect | Use `<PC_LAN_IP>` (not `localhost`); same Wi-Fi/LAN; Windows firewall allows TCP port `3000`; run the [network test](#network-test) |
| `[NODE BRIDGE IN] WAIT` never resolves | Ollama running and model pulled; bridge can reach `http://localhost:11434` |
| ROM shows `LINK ERROR` | HTTP failure between handheld and PC; re-run wget preflight |
| `cargo run` / link fails on Windows | Rust MSVC toolchain, vcpkg installed, SDL static libs (`x64-windows-static-md`), `RUSTFLAGS` with system libs if needed |
| No controller on handheld | Controller opened at SDL startup; see controller table in [ROCKNIX_H700_NATIVE_BOYTACEAN.md](ROCKNIX_H700_NATIVE_BOYTACEAN.md#sdl-controller-input) |
