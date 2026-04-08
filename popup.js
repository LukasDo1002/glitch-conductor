const descriptions = {
  synesthete: "Hue → pitch. Saturation → FM timbre complexity. Lightness → register. Vivid pages = metallic, grey pages = pure tones.",
  navigator: "Hue maps to chromatic scale. Collective tension between performers shapes distortion and timbre. Play together or against each other.",
  organism: "Tracks how fast your cursor moves through color. Slow sweeps = drones. Fast movement = cascading arpeggios.",
  combined: "All three engines layered at lower volumes. Maximum complexity."
};

document.addEventListener('DOMContentLoaded', () => {
  const roomInput   = document.getElementById('roomCode');
  const instSelect  = document.getElementById('instrument');
  const conceptSel  = document.getElementById('concept');
  const conceptDesc = document.getElementById('conceptDesc');
  const saveBtn     = document.getElementById('saveBtn');
  const statusMsg   = document.getElementById('status');

  function updateDesc() {
    conceptDesc.textContent = descriptions[conceptSel.value];
  }

  chrome.storage.local.get(['roomToken', 'instrumentProfile', 'soundConcept'], (data) => {
    if (data.roomToken)        roomInput.value   = data.roomToken;
    if (data.instrumentProfile) instSelect.value = data.instrumentProfile;
    if (data.soundConcept)     conceptSel.value  = data.soundConcept;
    updateDesc();
  });

  conceptSel.addEventListener('change', updateDesc);

  saveBtn.addEventListener('click', () => {
    const settings = {
      roomToken:         roomInput.value.trim(),
      instrumentProfile: instSelect.value,
      soundConcept:      conceptSel.value
    };
    chrome.storage.local.set(settings, () => {
      statusMsg.style.display = 'block';
      setTimeout(() => { statusMsg.style.display = 'none'; }, 2000);
    });
  });
});