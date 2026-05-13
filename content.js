// ==========================================
// 1. VISUAL CURSOR & CAMERA SETUP
// ==========================================
let currentRadius  = 80;
let currentFeather = 0.5;
let hiddenCanvas   = document.createElement('canvas');
let hiddenCtx      = hiddenCanvas.getContext('2d', { willReadFrequently: true });
let imgData        = null;
let scaleX = 1, scaleY = 1;

chrome.runtime.sendMessage({ type: "ENSURE_OFFSCREEN" });

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
  x: 0.5, hue: 0, sat: 0, light: 0, variance: 0, rgb: '0,0,0'
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
let allCursorStates = [];
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

// Air uses three pools — micro click bursts pick from LOW or MID;
// beat-pair sines create the detuned shimmer Ikeda uses
const AIR_LOW = [4218.3, 4891.2, 5432.7, 6103.4];
const AIR_MID = [7341.1, 7892.4, 8203.6, 9017.8];
const AIR_BEAT_PAIRS = [
  [5012.0, 5015.7],
  [6440.0, 6442.8],
  [7800.0, 7804.1],
  [8900.0, 8901.9],
];

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

// ── AIR — three-layer Ikeda breath ──
// Layer A: micro click bursts (3-4 sine pings at 4-9kHz, 2-18ms apart)
// Layer B: bandpass noise breath (texture layer, 65% chance)
// Layer C: detuned beating pairs (1.9-4.1Hz throb, 60% chance)
function triggerAir(t, pan, amp) {
  // Layer A
  const burstCount = 3 + (Math.random() < 0.4 ? 1 : 0);
  let offsetMs = 0;
  for (let i = 0; i < burstCount; i++) {
    const pool = Math.random() < 0.5 ? AIR_LOW : AIR_MID;
    const f    = pool[Math.floor(Math.random() * pool.length)];
    const tb   = t + offsetMs * 0.001;
    const dur  = 0.006 + Math.random() * 0.014;
    const a    = amp * (0.7 + Math.random() * 0.5) * (1 - i * 0.18);
    const osc = actx.createOscillator();
    const env = actx.createGain();
    const pnr = actx.createStereoPanner();
    osc.type = 'sine'; osc.frequency.value = f;
    env.gain.setValueAtTime(0, tb);
    env.gain.linearRampToValueAtTime(a, tb + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, tb + dur);
    pnr.pan.value = Math.max(-1, Math.min(1, pan + (Math.random() - 0.5) * 0.35));
    osc.connect(env); env.connect(pnr); pnr.connect(master);
    osc.start(tb); osc.stop(tb + dur + 0.005);
    offsetMs += 2 + Math.random() * 16;
  }

  // Layer B
  if (Math.random() < 0.65) {
    const pool       = Math.random() < 0.5 ? AIR_LOW : AIR_MID;
    const centerFreq = pool[Math.floor(Math.random() * pool.length)];
    const noiseDur   = 0.018 + Math.random() * 0.025;
    const bufLen     = Math.ceil(actx.sampleRate * (noiseDur + 0.01));
    const buf        = actx.createBuffer(1, bufLen, actx.sampleRate);
    const d          = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
    const src = actx.createBufferSource(); src.buffer = buf;
    const bp  = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = centerFreq; bp.Q.value = 12;
    const env = actx.createGain();
    const pnr = actx.createStereoPanner();
    env.gain.setValueAtTime(amp * 0.28, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + noiseDur);
    pnr.pan.value = Math.max(-1, Math.min(1, pan + (Math.random() - 0.5) * 0.2));
    src.connect(bp); bp.connect(env); env.connect(pnr); pnr.connect(master);
    src.start(t); src.stop(t + noiseDur + 0.01);
  }

  // Layer C
  if (Math.random() < 0.6) {
    const pair    = AIR_BEAT_PAIRS[Math.floor(Math.random() * AIR_BEAT_PAIRS.length)];
    const beatDur = 0.04 + Math.random() * 0.04;
    pair.forEach((freq, i) => {
      const osc = actx.createOscillator();
      const env = actx.createGain();
      const pnr = actx.createStereoPanner();
      osc.type = 'sine'; osc.frequency.value = freq;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(amp * 0.55, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + beatDur);
      pnr.pan.value = Math.max(-1, Math.min(1, pan + (i === 0 ? -0.15 : 0.15)));
      osc.connect(env); env.connect(pnr); pnr.connect(master);
      osc.start(t); osc.stop(t + beatDur + 0.005);
    });
  }
}

// ── NOISE — bandpass static (longer duration, much louder per Lukas's changes) ──
function triggerNoise(t, pan, density, amp) {
  if (Math.random() > density) return;
  const bands = [[247,300],[369,250],[547,200],[196,180]];
  const [cF, bw] = bands[Math.floor(Math.random()*bands.length)];
  const dur    = 0.03 + Math.random() * 0.05; // Lukas: longer noise bursts
  const bufLen = Math.ceil(actx.sampleRate * (dur + 0.01));
  const buf    = actx.createBuffer(1, bufLen, actx.sampleRate);
  const d      = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource(); src.buffer = buf;
  const bp  = actx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = cF; bp.Q.value = cF/bw;
  const env = actx.createGain();
  const pnr = actx.createStereoPanner();
  env.gain.setValueAtTime(amp * 5, t); // Lukas: 5x amp boost for presence
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  pnr.pan.value = pan;
  src.connect(bp); bp.connect(env); env.connect(pnr); pnr.connect(master);
  src.start(t); src.stop(t + dur + 0.01);
}

// ==========================================
// 5. COLOR → AUDIO PARAMETER MAPPING
// ==========================================
function getCursorByRole(role) {
  return allCursorStates.find(s =>
    s.instruments && s.instruments.includes(role)
  );
}

function computeParams() {
  const defaults = {
    bpm: 120, subAmp: 0.6, panSub: 0,
    tonScale: 1.0, tonAmp: 0.42, tonDensity: 0, panTon: 0,
    airAmp: 0.11, airDensity: 0.5, panAir: 0,
    noiseDensity: 0, noiseAmp: 0.16, textureDensity: 0, panNoise: 0
  };
  const P = { ...defaults };

  // Tempo holder drives BPM and sub
  const tempoCur = getCursorByRole('tempo');
  if (tempoCur && tempoCur.cursor) {
    const c = tempoCur.cursor;
    const warmth = Math.cos((c.hue * Math.PI) / 180);
    P.bpm    = 100 + (warmth * 0.5 + 0.5) * 40;
    P.subAmp = 0.4 + c.sat * 0.6;
    P.panSub = (c.x - 0.5) * 2;
  }

  // Tonal holder
  const tonalCur = getCursorByRole('tonal');
  if (tonalCur && tonalCur.cursor) {
    const c = tonalCur.cursor;
    const transposeOptions = [0.5, 0.667, 0.75, 1.0, 1.25, 1.5, 2.0];
    P.tonScale   = transposeOptions[Math.floor((c.hue / 360) * transposeOptions.length) % transposeOptions.length];
    P.tonScale  *= (0.8 + c.light * 0.6);
    P.tonDensity = c.sat;
    P.panTon     = (c.x - 0.5) * 2;
  }

  // Air holder — independent role
  // hue   → airAmp (warm = stronger, cool = softer)
  // sat   → airDensity (saturation = how often it fires)
  // light → small boost to airAmp
  // x     → pan
  const airCur = getCursorByRole('air');
  if (airCur && airCur.cursor) {
    const c       = airCur.cursor;
    const warmth  = Math.cos((c.hue * Math.PI) / 180);
    P.airAmp     = 0.08 + (warmth * 0.5 + 0.5) * 0.14 + c.light * 0.06;
    P.airDensity = 0.3 + c.sat * 0.7;
    P.panAir     = (c.x - 0.5) * 2;
  }

  // Noise holder — Lukas's louder values
  const noiseCur = getCursorByRole('noise');
  if (noiseCur && noiseCur.cursor) {
    const c = noiseCur.cursor;
    P.noiseDensity   = c.variance;
    P.noiseAmp       = 0.85 + c.sat * 0.70; // Lukas: much higher base
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

  // SUB (tempo holder only)
  if (myInstruments.has('tempo')) {
    if (patterns.sub[s]) triggerSub(t, P.panSub, P.subAmp);
    if (!patterns.sub[s] && Math.random() < P.textureDensity * 0.25) {
      triggerSub(t, P.panSub, P.subAmp);
    }
  }

  // TONAL (tonal holders) — now independent of air
  if (myInstruments.has('tonal')) {
    const myX = (myCursor.x - 0.5) * 2;
    if (patterns.ton[s]) triggerTonal(t, s, myX, 0.42, P.tonScale);
    if (!patterns.ton[s] && Math.random() < P.tonDensity * 0.6) {
      triggerTonal(t, s, myX, 0.42, P.tonScale);
    }
  }

  // AIR (air holders) — independent role
  if (myInstruments.has('air')) {
    const myX = (myCursor.x - 0.5) * 2;
    const pan = P.panAir !== undefined ? P.panAir : myX;
    if (patterns.air[s]) {
      triggerAir(t, pan, P.airAmp);
    }
    if (!patterns.air[s] && Math.random() < P.airDensity * 0.45) {
      triggerAir(t, pan, P.airAmp * 0.75);
    }
  }

  // NOISE (noise holders)
  if (myInstruments.has('noise')) {
    const myX = (myCursor.x - 0.5) * 2;
    triggerNoise(t, myX, P.noiseDensity, P.noiseAmp);
  }

  // Tempo holder reports BPM to server
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
  const expectedStep = 0;
  const stepDiff     = step - expectedStep;

  if (Math.abs(stepDiff) > 2 || step > 13) {
    step     = 0;
    nextTime = actx.currentTime + 0.05;
    console.log(`Clock resync: hard snap to step 0`);
  } else if (stepDiff !== 0) {
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
      break;

    case 'NETWORK_INSTRUMENTS_CONFIRMED':
      myInstruments = new Set(message.instruments || []);
      console.log(`My instruments: ${Array.from(myInstruments).join(', ')}`);
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
// 9. KEYBOARD CONTROLS
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