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
        imgData = hiddenCtx.getImageData(
          0, 0, hiddenCanvas.width, hiddenCanvas.height
        ).data;
      };
      img.src = response.dataUrl;
    }
  });
}

// ==========================================
// 2. COLOR EXTRACTION — RGB + HSL + VARIANCE
// ==========================================
let currentHue      = 0;
let currentSat      = 0;
let currentLight    = 0;
let currentVariance = 0;
let currentMass     = 0;

const HUE_BUFFER_SIZE = 30;
let hueBuffer = [];

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
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
  const mappedX      = Math.floor(mouseX * scaleX);
  const mappedY      = Math.floor(mouseY * scaleY);
  const mappedRadius = Math.floor(currentRadius * scaleX);

  let sumR = 0, sumG = 0, sumB = 0, weightTotal = 0;
  const luminances = [];

  const xMin = Math.max(0, mappedX - mappedRadius);
  const xMax = Math.min(hiddenCanvas.width,  mappedX + mappedRadius);
  const yMin = Math.max(0, mappedY - mappedRadius);
  const yMax = Math.min(hiddenCanvas.height, mappedY + mappedRadius);

  for (let x = xMin; x < xMax; x += 3) {
    for (let y = yMin; y < yMax; y += 3) {
      const dist = Math.sqrt(
        Math.pow(mappedX - x, 2) + Math.pow(mappedY - y, 2)
      );
      if (dist <= mappedRadius) {
        const weight = 1.0 - (dist / mappedRadius) * currentFeather;
        const idx    = (y * hiddenCanvas.width + x) * 4;
        sumR += imgData[idx]     * weight;
        sumG += imgData[idx + 1] * weight;
        sumB += imgData[idx + 2] * weight;
        weightTotal += weight;
        luminances.push(
          imgData[idx]     * 0.299 +
          imgData[idx + 1] * 0.587 +
          imgData[idx + 2] * 0.114
        );
      }
    }
  }

  if (weightTotal > 0) {
    const avgR = sumR / weightTotal;
    const avgG = sumG / weightTotal;
    const avgB = sumB / weightTotal;

    const hsl    = rgbToHsl(avgR, avgG, avgB);
    currentHue   = hsl.h;
    currentSat   = hsl.s;
    currentLight = hsl.l;
    currentMass  = weightTotal;

    // Luminance variance = visual complexity under cursor
    const mean = luminances.reduce((a, b) => a + b, 0) / luminances.length;
    const variance = luminances.reduce(
      (a, b) => a + Math.pow(b - mean, 2), 0
    ) / luminances.length;
    currentVariance = Math.min(1, variance / 3000);

    // Hue buffer for gesture tracking
    hueBuffer.push(currentHue);
    if (hueBuffer.length > HUE_BUFFER_SIZE) hueBuffer.shift();

    // Update running voice parameters in real time
    if (isAudioReady) updateVoice();

    // Broadcast state for Navigator concept
    broadcastState();
  }
}

// ==========================================
// 3. STATE BROADCAST
// ==========================================
let roomToken      = "default";
let collectiveTension = 0;
let lastBroadcast  = 0;

function broadcastState() {
  const now = Date.now();
  if (now - lastBroadcast < 80) return;
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
// 4. SETTINGS
// ==========================================
let instrumentProfile = "atmosphere";
let soundConcept      = "synesthete";
let isAudioReady      = false;

chrome.storage.local.get(
  ['roomToken', 'instrumentProfile', 'soundConcept'],
  (data) => {
    if (data.roomToken)         roomToken         = data.roomToken;
    if (data.instrumentProfile) instrumentProfile = data.instrumentProfile;
    if (data.soundConcept)      soundConcept      = data.soundConcept;
  }
);

// ==========================================
// 5. AUDIO ENGINE — NODES THAT RUN FOREVER
// ==========================================
let audioCtx;

// Shared infrastructure
let masterGain, reverbNode, reverbSend, drySend;

// The continuously running voice nodes
let carrierOsc, modulatorOsc, modGainNode;  // FM pair
let filterNode;                              // Organism filter
let ampLfo, ampLfoGain;                     // Amplitude LFO (pulse/tremolo)
let tremoloLfo, tremoloLfoGain;             // Organism tremolo
let voiceGain;                              // Master voice envelope
let distortionNode;                         // Navigator waveshaper

// Smoothing — prevents zipper noise when params update
const SMOOTH = 0.05; // seconds for param ramps

function setupAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // ── Master output ──
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.45;
  masterGain.connect(audioCtx.destination);

  // ── Reverb ──
  reverbNode = audioCtx.createConvolver();
  reverbNode.buffer = buildReverbIR(3.0);
  reverbSend = audioCtx.createGain();
  drySend    = audioCtx.createGain();
  reverbSend.gain.value = 0.25;
  drySend.gain.value    = 0.75;
  reverbNode.connect(reverbSend);
  reverbSend.connect(masterGain);
  drySend.connect(masterGain);

  // ── FM oscillator pair ──
  carrierOsc   = audioCtx.createOscillator();
  modulatorOsc = audioCtx.createOscillator();
  modGainNode  = audioCtx.createGain();

  carrierOsc.type   = getCarrierWaveform();
  modulatorOsc.type = 'sine';
  carrierOsc.frequency.value   = 220;
  modulatorOsc.frequency.value = 220;
  modGainNode.gain.value       = 0;

  modulatorOsc.connect(modGainNode);
  modGainNode.connect(carrierOsc.frequency);

  // ── Distortion (Navigator) ──
  distortionNode = audioCtx.createWaveShaper();
  distortionNode.oversample = '4x';
  distortionNode.curve = makeDistortionCurve(0);

  // ── Filter (Organism) ──
  filterNode = audioCtx.createBiquadFilter();
  filterNode.type            = 'lowpass';
  filterNode.frequency.value = 2000;
  filterNode.Q.value         = 2;

  // ── Amplitude LFO — creates natural pulsing without a metronome ──
  ampLfo     = audioCtx.createOscillator();
  ampLfoGain = audioCtx.createGain();
  ampLfo.frequency.value = 0.5; // starts slow, updated by variance
  ampLfoGain.gain.value  = 0;   // starts silent
  ampLfo.connect(ampLfoGain);

  // ── Tremolo LFO (Organism) ──
  tremoloLfo     = audioCtx.createOscillator();
  tremoloLfoGain = audioCtx.createGain();
  tremoloLfo.frequency.value = 4;
  tremoloLfoGain.gain.value  = 0;
  tremoloLfo.connect(tremoloLfoGain);

  // ── Voice gain — LFO modulates this to create pulsing ──
  voiceGain = audioCtx.createGain();
  voiceGain.gain.value = 0; // silent until cursor moves

  // Wire: carrier → filter → distortion → voiceGain → dry/reverb
  carrierOsc.connect(filterNode);
  filterNode.connect(distortionNode);
  distortionNode.connect(voiceGain);

  // LFOs modulate voiceGain to create pulsing and tremolo
  ampLfoGain.connect(voiceGain.gain);
  tremoloLfoGain.connect(voiceGain.gain);

  voiceGain.connect(drySend);
  voiceGain.connect(reverbNode);

  // Start everything — they run forever, just silently when not in use
  carrierOsc.start();
  modulatorOsc.start();
  ampLfo.start();
  tremoloLfo.start();

  // Network listener
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "NETWORK_BEAT") {
      try {
        const msg = JSON.parse(message.payload);
        if (msg.type === 'COLLECTIVE_STATE') {
          collectiveTension = msg.tension || 0;
        }
      } catch (e) {}
    }
  });

  isAudioReady = true;
  console.log("Continuous audio engine online.");
}

function getCarrierWaveform() {
  switch (instrumentProfile) {
    case 'grid':       return 'sine';
    case 'weaver':     return 'triangle';
    case 'atmosphere': return 'sawtooth';
    default:           return 'sine';
  }
}

function buildReverbIR(duration) {
  const rate    = 44100;
  const length  = rate * duration;
  const buffer  = audioCtx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 1.5);
    }
  }
  return buffer;
}

function makeDistortionCurve(amount) {
  const n    = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x  = (i * 2) / n - 1;
    curve[i] = amount === 0
      ? x
      : ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// ==========================================
// 6. THE CONTINUOUS UPDATE FUNCTION
//    Called every time extractColors() runs
//    (~every mousemove). All params smoothed.
// ==========================================
function updateVoice() {
  const t = audioCtx.currentTime;

  // ── Pitch from hue ──
  const targetFreq = hueToFreq(currentHue);
  carrierOsc.frequency.setTargetAtTime(targetFreq, t, SMOOTH * 3);

  // ── Concept-specific parameter updates ──
  switch (soundConcept) {
    case 'synesthete': updateSynesthete(t, targetFreq); break;
    case 'navigator':  updateNavigator(t, targetFreq);  break;
    case 'organism':   updateOrganism(t, targetFreq);   break;
    case 'combined':
      updateSynesthete(t, targetFreq);
      updateNavigator(t, targetFreq);
      updateOrganism(t, targetFreq);
      break;
  }

  // ── Volume: fade in when cursor is active, out when still ──
  // voiceGain base level — LFOs will pulse around this
  const baseVol = currentMass > 0 ? getBaseVolume() : 0;
  voiceGain.gain.setTargetAtTime(baseVol, t, SMOOTH);

  // ── Reverb depth from saturation ──
  // Grey = cavernous reverb, vivid = dry
  reverbSend.gain.setTargetAtTime(
    0.1 + (1 - currentSat) * 0.6, t, SMOOTH
  );
  drySend.gain.setTargetAtTime(
    0.3 + currentSat * 0.5, t, SMOOTH
  );
}

function getBaseVolume() {
  switch (instrumentProfile) {
    case 'grid':       return 0.5;
    case 'weaver':     return 0.35;
    case 'atmosphere': return 0.25;
    default:           return 0.4;
  }
}

// ──────────────────────────────────────────
// CONCEPT 2: SYNESTHETE
// Hue → pitch, Sat → FM depth, Light → register
// Amplitude LFO rate from variance = natural pulse
// ──────────────────────────────────────────
function updateSynesthete(t, freq) {
  // FM modulation depth from saturation
  // Low sat (grey) = pure tone, high sat (vivid) = complex metallic
  const modIndex  = currentSat * 6;
  const modFreq   = freq * getModRatio();
  modulatorOsc.frequency.setTargetAtTime(modFreq, t, SMOOTH);
  modGainNode.gain.setTargetAtTime(modFreq * modIndex, t, SMOOTH);

  // Amplitude LFO: variance drives pulse rate
  // Busy visual = faster pulsing, flat visual = slow breathing
  const lfoRate = 0.3 + currentVariance * 4; // 0.3–4.3 Hz
  ampLfo.frequency.setTargetAtTime(lfoRate, t, SMOOTH * 2);

  // LFO depth scales with lightness — bright pages pulse harder
  const lfoDepth = 0.1 + currentLight * 0.3;
  ampLfoGain.gain.setTargetAtTime(lfoDepth, t, SMOOTH);

  // Keep filter open
  filterNode.frequency.setTargetAtTime(6000, t, SMOOTH);
  filterNode.Q.setTargetAtTime(1, t, SMOOTH);

  // No distortion
  distortionNode.curve = makeDistortionCurve(0);
}

function getModRatio() {
  switch (instrumentProfile) {
    case 'grid':       return 2.0;
    case 'weaver':     return 1.5;
    case 'atmosphere': return 0.5;
    default:           return 1.0;
  }
}

// ──────────────────────────────────────────
// CONCEPT 3: NAVIGATOR
// Collective tension between performers
// → distortion amount, filter brightness
// ──────────────────────────────────────────
function updateNavigator(t, freq) {
  // Chromatic pitch instead of pentatonic
  const chromaticFreq = hueToChromaticFreq(currentHue);
  carrierOsc.frequency.setTargetAtTime(chromaticFreq, t, SMOOTH * 2);

  // Tension → distortion
  // All players on same hue = clean, all different = harsh
  const distAmount = collectiveTension * 300;
  distortionNode.curve = makeDistortionCurve(distAmount);

  // Tension also opens/closes filter
  const cutoff = 400 + (1 - collectiveTension) * 5000;
  filterNode.frequency.setTargetAtTime(cutoff, t, SMOOTH);
  filterNode.Q.setTargetAtTime(1 + collectiveTension * 8, t, SMOOTH);

  // No FM modulation in Navigator
  modGainNode.gain.setTargetAtTime(0, t, SMOOTH);

  // Slow pulse from LFO regardless of variance
  ampLfo.frequency.setTargetAtTime(
    0.2 + collectiveTension * 2, t, SMOOTH * 3
  );
  ampLfoGain.gain.setTargetAtTime(0.15, t, SMOOTH);
}

// ──────────────────────────────────────────
// CONCEPT 4: ORGANISM
// Cursor velocity through color space
// → filter cutoff, tremolo, pitch direction
// ──────────────────────────────────────────
function updateOrganism(t, freq) {
  if (hueBuffer.length < 2) return;

  // Calculate hue velocity and direction
  let totalDelta = 0;
  let dirSum     = 0;
  for (let i = 1; i < hueBuffer.length; i++) {
    let delta = hueBuffer[i] - hueBuffer[i - 1];
    if (delta > 180)  delta -= 360;
    if (delta < -180) delta += 360;
    totalDelta += Math.abs(delta);
    dirSum     += Math.sign(delta);
  }
  const velocity = Math.min(1, totalDelta / (hueBuffer.length * 25));
  const dir      = Math.sign(dirSum);

  // Direction shifts pitch up or down a fourth
  const directedFreq = freq * (dir >= 0 ? 1 : 0.75);
  carrierOsc.frequency.setTargetAtTime(directedFreq, t, SMOOTH * 4);

  // Fast movement = bright filter, stillness = dark
  const cutoff = 150 + velocity * 5000;
  filterNode.frequency.setTargetAtTime(cutoff, t, SMOOTH);
  filterNode.Q.setTargetAtTime(1 + currentSat * 6, t, SMOOTH);

  // Tremolo rate from variance
  const tremoloRate = 1 + currentVariance * 10;
  tremoloLfo.frequency.setTargetAtTime(tremoloRate, t, SMOOTH);
  tremoloLfoGain.gain.setTargetAtTime(
    currentVariance * 0.25, t, SMOOTH
  );

  // Amplitude LFO tied to velocity
  // Still cursor = slow breathing, fast movement = faster pulse
  ampLfo.frequency.setTargetAtTime(
    0.2 + velocity * 3, t, SMOOTH * 2
  );
  ampLfoGain.gain.setTargetAtTime(0.1 + velocity * 0.2, t, SMOOTH);

  // No FM, no distortion in pure Organism
  modGainNode.gain.setTargetAtTime(0, t, SMOOTH);
  distortionNode.curve = makeDistortionCurve(0);
}

// ==========================================
// 7. MUSICAL HELPERS
// ==========================================

// Pentatonic scale, hue cycles through it, lightness sets octave
function hueToFreq(hue) {
  const pentatonic  = [0, 2, 4, 7, 9];
  const baseFreq    = 65.41; // C2 — low base for all instruments
  const noteIndex   = Math.floor((hue / 360) * pentatonic.length);
  const semitones   = pentatonic[noteIndex % pentatonic.length];
  const octave      = Math.floor(currentLight * 3); // 0–2 octaves up

  // Each instrument lives in a different register
  const instrumentOffset = {
    grid:       24, // C4 range
    weaver:     12, // C3 range
    atmosphere:  0  // C2 range
  }[instrumentProfile] || 12;

  return baseFreq * Math.pow(2, (semitones + octave * 12 + instrumentOffset) / 12);
}

// Chromatic for Navigator — every hue degree = a distinct semitone
function hueToChromaticFreq(hue) {
  const baseFreq = 65.41;
  const semitone = Math.floor((hue / 360) * 12);
  const octave   = Math.floor(currentLight * 2);
  const instrumentOffset = {
    grid:       24,
    weaver:     12,
    atmosphere:  0
  }[instrumentProfile] || 12;
  return baseFreq * Math.pow(2,
    (semitone + octave * 12 + instrumentOffset) / 12
  );
}

// ==========================================
// 8. FADE OUT WHEN CURSOR IS IDLE
// ==========================================
let idleTimer = null;

document.addEventListener('mousemove', () => {
  clearTimeout(idleTimer);
  // If cursor stops moving, fade voice out after 2 seconds
  idleTimer = setTimeout(() => {
    if (isAudioReady) {
      voiceGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
    }
  }, 2000);
});

// ==========================================
// 9. INIT ON FIRST CLICK
// ==========================================
document.addEventListener('click', () => {
  if (!isAudioReady) {
    setupAudio();
  }
}, { once: true });

// ==========================================
// 10. KEYBOARD CONTROLS
// ==========================================
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement
    ? document.activeElement.tagName.toLowerCase() : '';
  if (
    tag === 'input' ||
    tag === 'textarea' ||
    document.activeElement.isContentEditable
  ) return;

  let changed = false;
  if (e.key === ']') { currentRadius  = Math.min(300, currentRadius + 5);  changed = true; }
  if (e.key === '[') { currentRadius  = Math.max(10,  currentRadius - 5);  changed = true; }
  if (e.key === '=' || e.key === '+') {
    currentFeather = Math.min(1.0, currentFeather + 0.05); changed = true;
  }
  if (e.key === '-') {
    currentFeather = Math.max(0.0, currentFeather - 0.05); changed = true;
  }
  if (changed) updateCursorVisuals();
});

// ==========================================
// 11. INIT
// ==========================================
if (document.body) initCursor();
else document.addEventListener('DOMContentLoaded', initCursor);