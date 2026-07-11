# GB Serial ↔ Node Bridge — Proof-of-Concept Implementation

This document describes the **current working local proof-of-concept** for two-way communication between a GB Studio ROM and a local Node.js server, routed through Boytacean’s serial emulation and the web frontend.

**This is not production-ready.** Hacks, timing assumptions, and temporary debug instrumentation are called out explicitly.

## End-to-end data flow

```text
GB Studio ROM
→ Game Boy serial hardware (SB/SC)
→ Boytacean Rust/WASM emulator
→ React/TypeScript frontend
→ local Node bridge server
→ React/TypeScript frontend
→ Boytacean Rust/WASM incoming serial queue
→ GB Studio ROM
→ GB Studio Display Dialogue
```

---

## 1. Purpose

This proof-of-concept demonstrates that a **GB Studio ROM running inside Boytacean (web/WASM)** can send a text request over emulated Game Boy serial hardware, have a **local Node server** respond, and receive that response back inside the ROM for display in GB Studio dialogue.

The verified round-trip (repeatable without browser refresh) is:

| Step | Direction | Data |
|------|-----------|------|
| 1 | ROM → bridge | `ASK:HI\n` (newline-terminated) |
| 2 | Node → frontend | JSON `{ "reply": "OK!", ... }` |
| 3 | Frontend → WASM queue | bytes `0x4F`, `0x4B`, `0x21` (`O`, `K`, `!`) |
| 4 | ROM receives | three serial reply bytes |
| 5 | GB Studio dialogue | `%c$Reply1%c$Reply2%c$Reply3` renders **`OK!`** |

The GB Studio test ROM itself is **built externally in GB Studio** and loaded into Boytacean at runtime; it is **not committed** to this repository. Sections 8–10 describe that ROM’s behavior as implemented in the external project.

---

## 2. Local runtime

### URLs

| Component | URL |
|-----------|-----|
| Node bridge | `http://localhost:3000/api/gb-message` |
| Browser frontend | `http://localhost:8000` |

### Start commands (PowerShell)

**Terminal 1 — Node bridge:**

```powershell
cd E:\GBStudio\boytacean
node bridge-server\server.js
```

Expected startup log:

```text
[GB bridge server] listening on http://localhost:3000
```

**Terminal 2 — static web frontend:**

```powershell
cd E:\GBStudio\boytacean\frontends\web
py -m http.server 8000
```

Then open `http://localhost:8000`, load the GB Studio test ROM, and set the Serial panel device to **Logger**.

### Rebuild requirement

After **any Rust/WASM** or **frontend source** change:

1. Rebuild WASM (when Rust changed):

   ```powershell
   cd E:\GBStudio\boytacean
   wasm-pack build --release --target=web --out-dir=frontends/web/lib -- --features wasm
   ```

2. Rebuild the web bundle:

   ```powershell
   cd E:\GBStudio\boytacean\frontends\web
   yarn build
   ```

3. **Hard-refresh** the browser (`Ctrl+Shift+R`) so the updated WASM/JS is loaded.

Serving via `py -m http.server 8000` from `frontends/web` serves the built `dist/` output (or project root depending on layout — use the directory that contains the built `index.html`).

---

## 3. Node bridge

### File

`bridge-server/server.js`

Standalone Node.js server using only the built-in `http` module (no npm dependencies, no changes to `frontends/web/package.json`).

### Behavior

| Route / method | Response |
|----------------|----------|
| `POST /api/gb-message` | Parses JSON body, logs it, returns hardcoded reply |
| `OPTIONS *` | `204` CORS preflight |
| Other routes | `404` JSON `{ "error": "Not found" }` |
| Non-POST on `/api/gb-message` | `405` JSON `{ "error": "Method not allowed" }` |
| Invalid JSON body | `400` JSON `{ "error": "Invalid JSON" }` |

### Request payload

```json
{ "message": "ASK:HI", "prompt": "HI" }
```

- `message` — full newline-stripped request string from the ROM (e.g. `ASK:HI`)
- `prompt` — substring after the `ASK:` prefix (e.g. `HI`)

The server logs:

```text
[GB bridge server] received: { message: 'ASK:HI', prompt: 'HI' }
[GB bridge server] replying: "OK!"
```

### Response payload

```json
{
  "reply": "OK!",
  "receivedPrompt": "HI"
}
```

The reply is **hardcoded** to `"OK!"` in `server.js` (line `const reply = "OK!";`).

### CORS

Constants at top of `server.js`:

- `ALLOWED_ORIGIN = "http://localhost:8000"`
- `Access-Control-Allow-Origin` set on all JSON responses via `sendJson()`
- `OPTIONS` handler returns `204` with:
  - `Access-Control-Allow-Methods: POST, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type`

---

## 4. ROM-to-browser path

### GB Studio serial output (external ROM)

The test ROM uses GB Studio **`VM_ASM`** blocks to drive the Game Boy serial port directly:

| Register | Address | Role |
|----------|---------|------|
| **SB** | `0xFF01` | Serial transfer data — outgoing byte written here |
| **SC** | `0xFF02` | Serial transfer control — start transfer when bit 7 set |

The request is sent as printable ASCII terminated by **`0x0A` (newline `\n`)**, producing the complete line `ASK:HI\n`.

### Boytacean serial register dispatch

MMU routes serial register access in `src/mmu.rs`:

- `Mmu::read` — `0xff01..=0xff02` → `Serial::read`
- `Mmu::write` — `0xff01..=0xff02` → `Serial::write`

Register constants: `SB_ADDR = 0xff01`, `SC_ADDR = 0xff02` in `src/consts.rs`.

### Logger device exposes outgoing bytes

When the Serial panel device is set to **Logger**, the frontend calls `GameboyEmulator.loadLoggerDevice()` → `GameBoy.load_logger_wa()` (`src/gb.rs`), which attaches a `StdoutDevice` (`src/devices/stdout.rs`).

On transfer completion, `Serial::tick_transfer()` calls `self.device.receive(self.byte_send)`. `StdoutDevice::receive()` invokes the WASM `loggerCallback`, which reaches JavaScript via:

```text
Serial::tick_transfer
  → StdoutDevice::receive(byte)
    → logger_callback (WASM extern)
      → window.loggerCallback (frontends/web/ts/gb.ts)
        → window.emulator.onLoggerDevice(data)
          → emulator.trigger("logger", { data })
            → SerialSection onLogger handler
```

### React serial component

**File:** `frontends/web/react/components/serial-section/serial-section.tsx`

**Component:** `SerialSection`

Registered in `GameboyEmulator.sections` (`frontends/web/ts/gb.ts`) as the **Serial** panel tab.

#### Key functions

| Function | Responsibility |
|----------|----------------|
| `onLoggerData(data: Uint8Array)` | Processes each outgoing serial byte from the logger callback |
| `messageBufferRef` | Accumulates printable outgoing bytes into a line buffer |
| `sendAskToBridge(message, prompt, emulator)` | POSTs to Node, queues reply bytes into WASM |
| `queueReplyForGameBoy(reply: string)` | Pushes reply character codes into module-level `gbReplyQueue` |

#### Outgoing message parsing logic (`onLoggerData`)

1. Log each byte (`[Boytacean serial]`).
2. **Ignore `0x00`** — see Section 5.
3. **Ignore `0x0D`** (carriage return).
4. **Append** other bytes to `messageBufferRef.current`.
5. On **`0x0A` (newline)**:
   - Copy buffer to `message`, clear buffer.
   - If non-empty, log `[Boytacean serial message]`.
   - If `message.startsWith("ASK:")`, extract `prompt = message.slice(4)` and call `sendAskToBridge(message, prompt, emulator)`.

The newline-delimited protocol means the frontend sees `ASK:HI` (without `\n`) as the complete message when the `\n` byte arrives.

---

## 5. Critical frontend parser fix

### Problem

When the Game Boy **receives** a server reply byte, the ROM’s receive-side serial transfers send **`0x00`** as the outgoing byte on each receive clock. The logger device reports those bytes to the frontend.

Before the fix, those null bytes were appended to `messageBufferRef`, contaminating the next request:

1. First `ASK:HI` worked.
2. After `OK!`, three logger events with value `0` were emitted.
3. Next newline produced a **blank** `[Boytacean serial message]`.
4. Subsequent `ASK:HI` was not recognized (buffer held `\0\0\0` or similar).

### Fix (in `onLoggerData`)

```typescript
if (byte === 0x00) {
    console.log("[Boytacean serial] ignoring null byte");
} else if (byte !== 0x0d) {
    // ... append / newline handling
}
```

**Rule:** `0x00` bytes must be **ignored** before appending to the outgoing message buffer. They may still appear in the logger UI display (`loggerDataRef`) but must not enter `messageBufferRef`.

---

## 6. Rust/WASM incoming serial implementation

### Modified Rust files

| File | Changes |
|------|---------|
| `src/serial.rs` | Incoming queue, bridge receive fix, WASM debug callbacks |
| `src/gb.rs` | WASM export `queue_serial_byte_wa`, debug callback extern declarations |

No other Rust files were modified for this proof-of-concept.

### Custom additions vs original Boytacean behavior

#### Original (unchanged conceptually)

- `Serial` struct with `data` (SB), transfer state, `byte_send` / `byte_receive`, `device: Box<dyn SerialDevice>`
- `Serial::write` — SB write stores byte; SC write with bit 7 starts transfer
- Transfer start: `byte_receive = self.device.send()`, `byte_send = self.data`
- `Serial::clock` / `Serial::tick_transfer` — bit-shift transfer simulation
- On 8 bits complete: `device.receive(byte_send)`, `int_serial = true`
- CPU serial interrupt at `0x58` when IF bit 3 set (`src/cpu.rs`), acknowledged via `Serial::ack_serial()`
- `GameBoy.load_logger_wa()` attaches `StdoutDevice` for outgoing byte capture

#### Custom bridge additions

**New fields on `Serial` (`src/serial.rs`):**

```rust
incoming: VecDeque<u8>,
receive_from_queue: bool,
```

**New method:**

```rust
pub fn queue_byte(&mut self, byte: u8)
```

Pushes one host-supplied byte onto `incoming`. Called from WASM via `GameBoy::queue_serial_byte_wa()`.

**Modified SC transfer-start block (`Serial::write`, `SC_ADDR` branch):**

When `self.transferring` becomes true:

```rust
if let Some(byte) = self.incoming.pop_front() {
    self.byte_receive = byte;
    self.receive_from_queue = true;
} else {
    self.byte_receive = self.device.send();
    self.receive_from_queue = false;
}
self.byte_send = self.data;
```

- If a queued byte exists → use it as the **incoming** byte for this transfer.
- Otherwise → fall back to normal `SerialDevice::send()` (e.g. `StdoutDevice` returns `0xFF`).

**Modified `Serial::tick_transfer()` completion:**

When `bit_count == 8`, **before** `device.receive()` and raising the interrupt:

```rust
if self.receive_from_queue {
    self.data = self.byte_receive;  // SB becomes the queued byte exactly
    self.receive_from_queue = false;
}
// then: device.receive(byte_send), int_serial = true
```

**Why this was needed:** Without setting `self.data = self.byte_receive` at completion, bit-shifting during `Serial::clock` left garbage in SB (observed as `0x55` / `"U"`) instead of the queued values `0x4F`, `0x4B`, `0x21`.

**Reset:** `receive_from_queue` cleared in `Serial::new()` and `Serial::reset()`.

### WASM export (`src/gb.rs`)

```rust
pub fn queue_serial_byte_wa(&mut self, byte: u8) {
    self.serial().queue_byte(byte);
}
```

`GameBoy::serial()` delegates to `self.cpu.serial()` (`src/gb.rs`).

### Temporary WASM debug callbacks (remove later)

Declared in `src/serial.rs` and `src/gb.rs`, wired in `frontends/web/ts/gb.ts`:

| Callback | Trigger |
|----------|---------|
| `serialQueueDebugCallback(stage, byte, queueLen)` | `queue_byte`, transfer start, pop/fallback |
| `serialInputDebugCallback(byteReceive, data, byteSend)` | Queue-sourced transfer completion |
| `serialSbReadDebugCallback(value)` | Every `Serial::read` of `SB_ADDR` (`0xFF01`) |

---

## 7. WASM and TypeScript bridge

### Rust → WASM export

| Rust | WASM binding name |
|------|-------------------|
| `GameBoy::queue_serial_byte_wa(&mut self, byte: u8)` | `queue_serial_byte_wa` |

Generated type declaration: `frontends/web/lib/boytacean.d.ts`

```typescript
queue_serial_byte_wa(byte: number): void;
```

### TypeScript wrapper

**File:** `frontends/web/ts/gb.ts`  
**Class:** `GameboyEmulator`

```typescript
queueSerialByte(byte: number) {
    this.gameBoy?.queue_serial_byte_wa(byte & 0xff);
}
```

Placed near `loadLoggerDevice()`, `onLoggerDevice()`, `loadPrinterDevice()`.

### React usage

**File:** `frontends/web/react/components/serial-section/serial-section.tsx`  
**Function:** `sendAskToBridge`

After `fetch()` resolves and `queueReplyForGameBoy(data.reply ?? "")` runs:

```typescript
while (gbReplyQueue.length > 0) {
    const queuedReplyByte = gbReplyQueue.shift()!;
    emulator.queueSerialByte(queuedReplyByte);
    // logs [Boytacean bridge] queued byte into WASM serial input
}
```

Bytes are queued into WASM **only after the async `fetch()` completes**, not from inside the logger callback.

### Reentrancy issue and fix

**Broken approach (removed):** Calling `emulator.queueSerialByte()` from inside `onLoggerData`, which runs synchronously during the WASM → JS `loggerCallback`.

**Symptom:**

```text
recursive use of an object detected which would lead to unsafe aliasing in rust
```

**Cause:** Re-entering the WASM `GameBoy` borrow while still inside a WASM callback (`StdoutDevice::receive` → `logger_callback`).

**Fix:** Queue reply bytes in `sendAskToBridge` after `await response.json()`, outside the logger callback execution context.

---

## 8. GB Studio ROM test implementation

> **Note:** The test ROM is built in an external GB Studio project, not stored in this repository. This section documents the behavior verified against the current proof-of-concept.

### Send path

- A **button press** triggers custom **`VM_ASM`** that writes `ASK:HI\n` via serial registers.
- Each character byte → **SB (`0xFF01`)**, then **SC (`0xFF02`)** with transfer-start bit set.
- The trailing `\n` (`0x0A`) completes the frontend’s newline-delimited message.

### Receive path (current 3-byte proof)

- After sending, the ROM performs **three receive-side serial transfers** (one per expected reply byte).
- Each completed transfer raises the serial interrupt; the ROM reads **SB (`0xFF01`)** (GB Studio ASM equivalent: `ldh a,(0x01)`).
- Received byte values are stored into GB Studio **global variables** `Reply1`, `Reply2`, `Reply3`.
- A **Display Dialogue** event shows the combined reply.

### Serial interrupt protection (prototype only)

The ROM wraps the network-wait receive sequence with:

1. **`di`** — disable interrupts
2. Custom serial transfer loops (send/receive)
3. Clear serial interrupt flag — **bit 3** of **`0xFF0F` (IF register)**
4. **`ei`** — re-enable interrupts

This prevents unrelated interrupts from firing during the coarse wait/receive loop.

### Why this is prototype-only

Disabling interrupts across an unbounded **network round-trip wait** is unacceptable for a shipping game:

- Audio, VBlank, and timer interrupts are blocked for the duration.
- Real games need non-blocking protocols, timeouts, and engine-level integration.

The current ROM ASM is **inline test code**, not a reusable GB Studio custom event or engine plugin.

---

## 9. GB Studio variable storage hack

> **Assumption / hack — verify after every GB Studio rebuild.**

### How GB Studio stores globals

GB Studio global variables live in **`script_memory`** as **16-bit values** (the low byte holds the ASCII character code for this proof).

### Locating `script_memory`

The current proof used the generated **`.sym` file** from the GB Studio build to find the linker symbol **`_script_memory`** and derive WRAM offsets for the global variables.

### Current mapping (this build)

```text
Reply1 → script_memory[0]   (16-bit; low byte = first reply character)
Reply2 → script_memory[1]
Reply3 → script_memory[2]
```

Each reply byte (`O`=79, `K`=75, `!`=33) is written into the low byte of the corresponding 16-bit slot.

### Warnings

- **Hardcoded WRAM addresses are build-dependent.** Rebuilding the GB Studio project, changing engine version, or adding/removing globals can shift `_script_memory` and break the mapping.
- **Always re-confirm `_script_memory` in the new `.sym` file** before testing.
- A **proper GB Studio engine helper / custom event** should replace direct WRAM writes in any non-prototype work.

### Do not use `0xFF80–0xFF82` (HRAM)

An earlier attempt stored reply bytes in HRAM addresses `FF80`–`FF82`. **This failed:**

- GB Studio uses HRAM in that range for engine routines.
- Writing there caused **corruption, panics, and incorrect variable values**.

Use `script_memory` (WRAM-backed globals) instead.

---

## 10. Dialogue rendering

GB Studio variables displayed directly showed **numeric ASCII codes**:

```text
79 75 33
```

(decimal for `O`, `K`, `!`)

### Character rendering syntax

GB Studio dialogue text must use the **`%c$VariableName`** format to interpret a variable’s value as a **character** rather than a number.

Verified working syntax in this project:

```text
%c$Reply1%c$Reply2%c$Reply3
```

Renders:

```text
OK!
```

Each `%c$ReplyN` reads the 16-bit variable and displays its value as a single character.

---

## 11. Current limitations

| Limitation | Detail |
|------------|--------|
| Fixed reply length | ROM expects exactly **3 bytes**; longer/shorter replies will misalign |
| Hardcoded Node reply | `server.js` always returns `"OK!"` |
| Prototype timing | No formal request/response framing, timeouts, or back-pressure |
| Debug instrumentation | `serialQueueDebugCallback`, `serialInputDebugCallback`, `serialSbReadDebugCallback`, and verbose `console.log` calls remain |
| Non-reusable ROM code | Inline `VM_ASM`, not a GB Studio plugin/custom event |
| No error protocol | Failed fetch or server errors are logged in browser console only; ROM is not notified |
| No dynamic text buffer | No pagination, chunking, or multi-line dialogue support |
| Interrupt masking | `di`/`ei` around network wait is not viable for production |
| Build-dependent RAM hack | `script_memory` indices must be revalidated per GB Studio build |

---

## 12. Recommended next steps

1. **Variable-length protocol** — e.g. newline-terminated text with a max page size and length prefix or header line.
2. **Fixed RAM reply buffer** — engine-owned buffer with page/chunk indices instead of per-character global variables.
3. **Node-side splitting** — break long server/LLM replies at Game Boy dialogue-friendly boundaries before queueing bytes.
4. **GB Studio engine integration** — custom event or plugin API for send/receive/display without hardcoded WRAM addresses.
5. **Remove debug callbacks** — after preserving a known-good commit, strip `serialQueueDebugCallback`, `serialInputDebugCallback`, `serialSbReadDebugCallback`, and verbose bridge logs.
6. **Request IDs and error responses** — e.g. `ERR:TIMEOUT\n`, `ERR:NET\n`, plus queued-message state so the ROM can retry or show failure dialogue.
7. **Non-blocking ROM design** — state machine driven by serial interrupts without long `di` regions.

---

## 13. Verification checklist

Run Node bridge and web frontend, load the GB Studio test ROM, set Serial device to **Logger**, then:

- [ ] **Node terminal** shows `[GB bridge server] received:` with `message: 'ASK:HI'` (or similar) on button press.
- [ ] **Browser console** shows `[Boytacean serial message] ASK:HI` and `[Boytacean bridge] prompt: HI`.
- [ ] **Browser console** shows `[Boytacean bridge] server reply: OK!`.
- [ ] **Browser console** shows three `[Boytacean bridge] queued byte into WASM serial input:` entries for `O` (`0x4f`), `K` (`0x4b`), `!` (`0x21`).
- [ ] **Browser console** shows `[Boytacean serial queue debug]` with `stage: "pop_queue"` (and/or `[Boytacean serial input debug]`) as the ROM consumes queued bytes.
- [ ] **Browser console** shows `[Boytacean SB read debug]` with values `79`, `75`, `33` when the ROM reads SB after each receive transfer.
- [ ] **GB Studio dialogue** displays **`OK!`** (not `79 75 33`).
- [ ] **Repeat** the button press **several times without browser refresh** — each request should succeed (null-byte parser fix verified).

---

## Quick reference — key files and symbols

| Path | Symbols |
|------|---------|
| `bridge-server/server.js` | HTTP server, `GB_MESSAGE_PATH`, `sendJson`, hardcoded `reply` |
| `frontends/web/react/components/serial-section/serial-section.tsx` | `SerialSection`, `onLoggerData`, `sendAskToBridge`, `queueReplyForGameBoy`, `gbReplyQueue` |
| `frontends/web/ts/gb.ts` | `GameboyEmulator`, `loadLoggerDevice`, `onLoggerDevice`, `queueSerialByte`, `window.loggerCallback` |
| `src/gb.rs` | `load_logger_wa`, `queue_serial_byte_wa`, `serial()` |
| `src/serial.rs` | `Serial`, `queue_byte`, `write` (SC_ADDR), `tick_transfer`, `read` (SB_ADDR) |
| `src/devices/stdout.rs` | `StdoutDevice::receive` → logger callback |
| `src/mmu.rs` | `0xff01..=0xff02` dispatch |
| `src/cpu.rs` | Serial interrupt handler `0x58`, IF bit 3 |
| `src/consts.rs` | `SB_ADDR`, `SC_ADDR` |
