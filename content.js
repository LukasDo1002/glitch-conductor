// ==========================================
// 1. VISUAL CURSOR & CAMERA SETUP
// ==========================================
let currentRadius = 80;
let currentFeather = 0.5;
let hiddenCanvas = document.createElement('canvas');
let hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
let imgData = null;
let scaleX = 1, scaleY = 1;

function updateCursorVisuals() {
  const cursor = document.getElementById('glitch-cursor');
  const core   = document.getElementById('glitch-cursor-core');
  if (cursor && core) {
    cursor.style.width  = (currentRadius * 2) + 'px';
    cursor.style.height = (currentRadius * 2) + 'px';
    let coreSize = (currentRadius * 2) * (1 - currentFeather);
    core.style.width  = coreSize + 'px';
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
  updateCursorVisuals();
  setTimeout(takeSnapshot, 500);

  let scrollTimeout;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(takeSnapshot, 150);
  });

  document.addEventListener('mousemove', (e) => {
    cursor.style.left = e.clientX + 'px';
    cursor.style.top  = e.clientY + 'px';
    if (imgData) extractColors(e.clientX, e.clientY);
  });
}

function takeSnapshot() {
  chrome.runtime.sendMessage({ type: "TAKE_SNAPSHOT" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.dataUrl) {
      let img = new Image();
      img.onload = () => {
        hiddenCanvas.width  = img.width;
        hiddenCanvas.height = img.height;
        hiddenCtx.drawImage(img, 0, 0);
        scaleX = img.width  / window.innerWidth;
        scaleY = img.height / window.innerHeight;
        imgData = hiddenCtx.getImageData(0, 0, hiddenCanvas.width, hiddenCanvas.height).data;
      };
      img.src = response.dataUrl;
    }
  });
}

// ==========================================
// 2. DATA EXTRACTION — RGB + HSL + VARIANCE
// ==========================================
let currentRed = 0, currentGreen = 0, currentBlue = 0;
let currentHue = 0, currentSat = 0, currentLight = 0;
let currentVariance = 0, currentMass = 0;

// Rolling buffer for Organism concept
const HUE_BUFFER_SIZE = 20;
let hueBuffer = [];
let lastHue = 0;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: h * 360, s, l };
}

function extractColors(mouseX, mouseY) {
  let mappedX      = Math.floor(mouseX * scaleX);
  let mappedY      = Math.floor(mouseY * scaleY);
  let mappedRadius = Math.floor(currentRadius * scaleX);

  let sumR = 0, sumG = 0, sumB = 0;
  let weightTotal = 0;
  let samples = [];

  let xMin = Math.max(0, mappedX - mappedRadius);
  let xMax = Math.min(hiddenCanvas.width,  mappedX + mappedRadius);
  let yMin = Math.max(0, mappedY - mappedRadius);
  let yMax = Math.min(hiddenCanvas.height, mappedY + mappedRadius);

  // Sample every 3rd pixel for performance
  for (let x = xMin; x < xMax; x += 3) {
    for (let y = yMin; y < yMax; y += 3) {
      let dist = Math.sqrt(Math.pow(mappedX - x, 2) + Math.pow(mappedY - y, 2));
      if (dist <= mappedRadius) {
        let weight = 1.0 - ((dist / mappedRadius) * currentFeather);
        let index  = (y * hiddenCanvas.width + x) * 4;
        sumR += imgData[index]     * weight;
        sumG += imgData[index + 1] * weight;
        sumB += imgData[index + 2] * weight;
        weightTotal += weight;
        samples.push(imgData[index] * 0.299 + imgData[index+1] * 0.587 + imgData[index+2] * 0.114);
      }
    }
  }

  if (weightTotal > 0) {
    let avgR = sumR / weightTotal;
    let avgG = sumG / weightTotal;
    let avgB = sumB / weightTotal;

    currentRed   = avgR / 255;
    currentGreen = avgG / 255;
    currentBlue  = avgB / 255;
    currentMass  = weightTotal;

    // Convert to HSL
    const hsl    = rgbToHsl(avgR, avgG, avgB);
    currentHue   = hsl.h;
    currentSat   = hsl.s;
    currentLight = hsl.l;

    // Calculate luminance variance (complexity of what's under cursor)
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / samples.length;
    currentVariance = Math.min(1, variance / 3000); // normalise 0–1

    // Update hue buffer for Organism concept
    hueBuffer.push(currentHue);
    if (hueBuffer.length > HUE_BUFFER_SIZE) hueBuffer.shift();

    // Broadcast state to server for Navigator concept
    broadcastState();
  } else {
    currentRed = currentGreen = currentBlue = 0;
    currentHue = currentSat = currentLight = currentVariance = currentMass = 0;
  }
}

// ==========================================
// 3. STATE BROADCAST (Navigator concept)
// ==========================================
let lastBroadcast = 0;
function broadcastState() {
  const now = Date.now();
  if (now - lastBroadcast < 100) return; // throttle to 10/sec
  lastBroadcast = now;
  chrome.runtime.sendMessage({
    type: "SEND_TO_SERVER",
    payload: JSON.stringify({
      type:  'CLIENT_STATE',
      hue:   currentHue,
      sat:   currentSat,
      light: currentLight,
      room:  roomToken
    })
  });
}

// ==========================================
// 4. NETWORK & AUDIO ARCHITECTURE
// ==========================================
let audioCtx, masterGain, reverbNode, reverbGain, dryGain;
let isAudioReady  = false;
let instrumentProfile = "atmosphere";
let soundConcept      = "synesthete";
let roomToken         = "default";
let collectiveTension = 0;
let collectiveStates  = [];

chrome.storage.local.get(['roomToken', 'instrumentProfile', 'soundConcept'], (data) => {
  if (data.instrumentProfile) instrumentProfile = data.instrumentProfile;
  if (data.soundConcept)      soundConcept      = data.soundConcept;
  if (data.roomToken)         roomToken         = data.roomToken;
});

document.addEventListener('click', () => {
  if (!isAudioReady) {
    setupAudio();
    isAudioReady = true;
    console.log("Audio Engine Online.");
  }
});

function setupAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.5;
  masterGain.connect(audioCtx.destination);

  // Shared reverb for all concepts
  reverbNode = audioCtx.createConvolver();
  reverbGain = audioCtx.createGain();
  dryGain    = audioCtx.createGain();
  reverbGain.gain.value = 0.3;
  dryGain.gain.value    = 0.7;

  // Generate a simple reverb impulse response
  buildReverb(2.5);

  reverbNode.connect(reverbGain);
  reverbGain.connect(masterGain);
  dryGain.connect(masterGain);
}

function buildReverb(duration) {
  const rate    = audioCtx.sampleRate;
  const length  = rate * duration;
  const impulse = audioCtx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const channel = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) {
      channel[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
    }
  }
  reverbNode.buffer = impulse;
}

function connectNetwork() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "NETWORK_BEAT") {
      const msg = JSON.parse(message.payload);
      if (msg.type === 'BEAT' && msg.room === roomToken) {
        onBeat();
      }
      if (msg.type === 'COLLECTIVE_STATE') {
        collectiveTension = msg.tension;
        collectiveStates  = msg.states;
      }
    }
  });
}

document.addEventListener('click', () => {
  if (!isAudioReady) connectNetwork();
  else connectNetwork();
}, { once: true });

// Actually connect network on first click
document.addEventListener('click', () => {
  connectNetwork();
}, { once: true });

// ==========================================
// 5. BEAT HANDLER & DYNAMIC TEMPO
// ==========================================
let beatInterval  = 500;
let localBeatTimer = null;

function onBeat() {
  if (currentMass === 0) return;

  // Voice 1 (grid) controls tempo via variance
  if (instrumentProfile === 'grid') {
    beatInterval = 200 + (1 - currentVariance) * 600; // 200ms (busy) to 800ms (calm)
  }

  triggerInstrument();
}

// ==========================================
// 6. HSL → MUSICAL HELPERS
// ==========================================

// Map hue (0-360) to a note in a pentatonic scale
function hueToFreq(hue, octaveOffset = 0) {
  // Pentatonic scale: C D E G A (intervals: 0,2,4,7,9)
  const pentatonic = [0, 2, 4, 7, 9];
  const baseFreq   = 130.81; // C3
  const noteIndex  = Math.floor((hue / 360) * pentatonic.length);
  const semitones  = pentatonic[noteIndex % pentatonic.length];
  const octave     = Math.floor(currentLight * 3) + octaveOffset; // lightness → octave
  return baseFreq * Math.pow(2, (semitones + octave * 12) / 12);
}

// Map hue to chromatic pitch (for Navigator)
function hueToChromaticFreq(hue) {
  const baseFreq = 130.81;
  const semitone = Math.floor((hue / 360) * 12);
  const octave   = Math.floor(currentLight * 2);
  return baseFreq * Math.pow(2, (semitone + octave * 12) / 12);
}

// Create an FM pair (carrier + modulator)
function createFMVoice(carrierFreq, modRatio, modIndex, waveform = 'sine') {
  const carrier   = audioCtx.createOscillator();
  const modulator = audioCtx.createOscillator();
  const modGain   = audioCtx.createGain();
  const env       = audioCtx.createGain();

  carrier.type   = waveform;
  modulator.type = 'sine';

  const modFreq = carrierFreq * modRatio;
  modulator.frequency.value = modFreq;
  modGain.gain.value        = modFreq * modIndex;

  carrier.frequency.value = carrierFreq;
  modulator.connect(modGain);
  modGain.connect(carrier.frequency);
  carrier.connect(env);

  return { carrier, modulator, env };
}

function routeToReverb(envNode) {
  // Reverb depth from saturation
  const wet = currentSat * 0.6;
  const dry = 1 - wet;
  const sendWet = audioCtx.createGain();
  const sendDry = audioCtx.createGain();
  sendWet.gain.value = wet;
  sendDry.gain.value = dry;
  envNode.connect(sendDry);
  envNode.connect(reverbNode);
  sendDry.connect(masterGain);
}

// ==========================================
// 7. THE INSTRUMENT ROUTER
// ==========================================
function triggerInstrument() {
  if (!audioCtx || currentMass === 0) return;

  switch (soundConcept) {
    case 'synesthete': triggerSynesthete(); break;
    case 'navigator':  triggerNavigator();  break;
    case 'organism':   triggerOrganism();   break;
    case 'combined':
      triggerSynesthete();
      triggerNavigator();
      triggerOrganism();
      break;
  }
}

// ──────────────────────────────────────────
// CONCEPT 2: SYNESTHETE
// HSL → FM synthesis
// Hue → pitch, Saturation → FM complexity, Lightness → register
// ──────────────────────────────────────────
function triggerSynesthete() {
  const time  = audioCtx.currentTime;
  const freq  = hueToFreq(currentHue);

  // Saturation drives FM modulation index: grey = pure, vivid = metallic
  const modIndex = currentSat * 8;

  switch (instrumentProfile) {
    case 'grid': {
      // Percussive FM bell — fast attack, quick decay
      const { carrier, modulator, env } = createFMVoice(freq, 2.0, modIndex, 'sine');
      routeToReverb(env);
      env.gain.setValueAtTime(0.8, time);
      env.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
      carrier.start(time);
      modulator.start(time);
      carrier.stop(time + 0.35);
      modulator.stop(time + 0.35);
      break;
    }
    case 'weaver': {
      // Evolving FM organ — slower attack, medium sustain
      const { carrier, modulator, env } = createFMVoice(freq * 0.5, 1.5, modIndex * 0.5, 'triangle');
      routeToReverb(env);
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.5, time + 0.08);
      env.gain.exponentialRampToValueAtTime(0.001, time + 0.6);
      carrier.start(time);
      modulator.start(time);
      carrier.stop(time + 0.65);
      modulator.stop(time + 0.65);
      break;
    }
    case 'atmosphere': {
      // Deep FM drone — very slow attack and decay
      const { carrier, modulator, env } = createFMVoice(freq * 0.25, 0.5, modIndex * 0.3, 'sawtooth');
      routeToReverb(env);
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.3, time + 0.4);
      env.gain.linearRampToValueAtTime(0, time + 1.2);
      carrier.start(time);
      modulator.start(time);
      carrier.stop(time + 1.3);
      modulator.stop(time + 1.3);
      break;
    }
  }
}

// ──────────────────────────────────────────
// CONCEPT 3: NAVIGATOR
// Collective tension between performers shapes timbre
// Low tension = clean harmonics, high tension = distortion
// ──────────────────────────────────────────
function triggerNavigator() {
  const time = audioCtx.currentTime;
  const freq = hueToChromaticFreq(currentHue);

  // Tension drives waveshaper distortion amount
  const waveshaper = audioCtx.createWaveShaper();
  waveshaper.curve = makeDistortionCurve(collectiveTension * 400);
  waveshaper.oversample = '4x';

  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();

  osc.frequency.value = freq;
  osc.type = 'sine';
  osc.connect(waveshaper);
  waveshaper.connect(env);

  // Saturation controls reverb depth — vivid = dry, grey = cavernous
  const reverbSend = audioCtx.createGain();
  const drySend    = audioCtx.createGain();
  reverbSend.gain.value = (1 - currentSat) * 0.8;
  drySend.gain.value    = currentSat;
  env.connect(drySend);
  env.connect(reverbNode);
  drySend.connect(masterGain);

  switch (instrumentProfile) {
    case 'grid': {
      env.gain.setValueAtTime(0.7, time);
      env.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
      osc.start(time);
      osc.stop(time + 0.25);
      break;
    }
    case 'weaver': {
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.4, time + 0.05);
      env.gain.exponentialRampToValueAtTime(0.001, time + 0.5);
      osc.start(time);
      osc.stop(time + 0.55);
      break;
    }
    case 'atmosphere': {
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.2, time + 0.3);
      env.gain.linearRampToValueAtTime(0, time + 1.5);
      osc.start(time);
      osc.stop(time + 1.6);
      break;
    }
  }
}

function makeDistortionCurve(amount) {
  const samples = 256;
  const curve   = new Float32Array(samples);
  const deg     = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x  = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// ──────────────────────────────────────────
// CONCEPT 4: ORGANISM
// Tracks cursor movement through color space
// Velocity of hue change → filter cutoff
// Direction of change → pitch direction
// Variance → tremolo
// ──────────────────────────────────────────
function triggerOrganism() {
  if (hueBuffer.length < 2) return;
  const time = audioCtx.currentTime;

  // Calculate hue velocity (how fast color is changing)
  let totalDelta = 0;
  let dirSum = 0;
  for (let i = 1; i < hueBuffer.length; i++) {
    let delta = hueBuffer[i] - hueBuffer[i - 1];
    // Handle wraparound on the color wheel
    if (delta > 180)  delta -= 360;
    if (delta < -180) delta += 360;
    totalDelta += Math.abs(delta);
    dirSum     += Math.sign(delta);
  }

  const hueVelocity = Math.min(1, totalDelta / (hueBuffer.length * 30)); // 0–1
  const hueDir      = Math.sign(dirSum); // -1, 0, or 1

  // Base frequency, direction affects pitch up/down
  const baseFreq = hueToFreq(currentHue);
  const freq     = baseFreq * (hueDir >= 0 ? 1 : 0.75); // down a fourth if moving backwards

  // Filter cutoff: slow movement = dark/muffled, fast = bright/open
  const cutoff = 200 + hueVelocity * 4000;

  const osc    = audioCtx.createOscillator();
  const filter = audioCtx.createBiquadFilter();
  const tremolo = audioCtx.createGain();
  const env    = audioCtx.createGain();

  filter.type            = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value         = 2 + currentSat * 8;

  // Tremolo rate from variance
  const tremoloOsc  = audioCtx.createOscillator();
  const tremoloGain = audioCtx.createGain();
  tremoloOsc.frequency.value = 2 + currentVariance * 12; // 2–14 Hz
  tremoloGain.gain.value     = currentVariance * 0.5;
  tremoloOsc.connect(tremoloGain);
  tremoloGain.connect(tremolo.gain);

  osc.frequency.value = freq;
  osc.type = 'triangle';
  osc.connect(filter);
  filter.connect(tremolo);
  tremolo.connect(env);

  // Route with reverb
  const reverbSend = audioCtx.createGain();
  const drySend    = audioCtx.createGain();
  reverbSend.gain.value = currentVariance * 0.5;
  drySend.gain.value    = 1 - reverbSend.gain.value;
  env.connect(drySend);
  env.connect(reverbNode);
  drySend.connect(masterGain);

  switch (instrumentProfile) {
    case 'grid': {
      // Fast attack when moving fast, longer when slow
      const decay = 0.1 + (1 - hueVelocity) * 0.4;
      env.gain.setValueAtTime(0.7, time);
      env.gain.exponentialRampToValueAtTime(0.001, time + decay);
      osc.start(time);
      tremoloOsc.start(time);
      osc.stop(time + decay + 0.05);
      tremoloOsc.stop(time + decay + 0.05);
      break;
    }
    case 'weaver': {
      const duration = 0.2 + (1 - hueVelocity) * 0.5;
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.4, time + 0.03);
      env.gain.exponentialRampToValueAtTime(0.001, time + duration);
      osc.start(time);
      tremoloOsc.start(time);
      osc.stop(time + duration + 0.05);
      tremoloOsc.stop(time + duration + 0.05);
      break;
    }
    case 'atmosphere': {
      const duration = 0.8 + (1 - hueVelocity) * 1.5;
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.25, time + 0.2);
      env.gain.linearRampToValueAtTime(0, time + duration);
      osc.start(time);
      tremoloOsc.start(time);
      osc.stop(time + duration + 0.05);
      tremoloOsc.stop(time + duration + 0.05);
      break;
    }
  }
}

// ==========================================
// 8. KEYBOARD CONTROLS
// ==========================================
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || document.activeElement.isContentEditable) return;

  let changed = false;
  if (e.key === ']') { currentRadius  = Math.min(300, currentRadius + 5);  changed = true; }
  if (e.key === '[') { currentRadius  = Math.max(10,  currentRadius - 5);  changed = true; }
  if (e.key === '=' || e.key === '+') { currentFeather = Math.min(1.0, currentFeather + 0.05); changed = true; }
  if (e.key === '-') { currentFeather = Math.max(0.0, currentFeather - 0.05); changed = true; }
  if (changed) updateCursorVisuals();
});

// ==========================================
// 9. INIT
// ==========================================
if (document.body) initCursor();
else document.addEventListener('DOMContentLoaded', initCursor);