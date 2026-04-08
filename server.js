const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
console.log("Metronome Server running...");

const clientStates = new Map();

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`\n🎉 NEW MUSICIAN JOINED! (IP: ${ip})`);
  console.log(`Total players connected: ${wss.clients.size}\n`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'CLIENT_STATE') {
        clientStates.set(ws, msg);
        // Calculate collective tension from all hues
        const states = Array.from(clientStates.values());
        if (states.length > 1) {
          const hues = states.map(s => s.hue);
          let maxDiff = 0;
          for (let i = 0; i < hues.length; i++) {
            for (let j = i + 1; j < hues.length; j++) {
              let diff = Math.abs(hues[i] - hues[j]);
              if (diff > 180) diff = 360 - diff;
              maxDiff = Math.max(maxDiff, diff);
            }
          }
          const tension = maxDiff / 180; // 0 = consonant, 1 = dissonant
          // Broadcast collective state to all clients
          const collective = JSON.stringify({
            type: 'COLLECTIVE_STATE',
            tension,
            states: states.map(s => ({ hue: s.hue, sat: s.sat, light: s.light }))
          });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(collective);
            }
          });
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    clientStates.delete(ws);
  });
});

// Beat metronome — unchanged
setInterval(() => {
  const beatMessage = JSON.stringify({ type: 'BEAT', room: 'JODI24' });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(beatMessage);
    }
  });
  process.stdout.write("Bip... ");
}, 500);