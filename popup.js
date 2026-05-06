// ============================================================
// STATE
// ============================================================
let myId           = null;
let myInstruments  = new Set();
let roleAssignments = {};
let tempoOwner     = null;
let connected      = false;

const ALL_INSTRUMENTS = ['tempo', 'tonal', 'air', 'noise'];
const EXCLUSIVE       = new Set(['tempo']);

// ============================================================
// DOM
// ============================================================
const roomInput   = document.getElementById('roomCode');
const saveBtn     = document.getElementById('saveBtn');
const statusMsg   = document.getElementById('status');
const connStatus  = document.getElementById('connection');
const myIdEl      = document.getElementById('myId');

// ============================================================
// LOAD SAVED SETTINGS
// ============================================================
chrome.storage.local.get(
  ['roomToken', 'instruments'],
  (data) => {
    if (data.roomToken) {
      roomInput.value = data.roomToken;
    }
    if (data.instruments && Array.isArray(data.instruments)) {
      myInstruments = new Set(data.instruments);
      updateInstrumentUI();
    }
  }
);

// ============================================================
// REQUEST CONNECTION STATE FROM BACKGROUND
// ============================================================
// The background script holds the WebSocket. We ask it for the
// current connection state and any role assignments it knows about.
function requestConnectionState() {
  chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    if (response.connected) {
      connected = true;
      myId      = response.myId;
      connStatus.textContent = 'Connected';
      connStatus.className   = 'connected';
      if (myId) myIdEl.textContent = `You are ${myId.toUpperCase()}`;
    } else {
      connected = false;
      connStatus.textContent = 'Disconnected — server unreachable';
      connStatus.className   = 'disconnected';
    }
    if (response.roleAssignments) {
      roleAssignments = response.roleAssignments;
      tempoOwner      = response.tempoOwner;
      updateInstrumentUI();
    }
  });
}

// Poll connection state every second so the UI stays fresh while popup is open
requestConnectionState();
const pollInterval = setInterval(requestConnectionState, 1000);

// Cleanup on popup close
window.addEventListener('unload', () => clearInterval(pollInterval));

// ============================================================
// INSTRUMENT CLICK HANDLERS
// ============================================================
ALL_INSTRUMENTS.forEach(inst => {
  const el = document.getElementById('inst-' + inst);
  el.addEventListener('click', () => {
    if (el.classList.contains('locked')) return;
    if (myInstruments.has(inst)) {
      myInstruments.delete(inst);
    } else {
      myInstruments.add(inst);
    }
    updateInstrumentUI();
  });
});

// ============================================================
// UI UPDATE
// ============================================================
function updateInstrumentUI() {
  ALL_INSTRUMENTS.forEach(inst => {
    const el         = document.getElementById('inst-' + inst);
    const isSelected = myInstruments.has(inst);
    const owners     = roleAssignments[inst] || [];

    // Reset state classes
    el.classList.remove('selected', 'locked');

    // Selected state
    if (isSelected) el.classList.add('selected');

    // Lock state for exclusive instruments
    if (EXCLUSIVE.has(inst)) {
      // Locked if someone else has it (and it's not us)
      if (tempoOwner && tempoOwner !== myId) {
        el.classList.add('locked');
        const lockEl = document.getElementById('lock-' + inst);
        if (lockEl) lockEl.textContent = `${tempoOwner.toUpperCase()} has this`;
        // Ensure we don't claim it
        myInstruments.delete(inst);
      } else {
        const lockEl = document.getElementById('lock-' + inst);
        if (lockEl) lockEl.textContent = '';
      }
    } else {
      // Shared — show how many others play it
      const others = owners.filter(id => id !== myId).length;
      const shareEl = document.getElementById('share-' + inst);
      if (shareEl) {
        shareEl.textContent = others > 0 ? `+${others} other${others>1?'s':''}` : '';
      }
    }
  });
}

// ============================================================
// SAVE
// ============================================================
saveBtn.addEventListener('click', () => {
  const settings = {
    roomToken:   roomInput.value.trim() || 'default',
    instruments: Array.from(myInstruments)
  };

  chrome.storage.local.set(settings, () => {
    // Tell the background script to push these to the server
    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings
    });

    statusMsg.style.display = 'block';
    setTimeout(() => { statusMsg.style.display = 'none'; }, 2000);
  });
});