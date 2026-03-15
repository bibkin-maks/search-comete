/**
 * search-comete - sound.js
 *
 * Procedural ethereal sound engine - Web Audio API only, zero external files.
 * Toggle: set SOUND_ENABLED = false at the top to silence everything.
 *
 * Public API:
 *   initSound()
 *   playWarp()             - camera fly / cluster travel
 *   playStarClick(cluster) - soft crystalline ping, pitch by cluster
 *   playCometAppear()      - distant chime
 *   playCometClick()       - ascending sweep
 *   playSupernova()        - light mode explosion
 *   playDwarfDeath()       - dark mode implosion
 *   setAmbient(bool)
 */

// ── Master toggle ─────────────────────────────────────────────────────────────
export let SOUND_ENABLED = true; // flip to false to silence everything

export function setSoundEnabled(v) { SOUND_ENABLED = v; }

// ── State ─────────────────────────────────────────────────────────────────────
let _ctx = null;
let _masterGain = null;
let _ambientNodes = null;
let _ambientRunning = false;

// ── Init ──────────────────────────────────────────────────────────────────────

export function initSound() {
  if (!SOUND_ENABLED) return;
  _ensureCtx();
  setAmbient(true);
}

function _ensureCtx() {
  if (_ctx) return;
  _ctx = new (window.AudioContext || window.webkitAudioContext)();
  _masterGain = _ctx.createGain();
  _masterGain.gain.setValueAtTime(0.12, _ctx.currentTime); // quieter master
  _masterGain.connect(_ctx.destination);
}

function _resume() {
  if (_ctx && _ctx.state === 'suspended') _ctx.resume();
}

// ── Ambient - subliminal evolving pads ───────────────────────────────────────
// Slow-moving harmonic intervals (perfect 4ths, 5ths, octaves) that shift
// imperceptibly over time. Feels like the universe breathing.

export function setAmbient(on) {
  if (!SOUND_ENABLED) return;
  _ensureCtx(); _resume();
  if (on && !_ambientRunning) { _ambientRunning = true; _startAmbient(); }
  else if (!on && _ambientRunning) { _ambientRunning = false; _stopAmbient(); }
}

function _startAmbient() {
  const now = _ctx.currentTime;

  // Very quiet pad gain - fades in over 8s
  const padGain = _ctx.createGain();
  padGain.gain.setValueAtTime(0, now);
  padGain.gain.linearRampToValueAtTime(0.008, now + 14.0); // very slow fade, barely there
  padGain.connect(_masterGain);

  // Reverb-like convolution via feedback delay
  const delay = _ctx.createDelay(4.0);
  delay.delayTime.setValueAtTime(3.2, now); // longer delay = more liminal space
  const feedback = _ctx.createGain();
  feedback.gain.setValueAtTime(0.72, now); // more reverb tail = bigger space
  const delayFilter = _ctx.createBiquadFilter();
  delayFilter.type = 'lowpass';
  delayFilter.frequency.setValueAtTime(800, now);
  delay.connect(delayFilter);
  delayFilter.connect(feedback);
  feedback.connect(delay);
  delay.connect(padGain);

  // Pad layer 1 - root + perfect 5th slowly evolving
  // Notes: A2=110, E3=164.8, A3=220, E4=329.6
  const padFreqs = [110.0, 164.81, 219.9, 329.63];
  const pads = padFreqs.map((f, i) => {
    const o = _ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, now);
    // Very slow vibrato per voice
    const vib = _ctx.createOscillator();
    vib.frequency.setValueAtTime(0.03 + i * 0.007, now);
    const vibGain = _ctx.createGain();
    vibGain.gain.setValueAtTime(f * 0.001, now); // ~0.1% vibrato depth
    vib.connect(vibGain);
    vibGain.connect(o.frequency);
    vib.start(now);
    o.connect(delay);
    o.connect(padGain);
    o.start(now);
    return { o, vib };
  });

  // Pad layer 2 - higher harmonics, barely audible
  const shimmerFreqs = [440.0, 659.26, 880.0];
  const shimmers = shimmerFreqs.map((f, i) => {
    const o = _ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, now);
    const g = _ctx.createGain();
    g.gain.setValueAtTime(0.003, now); // barely audible shimmer
    o.connect(g); g.connect(padGain);
    o.start(now);
    return o;
  });

  // Slow melodic note that wanders every ~12s
  let _melodyTimeout = null;
  const melGain = _ctx.createGain();
  melGain.gain.setValueAtTime(0, now);
  melGain.connect(delay);
  melGain.connect(padGain);

  const MELODY_NOTES = [220, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00, 440];

  function _playMelodyNote() {
    if (!_ambientRunning || !_ctx) return;
    const t = _ctx.currentTime;
    const freq = MELODY_NOTES[Math.floor(Math.random() * MELODY_NOTES.length)];
    const mel = _ctx.createOscillator();
    mel.type = 'sine';
    mel.frequency.setValueAtTime(freq, t);
    mel.connect(melGain);
    melGain.gain.cancelScheduledValues(t);
    melGain.gain.setValueAtTime(0, t);
    melGain.gain.linearRampToValueAtTime(0.007, t + 2.2); // slower, ghostly rise
    melGain.gain.linearRampToValueAtTime(0, t + 9.0); // longer decay, liminal
    mel.start(t);
    mel.stop(t + 6.5);
    const nextIn = 18000 + Math.random() * 22000; // very infrequent, liminal
    _melodyTimeout = setTimeout(_playMelodyNote, nextIn);
  }
  _melodyTimeout = setTimeout(_playMelodyNote, 20000 + Math.random() * 15000); // delayed first note

  _ambientNodes = { padGain, pads, shimmers, delay, feedback, melGain, _melodyTimeout };
}

function _stopAmbient() {
  if (!_ambientNodes) return;
  const { padGain, pads, shimmers, delay, feedback, _melodyTimeout } = _ambientNodes;
  const now = _ctx.currentTime;
  clearTimeout(_melodyTimeout);
  padGain.gain.linearRampToValueAtTime(0, now + 3.0);
  setTimeout(() => {
    pads.forEach(({ o, vib }) => {
      try { o.stop(); } catch(e) {}
      try { vib.stop(); } catch(e) {}
    });
    shimmers.forEach(o => { try { o.stop(); } catch(e) {} });
  }, 3500);
  _ambientNodes = null;
}

// ── Cluster → pitch mapping ───────────────────────────────────────────────────

const CLUSTER_NOTES = {
  ml:    523.25, cs:    587.33, math:  659.25,
  phys:  698.46, astro: 783.99, chem:  880.00,
  bio:   987.77, neuro: 1046.5, med:   493.88,
  mat:   440.00, eng:   392.00, env:   349.23,
  econ:  329.63, psych: 293.66, edu:   261.63,
};
function _noteForCluster(cluster) {
  return CLUSTER_NOTES[cluster] || CLUSTER_NOTES[(cluster||'').toLowerCase()] || 523.25;
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

function _sine(freq, startTime, duration, gainValue) {
  const osc = _ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startTime);
  const g = _ctx.createGain();
  g.gain.setValueAtTime(gainValue, startTime);
  g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(g); g.connect(_masterGain);
  osc.start(startTime); osc.stop(startTime + duration + 0.05);
}

function _noise(startTime, duration, gainValue, filterFreq, filterType) {
  const bufLen = Math.ceil(_ctx.sampleRate * (duration + 0.1));
  const buf = _ctx.createBuffer(1, bufLen, _ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const src = _ctx.createBufferSource();
  src.buffer = buf;
  const filter = _ctx.createBiquadFilter();
  filter.type = filterType || 'lowpass';
  filter.frequency.setValueAtTime(filterFreq || 800, startTime);
  const g = _ctx.createGain();
  g.gain.setValueAtTime(gainValue, startTime);
  g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  src.connect(filter); filter.connect(g); g.connect(_masterGain);
  src.start(startTime); src.stop(startTime + duration + 0.1);
}

// ── Public sounds ─────────────────────────────────────────────────────────────

// Warp - deep whoosh + faint harmonic shimmer. Only triggered by actual travel.
export function playWarp() {
  if (!SOUND_ENABLED) return;
  _ensureCtx(); _resume();
  const now = _ctx.currentTime;

  const buf = _ctx.createBuffer(1, _ctx.sampleRate * 1.4, _ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noise = _ctx.createBufferSource();
  noise.buffer = buf;
  const filter = _ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(60, now);
  filter.frequency.exponentialRampToValueAtTime(1200, now + 0.3);
  filter.frequency.exponentialRampToValueAtTime(60, now + 1.2);
  filter.Q.setValueAtTime(3, now);
  const g = _ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.18, now + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
  noise.connect(filter); filter.connect(g); g.connect(_masterGain);
  noise.start(now); noise.stop(now + 1.5);

  // Gentle harmonic tail
  [329.63, 440, 523.25].forEach((f, i) => _sine(f, now + 0.1 + i * 0.08, 0.9, 0.028));
}

// Star click - soft bell ping, pitch unique per cluster
export function playStarClick(cluster) {
  if (!SOUND_ENABLED) return;
  _ensureCtx(); _resume();
  const now = _ctx.currentTime;
  const freq = _noteForCluster(cluster);
  _sine(freq,       now,        1.4, 0.07);
  _sine(freq * 2,   now + 0.01, 0.9, 0.025);
  _sine(freq * 2.76,now + 0.02, 0.6, 0.012);
  // Very soft attack transient
  _noise(now, 0.02, 0.012, 6000, 'highpass');
}

// Comet appear - distant chime, long tail
export function playCometAppear() {
  if (!SOUND_ENABLED) return;
  _ensureCtx(); _resume();
  const now = _ctx.currentTime;
  const bell = _ctx.createOscillator();
  bell.type = 'sine';
  bell.frequency.setValueAtTime(330, now);
  bell.frequency.linearRampToValueAtTime(440, now + 0.12);
  const bg = _ctx.createGain();
  bg.gain.setValueAtTime(0, now);
  bg.gain.linearRampToValueAtTime(0.055, now + 0.12);
  bg.gain.exponentialRampToValueAtTime(0.0001, now + 4.5);
  bell.connect(bg); bg.connect(_masterGain);
  bell.start(now); bell.stop(now + 4.6);
  _sine(440 * 2.0, now + 0.05, 3.0, 0.016);
  _noise(now + 0.15, 2.0, 0.009, 900, 'bandpass');
}

// Comet click - ascending shimmer sweep
export function playCometClick() {
  if (!SOUND_ENABLED) return;
  _ensureCtx(); _resume();
  const now = _ctx.currentTime;
  [165, 220, 330, 440, 660, 880].forEach((f, i) => {
    _sine(f, now + i * 0.06, 1.0 - i * 0.1, 0.042 - i * 0.004);
  });
  _noise(now, 0.2, 0.055, 120, 'lowpass');
}

// Supernova - bright boom + expanding shimmer (dark→light)
export function playSupernova() {
  if (!SOUND_ENABLED) return;
  _ensureCtx(); _resume();
  const now = _ctx.currentTime;
  const boom = _ctx.createOscillator();
  boom.type = 'sine';
  boom.frequency.setValueAtTime(55, now);
  boom.frequency.exponentialRampToValueAtTime(16, now + 2.0);
  const bg = _ctx.createGain();
  bg.gain.setValueAtTime(0, now);
  bg.gain.linearRampToValueAtTime(0.45, now + 0.04);
  bg.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
  boom.connect(bg); bg.connect(_masterGain);
  boom.start(now); boom.stop(now + 2.6);
  _noise(now, 1.8, 0.3, 1200, 'lowpass');
  [880, 1320, 1760, 2200].forEach((f, i) => _sine(f, now + 0.05 + i * 0.06, 2.0, 0.025));
  _noise(now + 0.3, 3.0, 0.04, 800, 'bandpass');
}

// Dwarf death - descending implosion (light→dark)
export function playDwarfDeath() {
  if (!SOUND_ENABLED) return;
  _ensureCtx(); _resume();
  const now = _ctx.currentTime;
  const rumble = _ctx.createOscillator();
  rumble.type = 'sawtooth';
  rumble.frequency.setValueAtTime(110, now);
  rumble.frequency.exponentialRampToValueAtTime(14, now + 2.2);
  const rg = _ctx.createGain();
  rg.gain.setValueAtTime(0.18, now);
  rg.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
  const rf = _ctx.createBiquadFilter();
  rf.type = 'lowpass';
  rf.frequency.setValueAtTime(600, now);
  rf.frequency.exponentialRampToValueAtTime(40, now + 2.2);
  rumble.connect(rf); rf.connect(rg); rg.connect(_masterGain);
  rumble.start(now); rumble.stop(now + 2.6);
  _noise(now, 0.5, 0.22, 3000, 'lowpass');
  _noise(now + 0.18, 0.35, 0.14, 700, 'lowpass');
  _noise(now + 0.35, 0.25, 0.08, 200, 'lowpass');
  _sine(36, now + 0.5, 0.8, 0.28);
}