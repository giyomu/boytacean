# Game Boy Emulator + Local Node Bridge — Localhost Memo

## Project folders

```text
E:\GBStudio\boytacean
E:\GBStudio\boytacean\bridge-server
```

## 1. Start the Node bridge server

Open a Cursor terminal in the Boytacean project folder, then run:

```powershell
node bridge-server/server.js
```

Expected result:

```text
[GB bridge server] listening on http://localhost:3000
```

Keep this terminal open while testing.

---

## 2. Start the Boytacean web emulator

Open a second terminal in:

```text
E:\GBStudio\boytacean
```

Run the normal development command used by the project:

```powershell
npm run dev
```

Cursor/Vite should print a localhost address, usually similar to:

```text
http://localhost:5173
```

Open that address in the browser.

---

## 3. Load and test the ROM

1. Load the GB Studio ROM in Boytacean.
2. Open browser Developer Tools (`F12`) and keep the Console visible.
3. Trigger the GB Studio event that sends the serial command, for example:

```text
ASK:HI
```

4. Confirm the data flows through each layer:

```text
GB Studio ROM
  -> emulated Game Boy serial output
  -> Boytacean serial hook / frontend console
  -> Node bridge server
  -> Node terminal log
```

Example Node terminal output:

```text
[GB bridge server] received: { message: 'ASK:HI', prompt: 'HI' }
```

---

## 4. Current two-terminal routine

### Terminal A — bridge

```powershell
cd E:\GBStudio\boytacean
node bridge-server/server.js
```

### Terminal B — emulator frontend

```powershell
cd E:\GBStudio\boytacean
npm run dev
```

Then open the localhost URL printed by Terminal B.

---

## 5. If it does not work

- Make sure both terminals are still running.
- Reload the browser page after changing frontend/emulator code.
- Rebuild/export the GB Studio ROM after changing GB Studio events or scripts, then reload the new ROM.
- Check the browser Console for `[Boytacean serial]` logs.
- Check the Node terminal for `[GB bridge server] received:` logs.
- Make sure port `3000` is not already used by another process.

---

## Current goal after outgoing messages work

Implement the opposite direction:

```text
Node server reply
  -> Boytacean frontend
  -> injected serial bytes into the emulated Game Boy
  -> GB Studio custom helper receives text
  -> dynamic text buffer displays the reply
```

