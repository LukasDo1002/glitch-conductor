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

  if (message.type === "RECONNECT") {
    reconnect();
  }
});

// ==========================================
// 2. THE NETWORK RELAY
// ==========================================
let socket = null;
let reconnectTimer = null;
let currentUrl = null;

function connectToConductor(url) {
  if (!url) return;
  currentUrl = url;

  // Clean up any existing socket
  if (socket) {
    socket.onclose = null; // prevent the old socket triggering a reconnect loop
    socket.close();
  }

  socket = new WebSocket(`ws://${url}`);

  socket.onopen = () => {
    console.log(`Background: Connected to ${url}`);
  };

  socket.onmessage = (event) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "NETWORK_BEAT",
          payload: event.data
        }).catch(() => {});
      }
    });
  };

  socket.onclose = () => {
    console.log("Background: Connection lost. Retrying in 3s...");
    reconnectTimer = setTimeout(() => connectToConductor(currentUrl), 3000);
  };
}

function reconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  chrome.storage.local.get(['serverUrl'], (data) => {
    if (data.serverUrl) connectToConductor(data.serverUrl);
  });
}

// Connect on startup using whatever URL is saved
reconnect();