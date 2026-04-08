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

  // Forward HSL state from content script to server
  if (message.type === "SEND_TO_SERVER") {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(message.payload);
    }
  }
});

// ==========================================
// 2. THE NETWORK RELAY
// ==========================================
const CONDUCTOR_URL = "wss://glitch-conductor-production.up.railway.app";
let socket = null;

function connectToConductor() {
  socket = new WebSocket(CONDUCTOR_URL);

  socket.onopen = () => {
    console.log("Background: Connected to Railway conductor!");
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
    setTimeout(connectToConductor, 3000);
  };
}

connectToConductor();