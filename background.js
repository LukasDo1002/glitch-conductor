// ==========================================
// 1. THE CAMERA
// ==========================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TAKE_SNAPSHOT") {
    chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 50 }, (dataUrl) => {
      sendResponse({ dataUrl: dataUrl });
    });
    return true;
  }

  // Popup asks: am I connected? what's my ID? who owns what?
  if (message.type === "GET_CONNECTION_STATE") {
    sendResponse({
      connected:       socket && socket.readyState === WebSocket.OPEN,
      myId:            myId,
      roleAssignments: roleAssignments,
      tempoOwner:      tempoOwner
    });
    return true;
  }

  // Popup updates: room token + instrument selection changed
  if (message.type === "UPDATE_SETTINGS") {
    handleSettingsUpdate(message.settings);
    return false;
  }

  // Content script sends: my cursor's current color reading
  if (message.type === "SEND_CURSOR_STATE") {
    sendCursorState(message.payload);
    return false;
  }

  // Content script sends: I'm the tempo holder, my BPM is now X
  if (message.type === "SEND_TEMPO") {
    sendTempo(message.bpm);
    return false;
  }
});

// ==========================================
// 2. NETWORK STATE
// ==========================================
const CONDUCTOR_URL = "wss://glitch-conductor-production.up.railway.app";

let socket    = null;
let myId      = null;
let roleAssignments = {};
let tempoOwner      = null;
let myInstruments   = [];
let myRoomToken     = "default";

// Throttle outbound messages so we don't get rate-limited by Railway
let lastCursorSend = 0;
let lastTempoSend  = 0;
const CURSOR_THROTTLE_MS = 200; // 5Hz
const TEMPO_THROTTLE_MS  = 500; // 2Hz

// ==========================================
// 3. CONNECTION
// ==========================================
function connectToConductor() {
  socket = new WebSocket(CONDUCTOR_URL);

  socket.onopen = () => {
    console.log("Background: Connected to Railway conductor");
    // Restore our settings on reconnect
    chrome.storage.local.get(['roomToken', 'instruments'], (data) => {
      myRoomToken   = data.roomToken    || 'default';
      myInstruments = data.instruments  || [];
      // Tell the server who we are and what we want to play
      send({ type: 'JOIN_ROOM',       roomToken: myRoomToken });
      send({ type: 'SET_INSTRUMENTS', instruments: myInstruments });
    });
  };

  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleServerMessage(msg);
  };

  socket.onclose = (event) => {
    const delay = event.code === 1008 ? 10000 : 3000;
    console.log(`Background: Connection lost. Retrying in ${delay/1000}s...`);
    myId = null;
    setTimeout(connectToConductor, delay);
  };

  socket.onerror = () => {
    if (socket) socket.close();
  };
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

// ==========================================
// 4. HANDLE INCOMING SERVER MESSAGES
// ==========================================
function handleServerMessage(msg) {
  switch (msg.type) {

    case 'WELCOME':
      // Server has assigned us an ID
      myId = msg.id;
      console.log(`Background: assigned ID ${myId}`);
      break;

    case 'ROLE_STATE':
      // Server tells us who owns which instruments
      roleAssignments = msg.assignments;
      tempoOwner      = msg.tempoOwner;
      // Forward to content script so it can update its local engine
      forwardToActiveTab({
        type: 'NETWORK_ROLE_STATE',
        assignments: msg.assignments,
        tempoOwner:  msg.tempoOwner
      });
      break;

    case 'INSTRUMENTS_CONFIRMED':
      // Server confirms which instruments we actually got
      // (some may have been rejected because exclusive ones were taken)
      myInstruments = msg.instruments || [];
      // Forward to content script
      forwardToActiveTab({
        type: 'NETWORK_INSTRUMENTS_CONFIRMED',
        instruments: myInstruments
      });
      break;

    case 'CURSOR_STATES':
      // All performers' cursor states — relay to content script
      forwardToActiveTab({
        type: 'NETWORK_CURSOR_STATES',
        states: msg.states
      });
      break;

    case 'BAR_TICK':
      // The master sync pulse — relay immediately to content script
      forwardToActiveTab({
        type: 'NETWORK_BAR_TICK',
        bar:        msg.bar,
        bpm:        msg.bpm,
        serverTime: msg.serverTime,
        receivedAt: Date.now()
      });
      break;
  }
}

// ==========================================
// 5. FORWARD MESSAGES TO ACTIVE TAB
// ==========================================
function forwardToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
    }
  });
}

// ==========================================
// 6. POPUP → SERVER: settings changed
// ==========================================
function handleSettingsUpdate(settings) {
  myRoomToken   = settings.roomToken    || 'default';
  myInstruments = settings.instruments  || [];

  send({ type: 'JOIN_ROOM',       roomToken: myRoomToken });
  send({ type: 'SET_INSTRUMENTS', instruments: myInstruments });
}

// ==========================================
// 7. CONTENT SCRIPT → SERVER: cursor state
// ==========================================
function sendCursorState(payload) {
  const now = Date.now();
  if (now - lastCursorSend < CURSOR_THROTTLE_MS) return;
  lastCursorSend = now;

  send({
    type:     'CURSOR_STATE',
    hue:      payload.hue,
    sat:      payload.sat,
    light:    payload.light,
    variance: payload.variance,
    x:        payload.x
  });
}

// ==========================================
// 8. CONTENT SCRIPT → SERVER: BPM update
// (only sent if I hold the tempo role)
// ==========================================
function sendTempo(bpm) {
  const now = Date.now();
  if (now - lastTempoSend < TEMPO_THROTTLE_MS) return;
  lastTempoSend = now;

  send({ type: 'TEMPO_UPDATE', bpm });
}

// ==========================================
// 9. KICK OFF
// ==========================================
connectToConductor();