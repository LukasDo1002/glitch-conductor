// ==========================================
// 1. VISUAL CURSOR & CAMERA SETUP
// ==========================================
let currentRadius  = 80;
let currentFeather = 0.5;
let hiddenCanvas   = document.createElement('canvas');
let hiddenCtx      = hiddenCanvas.getContext('2d', { willReadFrequently: true });
let imgData        = null;
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
// 2. COLOR EXTRACTION → HSL + VARIANCE
// ==========================================
let myCursor = {
  x:        0.5,  // 0-1, normalized X position on screen
  hue:      0,
  sat:      0,
  light:    0,
  variance: 0,
  rgb:      '0,0,0'
};

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
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
      const dist = Math.sqrt((mappedX-x)**2 + (mappedY-y)**2);
      if (dist <= mappedRadius) {
        const weight = 1.0 - (dist / mappedRadius) * currentFeather;
        const idx    = (y * hiddenCanvas.width + x) * 4;
        sumR += imgData[idx]   * weight;
        sumG += imgData[idx+1] * weight;
        sumB += imgData[idx+2] * weight;
        weightTotal += weight;
        luminances.push(
          imgData[idx]   * 0.299 +
          imgData[idx+1] * 0.587 +
          imgData[idx+2] * 0.114
        );
      }
    }
  }

  if (weightTotal > 0) {
    const avgR = sumR / weightTotal;
    const avgG = sumG / weightTotal;
    const avgB = sumB / weightTotal;
    const hsl  = rgbToHsl(avgR, avgG, avgB);

    const mean = luminances.reduce((a,b)=>a+b, 0) / luminances.length;
    const vari = luminances.reduce((a,b)=>a+(b-mean)**2, 0) / luminances.length;

    myCursor.x        = mouseX / window.innerWidth;
    myCursor.hue      = hsl.h;
    myCursor.sat      = hsl.s;
    myCursor.light    = hsl.l;
    myCursor.variance = Math.min(1, vari / 1200);
    myCursor.rgb      = `${Math.round(avgR)},${Math.round(avgG)},${Math.round(avgB)}`;

    // Send to server (throttled in background.js)
    chrome.runtime.sendMessage({
      type: "SEND_CURSOR_STATE",
      payload: myCursor
    }).catch(() => {});
  }
}

// ==========================================
// 3. SETTINGS & ROLE STATE
// ==========================================
let myId            = null;
let myInstruments   = new Set();
let allCursorStates = []; // includes my own + all other performers
let roomToken       = "default";

chrome.storage.local.get(['roomToken', 'instruments'], (data) => {
  if (data.roomToken)    roomToken = data.roomToken;
  if (data.instruments)  myInstruments = new Set(data.instruments);
});

// ==========================================
// 4. AUDIO ENGINE — IKEDA SYNTHESIS
// ==========================================
const TONAL_FREQS = [
  246.3, 293.4, 196.5, 368.8, 168.2, 144.0,
  293.4, 246.3, 196.5, 368.8, 144.0, 293.4,
  246.3, 196.5, 368.8, 168.2
];
const AIR_CLUSTER = [11541.8, 12042.5, 14014.1, 14343.8];

const PATTERNS = {
  sparse: {
    sub:[1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],
    ton:[1,0,0,0,0,1,0,0,0,0,0,1,0,0,1,0],
    air:[0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0],
    noi:[0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0],
  },
  dataflex: {
    sub:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,1,0],
    ton:[1,0,1,0,0,1,0,1,1,0,0,1,0,1,0,0],
    air:[0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,1],
    noi:[0,0,0,1,0,0,1,0,0,1,0,0,1,0,0,0],
  },
  dense: {
    sub:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0],
    ton:[1,1,0,1,1,0,1,1,0,1,1,0,1,1,0,1],
    air:[1,0,1,0,0,1,1,0,1,0,0,1,1,0,1,0],
    noi:[0,1,0,0,1,0,0,1,0,1,0,0,1,0,1,0],
  },
};

const STEPS = 16;
let patterns = JSON.parse(JSON.stringify(PATTERNS.sparse));

let actx = null, master = null, comp = null;
let isAudioReady = false;

function initAudio() {
  actx     = new (window.AudioContext || window.webkitAudioContext)();
  comp     = actx.createDynamicsCompressor();
  comp.threshold.value = -10; comp.ratio.value = 5;
  comp.attack.value = 0.002;  comp.release.value = 0.1;
  master   = actx.createGain(); master.gain.value = 0.65;
  master.connect(comp);
  comp.connect(actx.destination);
  isAudioReady = true;
  console.log("Glitch Orchestra: Ikeda audio engine online");
}

// ── SUB — pitch-drop sine kick ──
function triggerSub(t, pan, amp) {
  const osc = actx.createOscillator();
  const env = actx.createGain();
  const pnr = actx.createStereoPanner();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(40 * 2.8, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.22 * 0.45);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(amp, t + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  pnr.pan.value = pan;
  osc.connect(env); env.connect(pnr); pnr.connect(master);
  osc.start(t); osc.stop(t + 0.25);
}

// ── TONAL — paired sines, hue transposes ──
function triggerTonal(t, stepIdx, pan, amp, scale) {
  const base = TONAL_FREQS[stepIdx % TONAL_FREQS.length];
  const f    = base * scale;
  const f5   = f * 1.4983;
  [f, f5].forEach((freq, i) => {
    const osc = actx.createOscillator();
    const env = actx.createGain();
    const pnr = actx.createStereoPanner();
    osc.type = 'sine'; osc.frequency.value = freq;
    const a = amp * (i === 0 ? 1 : 0.38);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(a, t + 0.0015);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    pnr.pan.value = pan;
    osc.connect(env); env.connect(pnr); pnr.connect(master);
    osc.start(t); osc.stop(t + 0.11);
  });
}

// ── AIR — ultra-high sine pairs ──
function triggerAir(t, pan, amp) {
  const pick = Math.floor(Math.random() * AIR_CLUSTER.length);
  const f    = AIR_CLUSTER[pick];
  const osc = actx.createOscillator();
  const env = actx.createGain();
  const pnr = actx.createStereoPanner();
  osc.type = 'sine'; osc.frequency.value = f;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(amp, t + 0.0008);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  pnr.pan.value = pan;
  osc.connect(env); env.connect(pnr); pnr.connect(master);
  osc.start(t); osc.stop(t + 0.02);

  // Paired hit 28ms later
  if (Math.random() < 0.5) {
    const f2 = AIR_CLUSTER[(pick+1) % AIR_CLUSTER.length];
    const t2 = t + 0.028 + Math.random() * 0.02;
    const o2 = actx.createOscillator();
    const e2 = actx.createGain();
    const p2 = actx.createStereoPanner();
    o2.type = 'sine'; o2.frequency.value = f2;
    e2.gain.setValueAtTime(0, t2);
    e2.gain.linearRampToValueAtTime(amp * 0.55, t2 + 0.001);
    e2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.012 * 0.7);
    p2.pan.value = Math.max(-1, Math.min(1, pan + (Math.random()-0.5)*0.3));
    o2.connect(e2); e2.connect(p2); p2.connect(master);
    o2.start(t2); o2.stop(t2 + 0.02);
  }
}

// ── NOISE — bandpass static ──
function triggerNoise(t, pan, density, amp) {
  if (Math.random() > density) return;
  const bands = [[247,300],[369,250],[547,200],[196,180]];
  const [cF, bw] = bands[Math.floor(Math.random()*bands.length)];
  const dur    = 0.015 + Math.random() * 0.03;
  const bufLen = Math.ceil(actx.sampleRate * (dur + 0.01));
  const buf    = actx.createBuffer(1, bufLen, actx.sampleRate);
  const d      = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource(); src.buffer = buf;
  const bp  = actx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = cF; bp.Q.value = cF/bw;
  const env = actx.createGain();
  const pnr = actx.createStereoPanner();
  env.gain.setValueAtTime(amp, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  pnr.pan.value = pan;
  src.connect(bp); bp.connect(env); env.connect(pnr); pnr.connect(master);
  src.start(t); src.stop(t + dur + 0.01);
}

// ==========================================
// 5. COLOR → AUDIO PARAMETER MAPPING
// Looks at all 3 cursors in the room and computes parameters.
// Same function on every laptop so all laptops compute the same params.
// ==========================================
function getCursorByRole(role) {
  // Find the cursor of the performer holding `role`
  return allCursorStates.find(s =>
    s.instruments && s.instruments.includes(role)
  );
}

function computeParams() {
  // Defaults if no one holds a role yet
  const defaults = {
    bpm: 120, subAmp: 0.6, panSub: 0,
    tonScale: 1.0, tonAmp: 0.42, tonDensity: 0, panTon: 0, airAmp: 0,
    noiseDensity: 0, noiseAmp: 0.16, textureDensity: 0, panNoise: 0
  };
  const P = { ...defaults };

  // Tempo holder drives BPM and sub
  const tempoCur = getCursorByRole('tempo');
  if (tempoCur && tempoCur.cursor) {
    const c = tempoCur.cursor;
    const warmth = Math.cos((c.hue * Math.PI) / 180);
    P.bpm    = 100 + (warmth * 0.5 + 0.5) * 40; // 100-140 BPM
    P.subAmp = 0.4 + c.sat * 0.6;
    P.panSub = (c.x - 0.5) * 2;
  }

  // Tonal holders — find first one to drive tonal params
  // (if multiple, they all play in sync but each pans to their own X)
  const tonalCur = getCursorByRole('tonal');
  if (tonalCur && tonalCur.cursor) {
    const c = tonalCur.cursor;
    const transposeOptions = [0.5, 0.667, 0.75, 1.0, 1.25, 1.5, 2.0];
    P.tonScale   = transposeOptions[Math.floor((c.hue / 360) * transposeOptions.length) % transposeOptions.length];
    P.tonScale  *= (0.8 + c.light * 0.6);
    P.airAmp     = c.light * 0.5;
    P.tonDensity = c.sat;
    P.panTon     = (c.x - 0.5) * 2;
  }

  // Noise holder
  const noiseCur = getCursorByRole('noise');
  if (noiseCur && noiseCur.cursor) {
    const c = noiseCur.cursor;
    P.noiseDensity   = c.variance;
    P.noiseAmp       = 0.08 + c.sat * 0.25;
    P.textureDensity = c.sat;
    P.panNoise       = (c.x - 0.5) * 2;
  }

  return P;
}

// ==========================================
// 6. SCHEDULER — locked to BPM grid
// ==========================================
let playing  = false;
let step     = 0;
let nextTime = 0;
let schedId  = null;
const LOOK   = 0.07;

function stepDur(bpm) { return 60 / bpm / 4; }

function schedStep(s, t) {
  const P = computeParams();

  // Each layer triggers ONLY if I'm assigned to that role
  // Each performer who has the role runs the same scheduler logic on their laptop

  // ── SUB (tempo holder only) ──
  if (myInstruments.has('tempo')) {
    if (patterns.sub[s]) triggerSub(t, P.panSub, P.subAmp);
    if (!patterns.sub[s] && Math.random() < P.textureDensity * 0.25) {
      triggerSub(t, P.panSub, P.subAmp);
    }
  }

  // ── TONAL + AIR (tonal holders) ──
  if (myInstruments.has('tonal')) {
    // Pan to MY OWN cursor X, not the tonal-holder's
    // (allows multiple tonal players to spatially split)
    const myX = (myCursor.x - 0.5) * 2;
    if (patterns.ton[s]) triggerTonal(t, s, myX, 0.42, P.tonScale);
    if (patterns.air[s] && P.airAmp > 0.01) triggerAir(t, myX, P.airAmp);
    if (!patterns.ton[s] && Math.random() < P.tonDensity * 0.6) {
      triggerTonal(t, s, myX, 0.42, P.tonScale);
    }
    if (!patterns.air[s] && Math.random() < P.textureDensity * 0.5 && P.airAmp > 0.01) {
      triggerAir(t, myX, P.airAmp);
    }
  }

  // ── AIR (separate role — for performers playing air without tonal) ──
  // (Wait — your spec said "tonal + air" together. So we keep them paired.
  //  If you want air separable later, it's a one-line change here.)

  // ── NOISE (noise holders) ──
  if (myInstruments.has('noise')) {
    const myX = (myCursor.x - 0.5) * 2;
    triggerNoise(t, myX, P.noiseDensity, P.noiseAmp);
  }

  // If I'm the tempo holder, report current BPM up to the server
  if (myInstruments.has('tempo')) {
    chrome.runtime.sendMessage({
      type: "SEND_TEMPO",
      bpm: P.bpm
    }).catch(() => {});
  }
}

function scheduler() {
  if (!playing || !actx) return;
  const P = computeParams();
  while (nextTime < actx.currentTime + LOOK) {
    schedStep(step, nextTime);
    step = (step + 1) % STEPS;
    nextTime += stepDur(P.bpm);
  }
  schedId = setTimeout(scheduler, 20);
}

function startPlay() {
  if (!isAudioReady) initAudio();
  playing  = true;
  step     = 0;
  nextTime = actx.currentTime + 0.05;
  scheduler();
}

// ==========================================
// 7. CLOCK SYNC — BAR_TICK from server
// ==========================================
let lastBarTick = null;

function handleBarTick(bar, bpm, serverTime, receivedAt) {
  if (!playing || !actx) return;

  // Where SHOULD we be right now according to the server?
  // The server sends BAR_TICK every 2 seconds, which represents the start of a new bar
  // (16 steps). Each laptop should be at step 0 of a fresh bar at this moment.

  // Estimate one-way network latency (very rough)
  const latency = (Date.now() - receivedAt) / 1000;

  // Calculate expected step position
  // We don't actually know how many steps in we should be, but on every BAR_TICK
  // we should be at step 0 (within a few ms tolerance).
  const expectedStep = 0;
  const stepDiff     = step - expectedStep;

  // If we're more than 2 steps off, snap
  // Otherwise, gently nudge by adjusting nextTime
  if (Math.abs(stepDiff) > 2 || step > 13) {
    // Hard resync — we've drifted too far
    step     = 0;
    nextTime = actx.currentTime + 0.05;
    console.log(`Clock resync: hard snap to step 0`);
  } else if (stepDiff !== 0) {
    // Soft nudge — adjust nextTime to absorb drift over next steps
    const nudgeAmount = stepDiff * stepDur(bpm) * 0.3;
    nextTime -= nudgeAmount;
  }

  lastBarTick = { bar, bpm, time: actx.currentTime };
}

// ==========================================
// 8. NETWORK MESSAGE HANDLER
// ==========================================
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {

    case 'NETWORK_ROLE_STATE':
      // Server told us who has what — but our own instruments are
      // confirmed via INSTRUMENTS_CONFIRMED, not here
      break;

    case 'NETWORK_INSTRUMENTS_CONFIRMED':
      myInstruments = new Set(message.instruments || []);
      console.log(`My instruments: ${Array.from(myInstruments).join(', ')}`);
      // Auto-start audio if we have any instruments
      if (myInstruments.size > 0 && !playing && isAudioReady) {
        startPlay();
      }
      break;

    case 'NETWORK_CURSOR_STATES':
      allCursorStates = message.states || [];
      break;

    case 'NETWORK_BAR_TICK':
      handleBarTick(message.bar, message.bpm, message.serverTime, message.receivedAt);
      break;
  }
});

// ==========================================
// 9. KEYBOARD CONTROLS (radius/feather)
// ==========================================
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement
    ? document.activeElement.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' ||
      document.activeElement.isContentEditable) return;

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
// 10. AUDIO UNLOCK ON FIRST CLICK
// ==========================================
document.addEventListener('click', () => {
  if (!isAudioReady) {
    initAudio();
    if (myInstruments.size > 0) startPlay();
  } else if (!playing && myInstruments.size > 0) {
    startPlay();
  }
}, { once: true });

// ==========================================
// 11. INIT
// ==========================================
if (document.body) initCursor();
else document.addEventListener('DOMContentLoaded', initCursor);