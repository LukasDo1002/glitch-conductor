// ==========================================
// 1. VISUAL CURSOR & CAMERA SETUP 
// ==========================================
let currentRadius = 80; 
let currentFeather = 0.5;
let hiddenCanvas = document.createElement('canvas');
let hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
let imgData = null;
let scaleX = 1, scaleY = 1;

// MOVED TO THE TOP TO PREVENT REFERENCE ERRORS
function updateCursorVisuals() {
  const cursor = document.getElementById('glitch-cursor');
  const core = document.getElementById('glitch-cursor-core');
  
  if (cursor && core) {
    cursor.style.width = (currentRadius * 2) + 'px';
    cursor.style.height = (currentRadius * 2) + 'px';
    let coreSize = (currentRadius * 2) * (1 - currentFeather);
    core.style.width = coreSize + 'px';
    core.style.height = coreSize + 'px';
  }
}

function initCursor() {
  if (document.getElementById('glitch-cursor')) return;

  const cursor = document.createElement('div');
  cursor.id = 'glitch-cursor';
  const core = document.createElement('div');
  core.id = 'glitch-cursor-core';

  cursor.appendChild(core);
  document.body.appendChild(cursor);
  
  updateCursorVisuals(); // This is now 100% safe to call

  setTimeout(takeSnapshot, 500);

  let scrollTimeout;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(takeSnapshot, 150); 
  });

  document.addEventListener('mousemove', (e) => {
    cursor.style.left = e.clientX + 'px';
    cursor.style.top = e.clientY + 'px';
    if (imgData) extractColors(e.clientX, e.clientY);
  });
}

function takeSnapshot() {
  chrome.runtime.sendMessage({ type: "TAKE_SNAPSHOT" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.dataUrl) {
      let img = new Image();
      img.onload = () => {
        hiddenCanvas.width = img.width;
        hiddenCanvas.height = img.height;
        hiddenCtx.drawImage(img, 0, 0);
        scaleX = img.width / window.innerWidth;
        scaleY = img.height / window.innerHeight;
        imgData = hiddenCtx.getImageData(0, 0, hiddenCanvas.width, hiddenCanvas.height).data;
      };
      img.src = response.dataUrl;
    }
  });
}

// ==========================================
// 2. DATA EXTRACTION
// ==========================================
let currentRed = 0, currentGreen = 0, currentBlue = 0, currentMass = 0;

function extractColors(mouseX, mouseY) {
  let mappedX = Math.floor(mouseX * scaleX);
  let mappedY = Math.floor(mouseY * scaleY);
  let mappedRadius = Math.floor(currentRadius * scaleX);

  let sumR = 0, sumG = 0, sumB = 0;
  let weightTotal = 0; 

  let xMin = Math.max(0, mappedX - mappedRadius);
  let xMax = Math.min(hiddenCanvas.width, mappedX + mappedRadius);
  let yMin = Math.max(0, mappedY - mappedRadius);
  let yMax = Math.min(hiddenCanvas.height, mappedY + mappedRadius);

  for (let x = xMin; x < xMax; x++) {
    for (let y = yMin; y < yMax; y++) {
      let distance = Math.sqrt(Math.pow(mappedX - x, 2) + Math.pow(mappedY - y, 2));
      if (distance <= mappedRadius) {
        let weight = 1.0 - ((distance / mappedRadius) * currentFeather);
        let index = (y * hiddenCanvas.width + x) * 4;
        sumR += imgData[index] * weight;
        sumG += imgData[index + 1] * weight;
        sumB += imgData[index + 2] * weight;
        weightTotal += weight;
      }
    }
  }

  if (weightTotal > 0) {
    let maxPossibleSum = weightTotal * 255;
    currentRed = sumR / maxPossibleSum;
    currentGreen = sumG / maxPossibleSum;
    currentBlue = sumB / maxPossibleSum;
    currentMass = weightTotal;
  } else {
    currentRed = 0; currentGreen = 0; currentBlue = 0; currentMass = 0;
  }
}

// ==========================================
// 3. THE NETWORK & AUDIO ARCHITECTURE
// ==========================================
let audioCtx, masterGain, atmosDelay, atmosFeedback;
let isAudioReady = false;
let instrumentProfile = "atmosphere"; 
let roomToken = "default";

chrome.storage.local.get(['roomToken', 'instrumentProfile'], (data) => {
  if (data.instrumentProfile) instrumentProfile = data.instrumentProfile;
  if (data.roomToken) roomToken = data.roomToken;
  console.log(`Loaded: ${instrumentProfile} | Room: ${roomToken}`);
});

document.addEventListener('click', () => {
  if (!isAudioReady) {
    setupAudio();
    connectNetwork();
    isAudioReady = true;
    console.log("Audio Engine & Network Online.");
  }
});

function setupAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.5; 
  masterGain.connect(audioCtx.destination);

  atmosDelay = audioCtx.createDelay();
  atmosDelay.delayTime.value = 0.33; 

  atmosFeedback = audioCtx.createGain();
  atmosFeedback.gain.value = 0.6; 

  atmosDelay.connect(atmosFeedback);
  atmosFeedback.connect(atmosDelay);
  atmosDelay.connect(masterGain);
}

function connectNetwork() {
  // Listen to the Background Script instead of directly to the WebSocket
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "NETWORK_BEAT") {
      const msg = JSON.parse(message.payload);
      if (msg.type === 'BEAT' && msg.room === roomToken) {
        triggerInstrument();
      }
    }
  });
}

// ==========================================
// 4. THE INSTRUMENT ROUTER
// ==========================================
function triggerInstrument() {
  if (currentMass === 0) return; 

  let time = audioCtx.currentTime;
  let osc = audioCtx.createOscillator();
  let env = audioCtx.createGain(); 
  osc.connect(env);

  switch (instrumentProfile) {
    case 'grid': 
      env.connect(masterGain);
      osc.type = 'sine';
      let startPitch = 100 + (currentRed * 150);
      osc.frequency.setValueAtTime(startPitch, time);
      osc.frequency.exponentialRampToValueAtTime(40, time + 0.1); 
      env.gain.setValueAtTime(1, time);
      env.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
      osc.start(time);
      osc.stop(time + 0.2);
      break;

    case 'weaver': 
      env.connect(masterGain);
      osc.type = 'triangle'; 
      const scale = [130.81, 155.56, 174.61, 196.00, 233.08, 261.63];
      let noteIndex = Math.floor(currentGreen * (scale.length - 0.01));
      osc.frequency.setValueAtTime(scale[noteIndex], time);
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.6, time + 0.02); 
      env.gain.exponentialRampToValueAtTime(0.001, time + 0.4); 
      osc.start(time);
      osc.stop(time + 0.5);
      break;

    case 'atmosphere': 
      env.connect(atmosDelay); 
      env.connect(masterGain); 
      osc.type = 'sawtooth';
      let padPitch = 80 + (currentBlue * 220);
      osc.frequency.setValueAtTime(padPitch, time);
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.1, time + 0.2); 
      env.gain.linearRampToValueAtTime(0, time + 0.4);   
      osc.start(time);
      osc.stop(time + 0.5);
      break;
  }
}

// ==========================================
// 5. KEYBOARD CONTROLS
// ==========================================
document.addEventListener('keydown', (e) => {
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  if (activeTag === 'input' || activeTag === 'textarea' || document.activeElement.isContentEditable) {
    return; 
  }

  let changed = false;

  if (e.key === ']') {
    currentRadius = Math.min(300, currentRadius + 5);
    changed = true;
  } else if (e.key === '[') {
    currentRadius = Math.max(10, currentRadius - 5);
    changed = true;
  } else if (e.key === '=' || e.key === '+') {
    currentFeather = Math.min(1.0, currentFeather + 0.05);
    changed = true;
  } else if (e.key === '-') {
    currentFeather = Math.max(0.0, currentFeather - 0.05);
    changed = true;
  }

  if (changed) updateCursorVisuals();
});

if (document.body) initCursor();
else document.addEventListener('DOMContentLoaded', initCursor);