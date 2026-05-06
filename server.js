const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
console.log("Glitch Orchestra server running...");

// ============================================================
// STATE
// ============================================================
// Each connected client tracked by their WebSocket
// { instruments: Set<string>, cursor: { hue, sat, light, variance, x }, roomToken }
const clients = new Map();

// Instrument constraint: only one person can be "tempo" (sub + BPM driver)
// All other instruments can be played by multiple people simultaneously
const EXCLUSIVE_INSTRUMENTS = new Set(['tempo']);
const ALL_INSTRUMENTS       = ['tempo', 'tonal', 'air', 'noise'];

// The single source of truth for tempo
let currentBpm = 120;
let currentBar = 0;

// ============================================================
// HELPERS
// ============================================================
function getRoleAssignments() {
  // For each instrument, count who has it
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
  const msg = JSON.stringify({
    type: 'ROLE_STATE',
    assignments,
    tempoTaken,
    tempoOwner: assignments.tempo[0] || null
  });
  broadcast(msg);
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
  broadcast(JSON.stringify({
    type: 'CURSOR_STATES',
    states
  }));
}

// ============================================================
// CONNECTION HANDLER
// ============================================================
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

  // Send the new client their assigned ID and the current state
  ws.send(JSON.stringify({
    type: 'WELCOME',
    id,
    bpm: currentBpm,
    bar: currentBar
  }));
  broadcastRoleState();

  // ────────────────────────────────────────────────────────
  // MESSAGE HANDLER
  // ────────────────────────────────────────────────────────
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const client = clients.get(ws);
    if (!client) return;

    switch (msg.type) {

      // Performer requests to play certain instruments
      case 'SET_INSTRUMENTS': {
        const requested = new Set(msg.instruments || []);
        const accepted  = new Set();

        for (const inst of requested) {
          if (!ALL_INSTRUMENTS.includes(inst)) continue;

          // Check exclusive instruments
          if (EXCLUSIVE_INSTRUMENTS.has(inst)) {
            // Already taken by someone else?
            const taken = Array.from(clients.values())
              .some(c => c !== client && c.instruments?.has(inst));
            if (taken) continue; // skip — can't take this one
          }
          accepted.add(inst);
        }

        client.instruments = accepted;

        // Confirm to the client what they actually got
        ws.send(JSON.stringify({
          type: 'INSTRUMENTS_CONFIRMED',
          instruments: Array.from(accepted)
        }));
        broadcastRoleState();
        break;
      }

      // Performer is sending their cursor's current color reading
      case 'CURSOR_STATE': {
        client.cursor = {
          hue:      msg.hue      ?? 0,
          sat:      msg.sat      ?? 0,
          light:    msg.light    ?? 0,
          variance: msg.variance ?? 0,
          x:        msg.x        ?? 0.5
        };
        // We don't broadcast every cursor update — too noisy.
        // The throttled broadcast loop below handles it.
        break;
      }

      // The tempo holder is reporting their current BPM
      // (since their cursor 1 hue determines BPM)
      case 'TEMPO_UPDATE': {
        if (client.instruments?.has('tempo')) {
          currentBpm = Math.max(60, Math.min(220, msg.bpm || 120));
        }
        break;
      }

      // Performer sets their room token
      case 'JOIN_ROOM': {
        client.roomToken = msg.roomToken || 'default';
        break;
      }
    }
  });

  // ────────────────────────────────────────────────────────
  // DISCONNECT
  // ────────────────────────────────────────────────────────
  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      console.log(`${client.id} LEFT. Remaining: ${wss.clients.size - 1}`);
      clients.delete(ws);
      broadcastRoleState();
    }
  });
});

// ============================================================
// PERIODIC BROADCASTS
// ============================================================

// Cursor states — relayed to all clients ~5x/second
// Throttled so Railway doesn't rate-limit
setInterval(() => {
  if (clients.size === 0) return;
  broadcastCursorStates();
}, 200);

// BAR_TICK — the master sync pulse
// Sent every 2 seconds with the current bar number + BPM
// Each client uses this to align its local clock
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