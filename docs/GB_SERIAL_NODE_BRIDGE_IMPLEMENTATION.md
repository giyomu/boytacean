# GB Serial ↔ Node Bridge — Implementation Guide

Architecture and maintenance reference for the **current stable** Boytacean SDL + Node bridge integration as of **2026-07-11**.

This document lives in the Boytacean repository and describes the desktop path. GB Studio ROM behavior, variable symbols, and dialogue sizing are documented separately in the external UI ROM Test project.

**Related docs (external GB Studio project):**

- [`Boytacean_UI_ROM_Test/docs/GB_SERIAL_AI_INTEGRATION.md`](../../Boytacean_UI_ROM_Test/docs/GB_SERIAL_AI_INTEGRATION.md) — full ROM integration guide
- [`Boytacean_UI_ROM_Test/docs/DEV_DIARY.md`](../../Boytacean_UI_ROM_Test/docs/DEV_DIARY.md) — developer diary index
- [`Boytacean_UI_ROM_Test/docs/dev-diary-2026-07-10.md`](../../Boytacean_UI_ROM_Test/docs/dev-diary-2026-07-10.md) — auto-polling, symbol globals, dynamic hint boxes

**Related docs (this repo):**

- [`STANDALONE_BOYTACEAN_ROM_RUN.md`](STANDALONE_BOYTACEAN_ROM_RUN.md) — native SDL run guide and helper scripts

---

## 1. Purpose

A GB Studio ROM running in **Boytacean SDL** sends AI hint requests over emulated Game Boy serial hardware. A local **Node bridge server** forwards those requests to **Ollama**, returns `WAIT` while a hint job runs, then delivers a cleaned uppercase hint phrase. The ROM stores the final text in a fixed WRAM sentence buffer and displays it through dynamically sized GB Studio dialogue overlays.

The verified desktop round-trip:

```text
menu → select hint → ASK:HINT:* → WAIT → auto-retry → final hint → A to dismiss → menu
```

No extra **A** press is required during `WAIT` polling.

---

## 2. Current End-to-End Architecture

```text
GB Studio ROM (Boytacean_UI_ROM_Test)
  → Game Boy serial SB/SC (0xFF01 / 0xFF02)
  → Boytacean SDL NodeBridgeDevice
  → HTTP POST /api/gb-message
  → bridge-server/server.js
  → Ollama asynchronous hint job (qwen2.5:3b)
  → HTTP reply: WAIT or final hint
  → Boytacean SDL queues newline-terminated reply bytes
  → Serial incoming queue → ROM receive path
  → WRAM 0xC640 sentence buffer
  → ui_measure_serial_hint_size() + ui_load_serial_text()
  → GB Studio dialogue (small / medium / large preset)
```

### Primary implementation files

| File | Role |
|------|------|
| `frontends/sdl/src/devices/node_bridge.rs` | SDL serial device: captures `ASK:*` lines, POSTs to Node, queues reply bytes |
| `frontends/sdl/src/main.rs` | `--device node`, `--node-url`, reply queue drain into emulator |
| `bridge-server/server.js` | HTTP bridge, per-command Ollama jobs, hint cleanup |
| `src/serial.rs` | Incoming serial byte queue used by SDL and WASM paths |
| `src/gb.rs` | `queue_serial_byte` delegation to CPU serial |

### External GB Studio project (not in this repo)

| Path | Role |
|------|------|
| `Boytacean_UI_ROM_Test/project/scenes/ai_hint_menu_test/scene.gbsres` | `AI_Hint_Menu_Test` / `scene_2` — serial ASM, polling, dynamic overlays |
| `Boytacean_UI_ROM_Test/assets/engine/src/core/vm_ui.c` | `ui_load_serial_text()`, `ui_measure_serial_hint_size()` |
| `Boytacean_UI_ROM_Test/build/rom/boytacean_ui_rom_test.gb` | Test ROM output after GB Studio export |

---

## 3. Current Protocol

### ROM → Node (requests)

All requests are sent one ASCII byte at a time through SB/SC, newline-terminated:

| Payload | Menu option |
|---------|-------------|
| `ASK:HINT:GO\n` | WHERE TO GO? (default) |
| `ASK:HINT:DOOR\n` | HOW OPEN DOOR? |
| `ASK:HINT:SWITCH\n` | SWITCH? |
| `ASK:HINT:NEXT\n` | WHAT NEXT? |

The SDL bridge strips the `ASK:` prefix for the JSON `prompt` field but forwards the full `message` string.

### Node → ROM (replies)

| Payload | Meaning |
|---------|---------|
| `WAIT\n` | Ollama job running or not ready yet |
| `<HINT PHRASE>\n` | Completed hint (uppercase, sanitized, single protocol line) |

`WAIT` is an exact four-character match. The ROM leaves `SentenceReady` at 0 and does not show hint dialogue.

The SDL bridge appends `\n` to every queued reply if the Node response omits it.

### Async job lifecycle

Per-command state is maintained separately in `hintJobs` for `HINT:GO`, `HINT:DOOR`, `HINT:SWITCH`, and `HINT:NEXT`:

1. **First request** for a command with no running job and no ready reply → `startHintJob()` → returns `WAIT`.
2. **While job runs** → returns `WAIT`.
3. **When job completes** → next request returns the final hint and **consumes** it (`ready` and `reply` cleared).
4. **After consumption** → a later request starts a **new** Ollama job.

Each command has independent job state. A completed `HINT:GO` reply does not affect `HINT:DOOR`.

### HTTP request / response

**POST** `http://localhost:3000/api/gb-message`

Request JSON:

```json
{ "message": "ASK:HINT:GO", "prompt": "HINT:GO" }
```

Response JSON:

```json
{ "reply": "WAIT", "aiReply": "", "receivedPrompt": "HINT:GO" }
```

or, when ready:

```json
{ "reply": "GO EAST FIRST", "aiReply": "GO EAST FIRST", "receivedPrompt": "HINT:GO" }
```

---

## 4. SDL Node Bridge

### NodeBridgeDevice responsibilities

**File:** `frontends/sdl/src/devices/node_bridge.rs`

| Step | Behavior |
|------|----------|
| Outgoing | Accumulates bytes in `receive()` until `\n`, then flushes the line |
| Filter | Only lines starting with `ASK:` are forwarded to the worker thread |
| HTTP | Worker POSTs JSON to `--node-url` (default `http://localhost:3000/api/gb-message`) |
| Incoming | Reply string is pushed into a shared `VecDeque<u8>` with trailing `\n` |
| Error | HTTP/parse failures enqueue `LINK ERROR\n` |

### Reply delivery into the emulator

**File:** `frontends/sdl/src/main.rs`

1. `build_device("node", node_url)` creates `NodeBridgeDevice` and a shared reply queue.
2. `emulator.set_serial_reply_queue(queue)` connects the queue to the emulator loop.
3. Each frame, `drain_serial_replies()` moves queued bytes into `system.queue_serial_byte()`.
4. `src/serial.rs` pops queued bytes during SC transfer start so the ROM reads them from SB.

### Expected SDL logs

| Log prefix | When |
|------------|------|
| `[NODE BRIDGE OUT]` | Complete outgoing line captured from ROM serial |
| `[NODE BRIDGE SEND]` | HTTP worker dispatching the `ASK:*` message |
| `[NODE BRIDGE HTTP]` | HTTP response status code |
| `[NODE BRIDGE IN]` | Reply string received from Node |
| `[NODE BRIDGE QUEUE]` | Reply bytes enqueued for emulated serial input |
| `[NODE BRIDGE ERROR]` | HTTP or enqueue failure |

Example successful sequence:

```text
[NODE BRIDGE OUT] ASK:HINT:GO
[NODE BRIDGE SEND] ASK:HINT:GO
[NODE BRIDGE HTTP] status 200
[NODE BRIDGE IN] WAIT
[NODE BRIDGE QUEUE] WAIT
...
[NODE BRIDGE IN] GO EAST FIRST
[NODE BRIDGE QUEUE] GO EAST FIRST
```

### Why SDL replaces the browser Logger path for desktop testing

The historical browser/WASM path used the React **Logger** serial device and `serial-section.tsx` to POST to Node and call `queueSerialByte()` into WASM. The SDL `NodeBridgeDevice` performs the same bridge role natively:

- No browser, WASM rebuild, or static web server required
- No React reentrancy issues from queuing bytes inside logger callbacks
- Same HTTP endpoint and newline-delimited protocol

---

## 5. Node Server and Ollama Jobs

**File:** `bridge-server/server.js`

Standalone Node.js HTTP server on port **3000**, path `/api/gb-message`. No npm dependencies beyond Node built-ins.

### Hint command routing

`HINT_COMMANDS` handles `HINT:GO`, `HINT:DOOR`, `HINT:SWITCH`, `HINT:NEXT` through `handleHintRequest()`. Other `ASK:*` traffic may still trigger legacy `askOllama()` / `GET_REPLY` paths; hint testing uses the four `HINT:*` commands above.

### Ollama integration

- Model: **`qwen2.5:3b`** at `http://localhost:11434/api/generate`
- Each hint command has dungeon-context prompts in `HINT_PROMPTS`
- `askOllamaHint()` calls Ollama, then passes the raw response through `cleanHintReply()`
- On Ollama failure, the job stores `NO HINT AVAILABLE` as the ready reply

### Development test mode

Set `DEV_HINT_LAYOUT_TEST=1` to bypass Ollama and return fixed layout-test replies per command:

| Command | Fixed reply |
|---------|-------------|
| `HINT:GO` | `GO EAST FIRST` (1 wrapped line) |
| `HINT:DOOR` | `CHECK BEHIND THE STATUE` (2 lines) |
| `HINT:SWITCH` | `RETURN TO THE LOCKED DOOR AFTER SEARCHING EAST` (3 lines) |
| `HINT:NEXT` | same 3-line phrase as `HINT:SWITCH` |

Replies still pass through `cleanHintReply()`. Remove this mode before release.

---

## 6. Reply Cleanup and 3-Line Enforcement

**Function:** `cleanHintReply()` in `bridge-server/server.js`

### Sanitization

1. Convert CR, LF, tabs to spaces: `.replace(/[\r\n\t]+/g, " ")`
2. Convert other removed non-printables to spaces: `.replace(/[^\x20-\x7E]/g, " ")`
3. Remove digits and punctuation (letters and spaces only)
4. Collapse whitespace and uppercase

This prevents merged words when Ollama returns internal line breaks, e.g. `GO EAST FIRST\nEXPLORE CONNECTED` → `GO EAST FIRST EXPLORE CONNECTED` (not `FIRSTEXPLORE`).

The same CR/LF/tab-to-space pattern is applied in `cleanAiReply()` for the legacy non-hint path.

### Length and wrap enforcement

| Rule | Value |
|------|-------|
| Wrap width | 17 printable columns (matches ROM `SERIAL_HINT_WRAP_WIDTH`) |
| Max wrapped lines | 3 |
| Preliminary raw cap | 48 characters |
| Trim method | Whole words only — never `substring(0, 48)` |
| Trailing connectors removed | `AND`, `OR`, `BUT`, `TO`, `THE`, `A`, `AN`, `OF`, `IN`, `ON`, `WITH`, `AFTER`, `BEFORE` |
| Fallback | `SEARCH THE EAST ROOM` for empty or unusable output |

`trimHintWords()` pops trailing words until wrap line count ≤ 3, raw length ≤ 48, and the phrase does not end on a connector word.

`wrapHintLines()` mirrors the ROM word-wrap rules in `ui_load_serial_text()`.

### Self-test

```powershell
node bridge-server\server.js --test-hint-cleanup
```

Runs sample inputs (including newline/tab cases) and prints cleaned text, character count, line count, and wrapped representation. Does not start the HTTP server.

### Prompt quality note

Cleanup and transport are correct, but Ollama can still return multiple short instructions in one hint (e.g. `GO EAST FIRST EXPLORE CONNECTED`). That is a prompt-quality issue, not a display or serial bug.

---

## 7. GB Studio ROM Integration

> Full detail: [`Boytacean_UI_ROM_Test/docs/GB_SERIAL_AI_INTEGRATION.md`](../../Boytacean_UI_ROM_Test/docs/GB_SERIAL_AI_INTEGRATION.md)

### Scene

- **Name:** `AI_Hint_Menu_Test`
- **Symbol:** `scene_2`
- **File:** `Boytacean_UI_ROM_Test/project/scenes/ai_hint_menu_test/scene.gbsres`

### Serial and polling (On Init script)

- `VM_ASM` sends `ASK:HINT:<suffix>\n` based on `HintSelectedOption`
- Reads reply bytes into **`0xC640`–`0xC6BF`** until `\n`
- Exact `WAIT\0` leaves `SentenceReady` at 0
- Any other completed reply sets `SentenceReady = 1`
- **`PollingActive`** skips the menu during retries — no extra A press while polling
- **`RetryCount`** increments on each `WAIT`; at **10** retries shows `LINK BUSY\nTRY AGAIN`, resets state, returns to menu
- Scene reloads on each poll attempt (~0.5 s wait)

### Variable access (current — no hardcoded global WRAM)

GB Studio globals are accessed through generated linker symbols, not fixed addresses:

```asm
ld bc,#_script_memory
ld hl,#VAR_SENTENCEREADY   ; or VAR_HINTSELECTEDOPTION, VAR_POLLINGACTIVE, etc.
add hl,hl                  ; index × 2 (16-bit variables)
add hl,bc
```

Reconfirm `VAR_*` indices in `build/rom/globals.i` after any variable reorder in GB Studio.

### Runtime text rendering (custom engine helpers)

In `Boytacean_UI_ROM_Test/assets/engine/src/core/vm_ui.c`:

| Function | Role |
|----------|------|
| `ui_measure_serial_hint_size()` | Counts wrapped lines at 17 columns → `HintBoxSize` preset |
| `ui_load_serial_text()` | Copies `0xC640` text into `ui_text_data` with word wrap |

| `HintBoxSize` | Wrapped lines | Overlay preset |
|---------------|---------------|----------------|
| `0` | 1 | small — 20×3 |
| `1` | 2 | medium — 20×4 |
| `2` | 3+ | large — 20×5 |

Player dismisses only the **final** hint with **A**; `WAIT` polling does not require A.

---

## 8. Local Run Instructions

### Prerequisites

- Boytacean repo with SDL frontend built
- Ollama running at `http://localhost:11434` with **`qwen2.5:3b`** pulled
- GB Studio ROM built from `Boytacean_UI_ROM_Test.gbsproj`

**The Node bridge must start before the emulator.**

### Preferred: local PowerShell helpers

When present on your machine (typically not committed — machine-specific paths):

1. **`run_bridge_okinawa.ps1`** — starts `node bridge-server\server.js`
2. **`run_boytacean_rom_okinawa.ps1`** — launches Boytacean SDL with `--device node` and your ROM path

See [`STANDALONE_BOYTACEAN_ROM_RUN.md`](STANDALONE_BOYTACEAN_ROM_RUN.md) for details.

### Manual fallback

**Terminal 1 — Node bridge:**

```powershell
cd D:\GBStudio\boytacean
node bridge-server\server.js
```

Expected log:

```text
[GB bridge server] listening on http://0.0.0.0:3000
```

**Terminal 2 — Boytacean SDL:**

```powershell
cd D:\GBStudio\boytacean
cargo run -p boytacean-sdl -- --device node --node-url http://localhost:3000/api/gb-message "D:\GBStudio\Boytacean_UI_ROM_Test\build\rom\boytacean_ui_rom_test.gb"
```

### Layout test mode (optional)

**Terminal 1:**

```powershell
$env:DEV_HINT_LAYOUT_TEST="1"
node bridge-server\server.js
```

Confirm log: `DEV_HINT_LAYOUT_TEST=1 — fixed layout replies enabled`

Test each menu option (GO → 1 line, DOOR → 2 lines, SWITCH → 3 lines), then disable:

```powershell
Remove-Item Env:DEV_HINT_LAYOUT_TEST
```

---

## 9. Validation Checklist

- [ ] Node bridge starts before emulator
- [ ] ROM emits `ASK:HINT:*` (check `[NODE BRIDGE OUT]` / `[NODE BRIDGE SEND]`)
- [ ] First request returns `WAIT` while Ollama runs
- [ ] Later poll returns final hint (no extra **A** during `WAIT`)
- [ ] No joined words when Ollama returns internal line breaks (e.g. not `FIRSTEXPLORE`)
- [ ] All replies fit within 3 wrapped lines at 17 columns
- [ ] Small, medium, and large dialogue presets display correctly
- [ ] All four commands tested: `HINT:GO`, `HINT:DOOR`, `HINT:SWITCH`, `HINT:NEXT`
- [ ] Final hint dismisses with **A** and returns to menu
- [ ] Next menu request starts a fresh Ollama job (completed reply was consumed)
- [ ] `node bridge-server\server.js --test-hint-cleanup` passes expected sanitize cases

---

## 10. Known Limitations

| Limitation | Detail |
|------------|--------|
| Scene reload on WAIT | Each poll reloads the same scene (~0.5 s); simple but not zero-cost |
| Synchronous serial ASM | `di`/`ei` around send/receive briefly freezes normal interrupt handling |
| Manually reserved buffer | `0xC640`–`0xC6BF` is project-reserved; not managed by GB Studio globals |
| Prompt quality | Ollama may still produce awkward multi-instruction hints despite cleanup |
| Fork-only integration | Upstream Boytacean `master` does not include this GB Studio AI terminal work; current integration lives in the user's SDL test / AI integration branch in their fork |
| Browser/WASM path | Historical Logger + React bridge may not match current SDL behavior — see §12 |
| Retry ceiling | After 10 `WAIT` polls, ROM shows `LINK BUSY / TRY AGAIN` and aborts |

---

## 11. Maintenance Notes

- After GB Studio variable changes, rebuild ROM and verify `VAR_*` symbols in `build/rom/globals.i`
- After engine helper changes in `vm_ui.c`, rebuild ROM in GB Studio
- Hint cleanup changes require only a Node bridge restart (no ROM rebuild)
- SDL bridge changes require rebuilding `boytacean-sdl`
- Do not document `script_memory` offsets as stable addresses — use `VAR_*` symbols only
- Keep `DEV_HINT_LAYOUT_TEST` disabled for normal Ollama testing

---

## 12. Historical Browser/WASM Proof (Obsolete)

> **This section describes the first proof-of-concept only.** It is **not** the current testing path. Use Boytacean SDL with `--device node` for all current work.

### What was proven (early 2025)

The first successful round-trip used the **browser/WASM** frontend with the React **Logger** serial device:

```text
GB Studio ROM → WASM serial → React Logger panel → Node bridge → WASM queue → ROM dialogue
```

| Step | Data |
|------|------|
| ROM request | `ASK:HI\n` |
| Node reply | hardcoded `"OK!"` |
| Bytes queued | exactly 3: `O`, `K`, `!` |
| GB Studio display | `%c$Reply1%c$Reply2%c$Reply3` → **`OK!`** |

### Historical ROM design

- Three receive transfers for exactly **3 reply bytes**
- Bytes stored in globals `Reply1`, `Reply2`, `Reply3` at hardcoded `script_memory` offsets (build-dependent)
- `di`/`ei` around serial loops; IF bit 3 cleared before `ei`
- Display used `%c$VariableName` to render ASCII codes as characters (not decimal `79 75 33`)

### Historical frontend fixes (still informative)

| Issue | Fix |
|-------|-----|
| `0x00` bytes during receive polluted the outgoing message buffer | Ignore `0x00` in `onLoggerData` before line assembly |
| WASM reentrancy panic when queuing inside logger callback | Queue reply bytes only after `fetch()` resolves, outside the callback |
| Garbage in SB after queued receive | Set `self.data = self.byte_receive` at transfer completion in `Serial::tick_transfer()` |

### Historical files (browser path)

| Path | Role |
|------|------|
| `frontends/web/react/components/serial-section/serial-section.tsx` | Logger bridge, `sendAskToBridge`, `gbReplyQueue` |
| `frontends/web/ts/gb.ts` | `queueSerialByte()`, `loadLoggerDevice()` |
| `src/serial.rs` | `incoming` queue, `queue_byte()`, `receive_from_queue` |
| `src/gb.rs` | `queue_serial_byte_wa()` WASM export |

### Why it mattered

This proof established that:

- Newline-delimited `ASK:*` serial lines could cross the emulator boundary reliably
- Host-supplied serial input bytes could be delivered to ROM receive code through SB
- A Node server could sit behind the emulator without changing the GB Studio engine

The current SDL + Ollama + dynamic dialogue system replaces the 3-byte `OK!` proof with variable-length hints, `WAIT` polling, `0xC640` sentence buffer, and runtime overlay sizing.

---

## 13. Key Files

| Path | Role |
|------|------|
| `bridge-server/server.js` | HTTP server, Ollama jobs, `cleanHintReply()`, dev test mode |
| `frontends/sdl/src/devices/node_bridge.rs` | `NodeBridgeDevice`, HTTP worker, reply queue |
| `frontends/sdl/src/main.rs` | CLI `--device node`, `--node-url`, `drain_serial_replies()` |
| `src/serial.rs` | Incoming byte queue, transfer integration |
| `src/gb.rs` | `queue_serial_byte()` |
| `src/mmu.rs` | SB/SC register dispatch (`0xFF01`–`0xFF02`) |
| `src/consts.rs` | `SB_ADDR`, `SC_ADDR` |
| `Boytacean_UI_ROM_Test/project/scenes/ai_hint_menu_test/scene.gbsres` | ROM serial + polling + overlay branches |
| `Boytacean_UI_ROM_Test/assets/engine/src/core/vm_ui.c` | Serial text load and box sizing |

### Fixed addresses still intentional

| Address | Purpose |
|---------|---------|
| `0xFF01` | SB — serial data |
| `0xFF02` | SC — serial control |
| `0xFF0F` | IF — interrupt flag (bit 3 cleared after serial block) |
| `0xC640`–`0xC6BF` | Serial sentence buffer (up to `0x7F` payload bytes + null) |

Do **not** treat `script_memory` global offsets as stable across GB Studio rebuilds.

---

## 14. Current Status

As of **2026-07-11**, the stable desktop path is:

```text
Boytacean SDL (--device node) + bridge-server/server.js + Ollama
  ↔ Boytacean_UI_ROM_Test AI_Hint_Menu_Test ROM
```

**Working:**

- Four `ASK:HINT:*` commands with per-command async jobs and `WAIT` polling
- Newline-terminated replies through SDL `NodeBridgeDevice`
- `0xC640` sentence buffer and `SentenceReady` via `VAR_*` symbols
- Dynamic small / medium / large dialogue presets (1–3 wrapped lines at 17 columns)
- Hint cleanup with whole-word trim, connector-word removal, and CR/LF/tab sanitization
- `DEV_HINT_LAYOUT_TEST` and `--test-hint-cleanup` for deterministic layout testing

**Open:**

- Ollama prompt quality (multi-instruction hints)
- Scene reload cost on each `WAIT` poll
- Upstream merge of fork-only integration

**Obsolete for current testing:**

- Browser/WASM Logger bridge, `ASK:HI` → `OK!`, 3-byte `Reply1/2/3` proof
