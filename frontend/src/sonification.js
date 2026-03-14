/**
 * sonification.js — Noosphere Harmonic Synthesizer (Phase 2 upgrade)
 *
 * Changes from Phase 1:
 *   1. ConvolverNode with a procedurally generated impulse response provides
 *      true spatial reverb (exponential noise decay, no audio file needed).
 *   2. Oscillators are disconnected from the audio graph when muted and
 *      reconnected on unmute — eliminates idle CPU cost.
 *   3. All oscillator chains are built lazily on first toggle, then reused.
 *
 * Each cluster is assigned a fixed pitch (musical fifths).
 * As the camera moves, gain and panning update every animation frame.
 */

// Cluster → base frequency (Hz, ascending fifths)
const CLUSTER_PITCHES = {
    ml: 220.00,  // A3
    bio: 261.63,  // C4
    phys: 329.63,  // E4
    cs: 392.00,  // G4
    math: 493.88,  // B4
    chem: 587.33,  // D5
    econ: 659.25,  // E5
    env: 440.00,  // A4
    med: 523.25,  // C5
    mat: 369.99,  // F#4
    neuro: 311.13,  // Eb4
    eng: 415.30,  // Ab4
    psych: 277.18,  // Db4
    astro: 466.16,  // Bb4
    edu: 349.23,  // F4
};
const DEFAULT_PITCH = 440;

// Maximum distance for audible sound
const MAX_DIST = 60;

// Reverb impulse length in seconds
const IR_DURATION = 2.0;
const IR_DECAY = 4.0;    // higher = faster decay

let _ctx = null;
let _convolver = null;         // shared ConvolverNode for all clusters
let _oscs = {};            // clusterId → { osc, sub, merger, gain, panner }
let _active = false;
let _getCameraPos = null;
let _getClusterCentroids = null;

export function initSonification(getCameraPos, getClusterCentroids) {
    _getCameraPos = getCameraPos;
    _getClusterCentroids = getClusterCentroids;
}

// ── Impulse response (procedural exponential noise decay) ─────────────────────
function _buildImpulseResponse(ctx) {
    const rate = ctx.sampleRate;
    const length = Math.ceil(rate * IR_DURATION);
    const ir = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
        const data = ir.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-IR_DECAY * i / length);
        }
    }
    return ir;
}

function _ensureContext() {
    if (_ctx) return _ctx;
    _ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Shared reverb send
    _convolver = _ctx.createConvolver();
    _convolver.buffer = _buildImpulseResponse(_ctx);
    const reverbGain = _ctx.createGain();
    reverbGain.gain.value = 0.18;
    _convolver.connect(reverbGain);
    reverbGain.connect(_ctx.destination);

    return _ctx;
}

// ── Build one oscillator chain per cluster ────────────────────────────────────
function _buildChain(clusterId) {
    const freq = CLUSTER_PITCHES[clusterId] || DEFAULT_PITCH;

    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, _ctx.currentTime);

    const sub = _ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freq * 0.5, _ctx.currentTime);

    const merger = _ctx.createGain();
    merger.gain.value = 0.7;

    const gain = _ctx.createGain();
    gain.gain.setValueAtTime(0, _ctx.currentTime);

    const panner = _ctx.createStereoPanner();

    osc.connect(merger);
    sub.connect(merger);
    merger.connect(gain);
    _connectChain(gain, panner);

    osc.start();
    sub.start();

    return { osc, sub, merger, gain, panner };
}

/** Connect gain → panner → destination AND gain → reverb send */
function _connectChain(gain, panner) {
    gain.connect(panner);
    panner.connect(_ctx.destination);
    gain.connect(_convolver);  // reverb send
}

/** Disconnect panner and reverb send (mute without stopping oscillators) */
function _disconnectChain(gain, panner) {
    try { gain.disconnect(panner); } catch { }
    try { panner.disconnect(); } catch { }
    try { gain.disconnect(_convolver); } catch { }
}

function _buildOscillators(centroids) {
    // Tear down stale chains (cluster set changed)
    Object.entries(_oscs).forEach(([, chain]) => {
        _disconnectChain(chain.gain, chain.panner);
        try { chain.osc.stop(); chain.sub.stop(); } catch { }
    });
    _oscs = {};

    centroids.forEach((_, clusterId) => {
        _oscs[clusterId] = _buildChain(clusterId);
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function update(cameraPos) {
    if (!_active || !_ctx || !_getClusterCentroids) return;
    const centroids = _getClusterCentroids();
    if (!centroids || centroids.size === 0) return;

    if (Object.keys(_oscs).length === 0) _buildOscillators(centroids);

    const now = _ctx.currentTime;
    centroids.forEach((pos, clusterId) => {
        const chain = _oscs[clusterId];
        if (!chain) return;

        const dx = cameraPos.x - pos.x;
        const dy = cameraPos.y - pos.y;
        const dz = cameraPos.z - pos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        const normalized = Math.max(0, 1 - dist / MAX_DIST);
        const gainVal = Math.min(0.12, normalized * normalized * 0.12);
        const pan = Math.max(-1, Math.min(1, dx / MAX_DIST));

        chain.gain.gain.setTargetAtTime(gainVal, now, 0.3);
        chain.panner.pan.setTargetAtTime(pan, now, 0.1);
    });
}

export function toggleSonification() {
    const ctx = _ensureContext();

    if (!_active) {
        _active = true;
        if (ctx.state === 'suspended') ctx.resume();

        const centroids = _getClusterCentroids ? _getClusterCentroids() : null;
        if (centroids && centroids.size > 0) {
            if (Object.keys(_oscs).length === 0) {
                _buildOscillators(centroids);
            } else {
                // Reconnect existing chains
                Object.values(_oscs).forEach(({ gain, panner }) => {
                    _connectChain(gain, panner);
                });
            }
        }
    } else {
        _active = false;
        // Disconnect all chains from the graph — no idle audio processing
        Object.values(_oscs).forEach(({ gain, panner }) => {
            _disconnectChain(gain, panner);
        });
    }

    return _active;
}

export function isActive() {
    return _active;
}

export function disposeSonification() {
    _active = false;
    Object.values(_oscs).forEach(({ osc, sub }) => {
        try { osc.stop(); sub.stop(); } catch { }
    });
    _oscs = {};
    if (_ctx) { _ctx.close(); _ctx = null; }
    _convolver = null;
}
