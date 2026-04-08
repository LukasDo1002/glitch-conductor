const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log("Metronome Server running on port 8080...");

// THE DOORBELL: Logs a message whenever a new laptop connects
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`\n🎉 NEW MUSICIAN JOINED! (IP: ${ip})`);
  console.log(`Total players connected: ${wss.clients.size}\n`);
});

setInterval(() => {
  const beatMessage = JSON.stringify({
    type: 'BEAT',
    room: 'JODI24' 
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(beatMessage);
    }
  });
  
  process.stdout.write("Bip... "); 
}, 500);