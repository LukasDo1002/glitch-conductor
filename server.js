const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
console.log("Glitch Orchestra server running...");

const clients = new Map();

const EXCLUSIVE_INSTRUMENTS = new Set(['tempo']);
const ALL_INSTRUMENTS = ['tempo', 'tonal', 'air', 'noise', 'rustle', 'rumble'];

let currentBpm = 120;
let currentBar = 0;

function getRoleAssignments() {
  const assignments = {};
  ALL_INSTRUMENTS.forEach(i => assignments[i] = []);
  for (const [ws, client] of clients.entries()) {
    if (!client.instruments) continue;
    client.instruments.forEach(inst => {
      if (assignments[inst]) assignments[inst].push(client.id);
    });
  }
  return assignments;
}

function broadcastRoleState() {
  const assignments = getRoleAssignments();
  const tempoTaken  = assignments.tempo.length > 0;
  broadcast(JSON.stringify({
    type: 'ROLE_STATE',
    assignments,
    tempoTaken,
    tempoOwner: assignments.tempo[0] || null
  }));
}

function broadcast(msg, exceptWs = null) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== exceptWs) {
      client.send(msg);
    }
  });
}

function broadcastCursorStates() {
  const states = [];
  for (const [ws, client] of clients.entries()) {
    if (client.cursor) {
      states.push({
        id: client.id,
        instruments: Array.from(client.instruments || []),
        cursor: client.cursor
      });
    }
  }
  broadcast(JSON.stringify({ type: 'CURSOR_STATES', states }));
}

let nextClientId = 1;

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  const id = `p${nextClientId++}`;

  clients.set(ws, {
    id,
    instruments: new Set(),
    cursor: null,
    roomToken: null
  });

  console.log(`\n🎉 ${id} JOINED (${ip}) — total: ${wss.clients.size}\n`);

  ws.send(JSON.stringify({
    type: 'WELCOME',
    id,
    bpm: currentBpm,
    bar: currentBar
  }));
  broadcastRoleState();

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const client = clients.get(ws);
    if (!client) return;

    switch (msg.type) {

      case 'SET_INSTRUMENTS': {
        const requested = new Set(msg.instruments || []);
        const accepted  = new Set();

        for (const inst of requested) {
          if (!ALL_INSTRUMENTS.includes(inst)) continue;
          if (EXCLUSIVE_INSTRUMENTS.has(inst)) {
            const taken = Array.from(clients.values())
              .some(c => c !== client && c.instruments?.has(inst));
            if (taken) continue;
          }
          accepted.add(inst);
        }

        client.instruments = accepted;
        ws.send(JSON.stringify({
          type: 'INSTRUMENTS_CONFIRMED',
          instruments: Array.from(accepted)
        }));
        broadcastRoleState();
        break;
      }

      case 'CURSOR_STATE': {
        client.cursor = {
          hue:      msg.hue      ?? 0,
          sat:      msg.sat      ?? 0,
          light:    msg.light    ?? 0,
          variance: msg.variance ?? 0,
          x:        msg.x        ?? 0.5
        };
        break;
      }

      case 'TEMPO_UPDATE': {
        if (client.instruments?.has('tempo')) {
          currentBpm = Math.max(60, Math.min(220, msg.bpm || 120));
        }
        break;
      }

      case 'JOIN_ROOM': {
        client.roomToken = msg.roomToken || 'default';
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      console.log(`${client.id} LEFT. Remaining: ${wss.clients.size - 1}`);
      clients.delete(ws);
      broadcastRoleState();
    }
  });
});

setInterval(() => {
  if (clients.size === 0) return;
  broadcastCursorStates();
}, 200);

setInterval(() => {
  if (clients.size === 0) return;
  currentBar++;
  broadcast(JSON.stringify({
    type: 'BAR_TICK',
    bar: currentBar,
    bpm: currentBpm,
    serverTime: Date.now()
  }));
}, 2000);
