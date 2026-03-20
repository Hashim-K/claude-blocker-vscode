import { parentPort } from "node:worker_threads";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { SessionState } from "./state.js";
import type { HookPayload, ClientMessage, MainToWorkerMessage } from "./types.js";
import { DEFAULT_PORT } from "./types.js";

if (!parentPort) throw new Error("Must run as worker thread");

const state = new SessionState();
const port = DEFAULT_PORT;

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || "/", `http://localhost:${port}`);

  if (req.method === "GET" && url.pathname === "/status") {
    sendJson(res, state.getStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/history") {
    sendJson(res, { history: [] });
    return;
  }

  if (req.method === "POST" && url.pathname === "/hook") {
    try {
      const body = await parseBody(req);
      const payload = JSON.parse(body) as HookPayload;
      if (!payload.session_id || !payload.hook_event_name) {
        sendJson(res, { error: "Invalid payload" }, 400);
        return;
      }
      state.handleHook(payload);
      sendJson(res, { ok: true });
    } catch {
      sendJson(res, { error: "Invalid JSON" }, 400);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/stats") {
    sendJson(res, { daily: {}, projects: [], totals: { tokens: {}, cost: 0, sessions: 0 } });
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  const { blocked, sessions } = state.getStatus();
  const working = sessions.filter(s => s.status === "working").length;
  const waitingForInput = sessions.filter(s => s.status === "waiting_for_input").length;
  ws.send(JSON.stringify({ type: "state", blocked, sessions, working, waitingForInput }));

  const unsubscribe = state.subscribe((message) => {
    if (message.type === "state-change" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "state", blocked: message.blocked, sessions: message.sessions,
        working: message.working, waitingForInput: message.waitingForInput,
      }));
    }
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => unsubscribe());
  ws.on("error", () => unsubscribe());
});

state.subscribe((message) => {
  parentPort!.postMessage(message);
});

parentPort.on("message", (message: MainToWorkerMessage) => {
  switch (message.type) {
    case "inject-session": state.injectSession(message.sessionId); break;
    case "remove-session": state.removeSession(message.sessionId); break;
    case "refresh-session": state.refreshSession(message.sessionId); break;
    case "get-status": parentPort!.postMessage({ type: "status", ...state.getStatus() }); break;
    case "shutdown": state.destroy(); wss.close(); server.close(); break;
  }
});

server.listen(port, () => {
  parentPort!.postMessage({ type: "started", port });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  parentPort!.postMessage({ type: "error", message: err.message, code: err.code });
});
