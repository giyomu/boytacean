const http = require("http");

const PORT = 3000;
const HOST = "localhost";
const ALLOWED_ORIGIN = "http://localhost:8000";
const GB_MESSAGE_PATH = "/api/gb-message";

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
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
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url === GB_MESSAGE_PATH) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid request body" });
      return;
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    console.log("[GB bridge server] received:", body);

    const reply = "OK!";
    console.log("[GB bridge server] replying:", JSON.stringify(reply));

    sendJson(res, 200, {
      reply,
      receivedPrompt: body.prompt ?? "",
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[GB bridge server] listening on http://${HOST}:${PORT}`);
});
