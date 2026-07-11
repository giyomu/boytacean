const http = require("http");

const PORT = 3000;
const HOST = "0.0.0.0";
const GB_MESSAGE_PATH = "/api/gb-message";

// DEV_ONLY: set DEV_HINT_LAYOUT_TEST=1 to bypass Ollama and return fixed
// layout-test replies mapped by hint command (remove before release).
const DEV_HINT_LAYOUT_TEST = process.env.DEV_HINT_LAYOUT_TEST === "1";
const DEV_HINT_TEST_REPLIES = {
  "HINT:GO": "GO EAST FIRST",
  "HINT:DOOR": "CHECK BEHIND THE STATUE",
  "HINT:SWITCH": "RETURN TO THE LOCKED DOOR AFTER SEARCHING EAST",
  "HINT:NEXT": "RETURN TO THE LOCKED DOOR AFTER SEARCHING EAST",
};

const HINT_WRAP_WIDTH = 17;
const HINT_MAX_LINES = 3;
// preliminary raw cap before wrap enforcement; final fit is decided by line count
const HINT_RAW_CHAR_LIMIT = 48;
const HINT_FALLBACK = "SEARCH THE EAST ROOM";
const HINT_CONNECTOR_WORDS = new Set([
  "AND",
  "OR",
  "BUT",
  "TO",
  "THE",
  "A",
  "AN",
  "OF",
  "IN",
  "ON",
  "WITH",
  "AFTER",
  "BEFORE",
]);

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return "*";
  }
  if (
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("http://[::1]:")
  ) {
    return origin;
  }
  return "null";
}

function cleanAiReply(text) {
  let cleaned = String(text || "")
    .replace(/[._]+/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const banned = [
    "GET KEY",
    "GIVE KEY",
    "SECRET PASSAGE EXISTS HERE",
    "FIND KEY",
  ];

  if (
    cleaned.length < 12 ||
    banned.includes(cleaned) ||
    cleaned.split(" ").length < 4
  ) {
    cleaned = "SEARCH NEAR THE STATUE";
  }

  const forbiddenWords = [
    "WAREHOUSE",
    "ZORA",
    "HYRULE",
    "LINK",
    "GANON",
    "PRINCESS",
    "CASTLE",
    "MASTER SWORD",
  ];

  if (forbiddenWords.some((word) => cleaned.includes(word))) {
    cleaned = "CHECK THE TORCH BESIDE THE DOOR";
  }

  return cleaned.slice(0, 48);
}

// matches ui_load_serial_text() / count_serial_hint_lines() in vm_ui.c
function wrapHintLines(text) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    if (current.length > 0) {
      if (current.length + 1 + word.length > HINT_WRAP_WIDTH) {
        lines.push(current);
        current = word;
      } else {
        current += " " + word;
      }
    } else {
      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function countHintWrapLines(text) {
  return wrapHintLines(text).length;
}

function endsWithConnectorWord(text) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return false;
  }
  return HINT_CONNECTOR_WORDS.has(words[words.length - 1]);
}

function trimHintWords(words) {
  let trimmed = words.slice();

  while (trimmed.length > 0) {
    const phrase = trimmed.join(" ");
    const lineCount = countHintWrapLines(phrase);

    if (
      lineCount <= HINT_MAX_LINES &&
      phrase.length <= HINT_RAW_CHAR_LIMIT &&
      !endsWithConnectorWord(phrase)
    ) {
      return phrase;
    }

    trimmed.pop();
  }

  return "";
}

function cleanHintReply(text) {
  let cleaned = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/[0-9]/g, "")
    .replace(/[^A-Za-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const greetingPrefixes = [
    "HELLO ",
    "HI ",
    "HEY ",
    "GREETINGS ",
    "WELCOME ",
  ];
  for (const prefix of greetingPrefixes) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length).trim();
    }
  }

  const bannedWords = [
    "AI",
    "TERMINAL",
    "USER",
    "PLAYER",
    "PROMPT",
    "QUESTION",
  ];

  let words = cleaned.split(" ").filter(Boolean);
  words = words.filter((word) => !bannedWords.includes(word));

  if (words.length < 2) {
    return HINT_FALLBACK;
  }

  cleaned = trimHintWords(words);

  if (!cleaned || countHintWrapLines(cleaned) < 1) {
    return HINT_FALLBACK;
  }

  return cleaned;
}

function cleanGameBoyReply(text, maxLength = 28) {
  let cleaned = String(text || "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9 .,!?'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  if (!cleaned || cleaned.length <= maxLength) {
    return cleaned;
  }

  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace === -1) {
    return truncated;
  }

  return truncated.slice(0, lastSpace).trim();
}

const HINT_COMMANDS = new Set([
  "HINT:GO",
  "HINT:DOOR",
  "HINT:SWITCH",
  "HINT:NEXT",
]);

const DUNGEON_CONTEXT = `Dungeon facts:
- The first useful route is east.
- A locked door requires a key.
- The key is found in another room.
- One hidden stair appears after activating a switch.
- The switch is near or behind a statue.
- Secret paths may be behind walls.
- The player should explore connected rooms before returning to a locked door.`;

const HINT_PROMPTS = {
  "HINT:GO":
    "Using only the dungeon facts above, give one short direction or exploration hint as a natural phrase of 2 to 6 words with spaces between every word. Examples: GO EAST FIRST / EXPLORE CONNECTED ROOMS / CHECK BEHIND THE WALL",
  "HINT:DOOR":
    "Using only the dungeon facts above, give one short hint about the key, the locked door, or returning later as a natural phrase of 2 to 6 words with spaces between every word. Examples: FIND THE KEY FIRST / RETURN AFTER EXPLORING / THE DOOR NEEDS A KEY",
  "HINT:SWITCH":
    "Using only the dungeon facts above, give one short hint about the switch, statue, wall, or hidden stair as a natural phrase of 2 to 6 words with spaces between every word. Examples: SEARCH BEHIND THE STATUE / CHECK THE WALL BEHIND / ACTIVATE THE SWITCH FIRST",
  "HINT:NEXT":
    "Using only the dungeon facts above, give one short next progression step hint as a natural phrase of 2 to 6 words with spaces between every word. Examples: GO EAST AND EXPLORE / FIND THE KEY NEXT / RETURN TO THE LOCKED DOOR",
};

const hintJobs = {};

function getHintJobState(command) {
  if (!hintJobs[command]) {
    hintJobs[command] = { running: false, ready: false, reply: "" };
  }
  return hintJobs[command];
}

function startHintJob(command) {
  const state = getHintJobState(command);
  if (state.running) {
    console.log("[GB bridge server] hint job already running for:", command);
    return;
  }

  console.log("[GB bridge server] starting hint job for:", command);

  state.running = true;
  state.ready = false;
  state.reply = "";

  askOllamaHint(command)
    .then((hintReply) => {
      state.reply = hintReply;
      state.ready = true;
      console.log("[Ollama hint ready]", command, state.reply);
    })
    .catch((err) => {
      state.reply = "NO HINT AVAILABLE";
      state.ready = true;
      console.error("[Ollama hint error]", command, err);
    })
    .finally(() => {
      state.running = false;
    });
}

function handleHintRequest(command) {
  const state = getHintJobState(command);

  if (state.ready && state.reply) {
    const reply = state.reply;
    state.ready = false;
    state.reply = "";
    return reply;
  }

  if (state.running) {
    return "WAIT";
  }

  startHintJob(command);
  return "WAIT";
}

async function askOllamaHint(command) {
  if (DEV_HINT_LAYOUT_TEST && DEV_HINT_TEST_REPLIES[command]) {
    return cleanHintReply(DEV_HINT_TEST_REPLIES[command]);
  }

  const contextPrompt = HINT_PROMPTS[command];
  const prompt = `${DUNGEON_CONTEXT}

${contextPrompt}

Output rules:
- Uppercase only
- Natural phrase with spaces between all words
- No numbers
- No punctuation
- Do not mention AI, terminal, user, player, prompt, or question
- Do not invent facts beyond the dungeon facts above
- Output only the hint phrase
- Keep the phrase short enough to wrap to at most 3 lines at 17 characters per line
- Prefer roughly 2 to 10 words`;

  const r = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:3b",
      prompt,
      stream: false,
    }),
  });

  if (!r.ok) {
    throw new Error(`Ollama HTTP ${r.status}`);
  }

  const data = await r.json();
  return cleanHintReply(data.response || "");
}

let aiJobRunning = false;
let latestAiReply = "";
let latestAiReady = false;

function startAiJob(command) {
  if (aiJobRunning) {
    console.log("[GB bridge server] AI job already running");
    return;
  }

  console.log("[GB bridge server] starting AI job for:", command);

  aiJobRunning = true;
  latestAiReady = false;
  latestAiReply = "";

  askOllama(command)
    .then((aiReply) => {
      latestAiReply = aiReply;
      latestAiReady = true;
      console.log("[Ollama reply ready]", latestAiReply);
    })
    .catch((err) => {
      latestAiReply = "NO AI REPLY";
      latestAiReady = true;
      console.error("[Ollama error]", err);
    })
    .finally(() => {
      aiJobRunning = false;
    });
}

async function askOllama(command) {
  const prompt = `You are an NPC in a small Game Boy dungeon crawler.
The player is in the first dungeon entrance.
There is a locked door.
A hidden switch can reveal stairs.
The NPC gives cryptic but useful hints.
Reply in one short sentence, max 48 characters.
Use spaces between words.
Do not use dots or underscores.
Uppercase ASCII only.
No markdown.
No explanation.
No Zelda names.

Use only this dungeon vocabulary when possible:
KEY, DOOR, TORCH, WALL, STATUE, SWITCH, STAIRS, ROOM, STONE

Avoid names or places from existing games.
Do not invent locations outside this dungeon.

Bad reply examples:
GIVE.KEY.HERE
SECRET_PASSAGE_EXISTS_HERE
GET_KEY

Good reply examples:
FIND THE KEY NEAR THE STATUE
TRY THE WALL BESIDE THE TORCH
A SWITCH HIDES UNDER STONE

Player command:
${command}`;

  const r = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:3b",
      prompt,
      stream: false,
    }),
  });

  if (!r.ok) {
    throw new Error(`Ollama HTTP ${r.status}`);
  }

  const data = await r.json();
  return cleanAiReply(data.response || "");
}

function sendJson(res, statusCode, data, req) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": getAllowedOrigin(req),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": getAllowedOrigin(req),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url === GB_MESSAGE_PATH) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" }, req);
      return;
    }

    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid request body" }, req);
      return;
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" }, req);
      return;
    }

    console.log("[GB bridge server] received:", body);

    const message = String(body.message || "").trim();
    const command = String(body.prompt || body.message || "").trim();

    const isGetReply =
      message === "ASK:GET_REPLY" ||
      command === "GET_REPLY" ||
      message.includes("GET_REPLY") ||
      command.includes("GET_REPLY");

    if (isGetReply) {
      console.log(
        "[GB bridge server] GET_REPLY requested. latestAiReady=" +
          latestAiReady +
          " latestAiReply=" +
          JSON.stringify(latestAiReply)
      );

      let reply;
      if (!latestAiReady) {
        if (aiJobRunning) {
          reply = "WAIT";
        } else if (!latestAiReply) {
          startAiJob("HI");
          reply = "WAIT";
        } else {
          reply = "WAIT";
        }
      } else {
        reply = latestAiReply;
      }

      console.log("[GB bridge server] replying to ROM:", reply);

      sendJson(res, 200, {
        reply,
        aiReply: latestAiReply || "",
        receivedPrompt: command,
      }, req);
      return;
    }

    if (HINT_COMMANDS.has(command)) {
      const reply = handleHintRequest(command);
      const state = getHintJobState(command);

      console.log(
        "[GB bridge server] hint request:",
        command,
        "->",
        reply,
        "running=" + state.running,
        "ready=" + state.ready
      );

      sendJson(
        res,
        200,
        {
          reply,
          aiReply: reply === "WAIT" ? "" : reply,
          receivedPrompt: command,
        },
        req
      );
      return;
    }

    startAiJob(command);

    const reply = "WAIT";
    console.log("[GB bridge server] replying to ROM:", JSON.stringify(reply));

    sendJson(res, 200, {
      reply,
      aiReply: "",
      receivedPrompt: command,
    }, req);
    return;
  }

  sendJson(res, 404, { error: "Not found" }, req);
});

function runHintCleanupSelfTest() {
  const samples = [
    "GO EAST FIRST",
    "CHECK BEHIND THE STATUE",
    "GO EAST FIRST\nEXPLORE CONNECTED",
    "CHECK THE WALL\r\nBEHIND",
    "RETURN TO\tTHE LOCKED DOOR",
    "RETURN TO LOCKED DOOR AND",
    "RETURN TO THE LOCKED DOOR AFTER SEARCHING THE EASTERN ROOM",
    "SEARCH BEHIND THE STATUE THEN RETURN TO THE LOCKED DOOR",
    "THIS IS A DELIBERATELY OVERLONG HINT THAT SHOULD BE TRIMMED DOWN TO THREE LINES AT MOST WHEN WRAPPED",
    "...!!!",
    "",
  ];

  for (const sample of samples) {
    const cleaned = cleanHintReply(sample);
    const wrapped = wrapHintLines(cleaned);
    console.log(
      JSON.stringify({
        input: sample,
        cleaned,
        chars: cleaned.length,
        lines: wrapped.length,
        wrapped,
      })
    );
  }
}

if (process.argv.includes("--test-hint-cleanup")) {
  runHintCleanupSelfTest();
} else {
  server.listen(PORT, HOST, () => {
    console.log(`[GB bridge server] listening on http://${HOST}:${PORT}`);
    if (DEV_HINT_LAYOUT_TEST) {
      console.log(
        "[GB bridge server] DEV_HINT_LAYOUT_TEST=1 — fixed layout replies enabled"
      );
    }
  });
}
