# Native Boytacean SDL on ROCKNIX H700

Guide for cross-compiling the Boytacean SDL frontend for ARM64 / ROCKNIX, deploying it as a Ports entry, and connecting serial hint requests to a LAN Node/Ollama bridge.

Path placeholders:

| Placeholder | Meaning |
|-------------|---------|
| `<repo>` | Root of your Boytacean checkout (WSL or Linux build host) |
| `C:\Projects\boytacean` | Windows checkout (Node bridge / optional local test) |
| `<linux-user>` | WSL/Linux username (for sysroot paths in Cargo config) |
| `<PC_LAN_IP>` | LAN IP of the PC running the Node bridge |
| `<H700_IP>` | LAN IP of the H700 handheld |
| `/path/to/your/game.gb` | Your GB Studio ROM file |

## End-to-end flow

```text
GB Studio ROM
→ native ARM64 boytacean-sdl on H700 / ROCKNIX
→ Wi-Fi HTTP POST
→ PC Node bridge (bridge-server/server.js)
→ Ollama
→ serial reply injected into the ROM
```

SDL frontend requirements for this setup:

- Dynamic SDL linking on Linux ARM64 (`frontends/sdl/Cargo.toml`: `features = ["ttf", "image", "gfx", "mixer"]`)
- Serial device `node` with `--node-url` pointing at the PC bridge
- SDL game-controller input (D-Pad, A/B, Start/Select, Guide quit, Back+Start quit)

## H700 runtime and binary verification

Target device:

- Anbernic H700 (or compatible H700-based handheld)
- ROCKNIX, ARM64 / aarch64, glibc
- SDL2 libraries in `/usr/lib`

On the H700, check runtime library resolution:

```sh
cd /storage/roms/ports/BoytaceanAI
ldd ./boytacean-sdl
```

On the build host, inspect direct link dependencies of the release binary:

```sh
cd <repo>
readelf -d target/aarch64-unknown-linux-gnu/release/boytacean-sdl | grep NEEDED
```

The shipped binary directly needs:

- `libSDL2-2.0.so.0`
- `libSDL2_image-2.0.so.0`
- `libSDL2_ttf-2.0.so.0`
- normal libc / libm / libgcc dependencies

SDL2_mixer and SDL2_gfx are available on ROCKNIX but were not listed as direct dependencies in the final binary's `readelf` NEEDED output.

## Cross-compile (Ubuntu WSL → ARM64)

Build host:

- Ubuntu on WSL (x86_64)
- Rust **stable** via rustup
- `gcc-aarch64-linux-gnu` cross linker

Install toolchain, Rust target, and x86_64 SDL headers (compile-time only):

```sh
sudo apt install -y gcc-aarch64-linux-gnu libc6-dev-arm64-cross
sudo apt install -y \
  libsdl2-dev \
  libsdl2-image-dev \
  libsdl2-ttf-dev \
  libsdl2-mixer-dev \
  libsdl2-gfx-dev
rustup target add aarch64-unknown-linux-gnu
```

## ROCKNIX sysroot

Cross-linking needs ARM64 `.so` files copied from a real H700. Create:

```text
~/rocknix-sysroot/usr/lib
```

Copy from the H700 `/usr/lib` (version suffixes may differ):

```text
libSDL2-2.0.so.0.3200.10
libSDL2_image-2.0.so.0.800.2
libSDL2_ttf-2.0.so.0.2000.2
libSDL2_mixer-2.0.so.0.800.0
libSDL2_gfx-1.0.so.0.0.2
libasound.so.2
libjpeg.so.8
libz.so.1
libfreetype.so.6
libbz2.so.1.0
libpng16.so.16
```

Create linker symlinks inside `~/rocknix-sysroot/usr/lib`:

```sh
cd ~/rocknix-sysroot/usr/lib
ln -sf libSDL2-2.0.so.0.3200.10 libSDL2.so
ln -sf libSDL2_image-2.0.so.0.800.2 libSDL2_image.so
ln -sf libSDL2_ttf-2.0.so.0.2000.2 libSDL2_ttf.so
ln -sf libSDL2_mixer-2.0.so.0.800.0 libSDL2_mixer.so
ln -sf libSDL2_gfx-1.0.so.0.0.2 libSDL2_gfx.so
```

Example copy from H700 via SCP (run on build host):

```sh
scp root@<H700_IP>:/usr/lib/libSDL2-2.0.so.0.3200.10 ~/rocknix-sysroot/usr/lib/
# repeat for each library listed above
```

## Local Cargo linker configuration

Create `<repo>/.cargo/config.toml` (do not commit). Replace `<linux-user>` with your WSL username:

```toml
[target.aarch64-unknown-linux-gnu]
linker = "aarch64-linux-gnu-gcc"
rustflags = [
  "-C", "link-arg=-L/home/<linux-user>/rocknix-sysroot/usr/lib",
  "-C", "link-arg=-Wl,-rpath-link,/home/<linux-user>/rocknix-sysroot/usr/lib"
]
```

This file is local build configuration only.

## Build and deploy

Build from `<repo>`:

```sh
cd <repo>
cargo build --target aarch64-unknown-linux-gnu --lib
cargo build --release -p boytacean-sdl --target aarch64-unknown-linux-gnu
```

Output:

```text
target/aarch64-unknown-linux-gnu/release/boytacean-sdl
```

Deploy binary and ROM to the H700:

```sh
cd <repo>
scp target/aarch64-unknown-linux-gnu/release/boytacean-sdl \
  root@<H700_IP>:/storage/roms/ports/BoytaceanAI/
scp /path/to/your/game.gb \
  root@<H700_IP>:/storage/roms/ports/BoytaceanAI/
```

## ROCKNIX Ports launcher

Port folder:

```text
/storage/roms/ports/BoytaceanAI/
  boytacean-sdl
  game.gb
```

Launcher script (sibling of the port folder):

```text
/storage/roms/ports/BoytaceanAI.sh
```

Make executable:

```sh
chmod +x /storage/roms/ports/BoytaceanAI/boytacean-sdl
chmod +x /storage/roms/ports/BoytaceanAI.sh
```

`BoytaceanAI.sh`:

```sh
#!/bin/sh
cd /storage/roms/ports/BoytaceanAI
exec ./boytacean-sdl \
  --device node \
  --node-url http://<PC_LAN_IP>:3000/api/gb-message \
  game.gb
```

Replace `game.gb` with your ROM filename and `<PC_LAN_IP>` with the PC running the bridge.

Launch from ROCKNIX: **Ports → BoytaceanAI**.

## SDL controller input

The SDL frontend maps the H700 game controller to Game Boy inputs:

| Controller | Game Boy |
|------------|----------|
| D-Pad | Directions |
| A / B | A / B |
| Start | Start |
| Back | Select |
| Guide | Quit emulator |
| Back + Start (held together) | Quit emulator |

Keyboard input is unchanged. Controllers are opened at startup via SDL game-controller API.

## LAN Node / Ollama bridge

The H700 POSTs serial requests to the PC. The PC runs Ollama and `bridge-server/server.js`.

**Terminal 1 — Ollama** (if not already running):

```powershell
ollama serve
ollama pull qwen2.5:3b
```

**Terminal 2 — Node bridge** (binds `0.0.0.0:3000`):

```powershell
cd C:\Projects\boytacean
node bridge-server/server.js
```

Expected log:

```text
[GB bridge server] listening on http://0.0.0.0:3000
```

The bridge calls Ollama at `http://localhost:11434/api/generate` with model `qwen2.5:3b`.

Network requirements:

- H700 and PC on the same LAN
- Windows firewall allows inbound TCP port `3000`
- Use `<PC_LAN_IP>` in the launcher (not `127.0.0.1`)

Find addresses:

```powershell
ipconfig
```

```sh
ip addr
```

Bridge URL format:

```text
http://<PC_LAN_IP>:3000/api/gb-message
```

### H700 preflight test (wget)

Before launching the port, confirm the H700 can reach the bridge:

```sh
wget -qO- \
  --post-data='{"message":"ASK:HINT:GO","prompt":"HINT:GO"}' \
  --header='Content-Type: application/json' \
  http://<PC_LAN_IP>:3000/api/gb-message
```

Expected: JSON with `"reply":"WAIT"` or a hint such as `"GO EAST FIRST"`.

## Serial request / reply protocol

ROM sends newline-terminated lines such as:

```text
ASK:HINT:GO
ASK:HINT:DOOR
ASK:HINT:SWITCH
ASK:HINT:NEXT
```

SDL `NodeBridgeDevice` POSTs:

```json
{ "message": "ASK:HINT:GO", "prompt": "HINT:GO" }
```

Bridge responds:

```json
{ "reply": "GO EAST FIRST", "receivedPrompt": "HINT:GO" }
```

While Ollama generates, the bridge returns `WAIT`. The ROM polls until a hint is ready. Reply bytes are queued and injected into emulated serial input.

SDL log markers:

```text
[NODE BRIDGE OUT] ASK:HINT:GO
[NODE BRIDGE SEND] ASK:HINT:GO
[NODE BRIDGE HTTP] status 200
[NODE BRIDGE IN] WAIT
[NODE BRIDGE IN] GO EAST FIRST
[NODE BRIDGE QUEUE] GO EAST FIRST
```

On HTTP failure the bridge path enqueues `LINK ERROR\n` as fallback.

## Optional: local Windows test

Validate bridge + serial logic on Windows before deploying to the H700:

```powershell
cd C:\Projects\boytacean
node bridge-server/server.js
```

Second terminal:

```powershell
cd C:\Projects\boytacean
$env:VCPKG_ROOT = "$env:USERPROFILE\vcpkg"
$env:RUSTFLAGS = "-C link-arg=advapi32.lib"
cargo run -p boytacean-sdl -- --device node --node-url http://127.0.0.1:3000/api/gb-message C:\path\to\your\game.gb
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `ldd` on H700 shows `not found` for SDL libs | ROCKNIX `/usr/lib` has `libSDL2-2.0.so.0`, `libSDL2_image-2.0.so.0`, `libSDL2_ttf-2.0.so.0` |
| Cross-compile link errors | Sysroot populated from H700, symlinks created, `.cargo/config.toml` uses correct `<linux-user>` |
| `[NODE BRIDGE ERROR] HTTP request failed` | Bridge running, `<PC_LAN_IP>` correct, firewall open on port 3000; run wget preflight |
| Bridge receives requests but no hint | Ollama running, `qwen2.5:3b` pulled, port 11434 reachable from Node |
| ROM shows `LINK ERROR` | HTTP failure between H700 and PC |
| `[NODE BRIDGE IN] WAIT` never resolves | Ollama slow or down; ROM should retry hint request |
| No controller input | Controller detected at startup; verify SDL game-controller mapping |
| Black screen / no audio | Launcher `cd` path correct; ROM filename matches launcher argument |
