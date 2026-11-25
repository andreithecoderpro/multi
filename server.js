import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT) || 3000;
const players = new Map();
const blocks = new Map();
let worldTime = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: players.size, blocks: blocks.size }));
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const full = path.resolve(root, "." + pathname);
  if (!full.startsWith(root + path.sep) && full !== path.join(root, "index.html")) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(data, except = null) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === 1) client.send(payload);
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const id = Math.random().toString(36).slice(2, 8);
  const player = {
    id,
    name: `Pioneer-${id}`,
    x: 0.5,
    y: 20,
    z: 0.5,
    yaw: 0,
    color: `hsl(${Math.floor(Math.random() * 360)} 55% 48%)`
  };

  players.set(id, player);

  send(ws, {
    type: "welcome",
    you: id,
    players: [...players.values()].filter(p => p.id !== id),
    blocks: [...blocks.values()],
    time: worldTime
  });

  broadcast({ type: "join", player }, ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "state") {
      const values = [msg.x, msg.y, msg.z, msg.yaw].map(Number);
      if (!values.every(Number.isFinite)) return;

      const [x, y, z, yaw] = values;
      if (Math.abs(x) > 100000 || Math.abs(z) > 100000 || y < -100 || y > 1000) return;

      Object.assign(player, { x, y, z, yaw });
      broadcast({ type: "state", player }, ws);

    } else if (msg.type === "block") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const z = Number(msg.z);
      const b = Number(msg.b);

      if (![x, y, z, b].every(Number.isInteger)) return;
      if (Math.abs(x) > 100000 || Math.abs(z) > 100000 || y < 0 || y >= 40 || b < 0 || b > 30) return;

      const key = `${x},${y},${z}`;
      const edit = { x, y, z, b };

      blocks.set(key, edit);
      broadcast({ type: "block", ...edit }, ws);

    } else if (msg.type === "clock") {
      const time = Number(msg.time);
      if (!Number.isFinite(time) || time < 0 || time > 1000000) return;

      const first = [...players.keys()][0];
      if (first === id) {
        worldTime = time;
        broadcast({ type: "clock", time }, ws);
      }
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ type: "leave", id });
  });
});

// Ping all connected clients every 30 seconds to keep the connection alive
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Paper Pioneer multiplayer server listening on ${PORT}`);
});
