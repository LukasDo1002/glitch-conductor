document.addEventListener('DOMContentLoaded', () => {
  const serverInput = document.getElementById('serverUrl');
  const roomInput   = document.getElementById('roomCode');
  const instSelect  = document.getElementById('instrument');
  const saveBtn     = document.getElementById('saveBtn');
  const statusMsg   = document.getElementById('status');

  chrome.storage.local.get(['serverUrl', 'roomToken', 'instrumentProfile'], (data) => {
    if (data.serverUrl)        serverInput.value = data.serverUrl;
    if (data.roomToken)        roomInput.value   = data.roomToken;
    if (data.instrumentProfile) instSelect.value = data.instrumentProfile;
  });

  saveBtn.addEventListener('click', () => {
    const settings = {
      serverUrl:         serverInput.value.trim(),
      roomToken:         roomInput.value.trim(),
      instrumentProfile: instSelect.value
    };
    chrome.storage.local.set(settings, () => {
      // Tell background.js to reconnect with the new URL
      chrome.runtime.sendMessage({ type: "RECONNECT" });
      statusMsg.style.display = 'block';
      setTimeout(() => { statusMsg.style.display = 'none'; }, 2000);
    });
  });
});