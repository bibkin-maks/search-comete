/**
 * search-comete - wormhole.js
 *
 * Wormhole button in the HUD that toggles dark ↔ light mode.
 * Dark → Light : Supernova explosion (bright flash expanding outward)
 * Light → Dark : Dwarf planet dying  (implosion, screen collapses to black)
 *
 * Public API:
 *   initWormhole(onToggle)   - inject button + styles, wire click
 *   getCurrentMode()         - returns 'dark' | 'light'
 */

import { playSupernova, playDwarfDeath } from './sound.js';

// ── State ─────────────────────────────────────────────────────────────────────

let _mode = 'dark'; // current mode
let _animating = false;
let _onToggle = null;

export function getCurrentMode() { return _mode; }

// ── CSS variables for each mode ───────────────────────────────────────────────

const DARK_VARS = {
  '--ink':     '#0a0a12',
  '--paper':   '#f5f2eb',
  '--dim':     'rgba(245,242,235,0.45)',
  '--dimmer':  'rgba(245,242,235,0.15)',
  '--gold':    '#c9a84c',
  '--bg':      '#06060f',
};

const LIGHT_VARS = {
  '--ink':     '#f5f2eb',    // inverted - light bg
  '--paper':   '#1a1a2e',    // dark text on light
  '--dim':     'rgba(26,26,46,0.6)',
  '--dimmer':  'rgba(26,26,46,0.3)',
  '--gold':    '#8b6914',    // darker gold for contrast on parchment
  '--bg':      '#f0ece0',    // warm parchment
};

// ── Init ──────────────────────────────────────────────────────────────────────

export function initWormhole(onToggle, renderer) {
  _onToggle = onToggle;
  _injectStyles();
  _injectButton();
  _injectOverlays();
  // Store renderer reference so we can flip background color
  if (renderer) _renderer = renderer;
}

let _renderer = null;

// ── Inject styles ─────────────────────────────────────────────────────────────

function _injectStyles() {
  const s = document.createElement('style');
  s.id = 'wormhole-styles';
  s.textContent = `
    /* ── Wormhole button ── */
    #wormhole-btn {
      position: fixed;
      top: 18px;
      right: 160px;
      z-index: 15;
      width: 36px;
      height: 36px;
      background: none;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: all;
    }

    #wormhole-btn svg {
      width: 28px;
      height: 28px;
      animation: wormhole-spin 8s linear infinite;
      filter: drop-shadow(0 0 4px rgba(201,168,76,0.4));
      transition: filter 0.3s;
    }
    #wormhole-btn:hover svg {
      filter: drop-shadow(0 0 8px rgba(201,168,76,0.9));
      animation-duration: 2s;
    }
    @keyframes wormhole-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* ── Supernova overlay (dark→light) ── */
    #supernova-overlay {
      position: fixed;
      inset: 0;
      z-index: 200;
      pointer-events: none;
      opacity: 0;
      background: radial-gradient(
        circle at 50% 50%,
        #ffffff 0%,
        #fff8e7 18%,
        #f5d980 40%,
        #fa8c4f 65%,
        rgba(10,10,18,0) 100%
      );
    }

    /* ── Dwarf planet overlay (light→dark) ── */
    #dwarf-overlay {
      position: fixed;
      inset: 0;
      z-index: 200;
      pointer-events: none;
      opacity: 0;
      background: radial-gradient(
        circle at 50% 50%,
        rgba(0,0,0,0) 0%,
        rgba(0,0,0,0) 30%,
        rgba(6,6,15,0.7) 65%,
        rgba(6,6,15,1) 100%
      );
    }

    /* ══════════════════════════════════════════════
       LIGHT MODE - warm ivory, easy on the eyes
       Base palette:
         bg:        #f4f0e8  warm ivory
         surface:   #ede9df  slightly darker ivory for panels
         border:    rgba(60,50,30,0.12)
         ink:       #2c2416  near-black warm brown
         ink-dim:   rgba(44,36,22,0.55)
         ink-dimmer:rgba(44,36,22,0.3)
         accent:    #7a5c1e  warm dark gold
    ══════════════════════════════════════════════ */

    body.light-mode {
      background: #f4f0e8 !important;
      color: #2c2416 !important;
    }

    /* Canvas bg is handled by renderer.setClearColor */

    /* ── Top HUD ── */
    body.light-mode #hud-top {
      background: linear-gradient(180deg,
        rgba(244,240,232,0.96) 0%,
        rgba(244,240,232,0) 100%) !important;
    }
    body.light-mode .wordmark { color: #2c2416 !important; }
    body.light-mode .wordmark em { color: #7a5c1e !important; }
    body.light-mode .tagline { color: rgba(44,36,22,0.38) !important; }
    body.light-mode .elastic-pill {
      color: rgba(44,36,22,0.4) !important;
      border-color: rgba(44,36,22,0.15) !important;
    }
    body.light-mode .es-dot { background: #5a9e7a !important; }

    /* ── Search ── */
    body.light-mode #search-input {
      background: rgba(255,252,245,0.8) !important;
      border: 0.5px solid rgba(44,36,22,0.2) !important;
      color: #2c2416 !important;
      box-shadow: 0 2px 12px rgba(44,36,22,0.06) !important;
    }
    body.light-mode #search-input::placeholder { color: rgba(44,36,22,0.32) !important; }
    body.light-mode #search-input:focus {
      border-color: rgba(122,92,30,0.45) !important;
      background: rgba(255,252,245,0.95) !important;
      box-shadow: 0 2px 16px rgba(122,92,30,0.1) !important;
    }
    body.light-mode #search-btn {
      color: #7a5c1e !important;
      border-left-color: rgba(44,36,22,0.12) !important;
    }
    body.light-mode #search-btn:hover { background: rgba(122,92,30,0.07) !important; }
    body.light-mode .chip {
      color: rgba(44,36,22,0.5) !important;
      border-color: rgba(44,36,22,0.14) !important;
      background: rgba(255,252,245,0.5) !important;
    }
    body.light-mode .chip:hover {
      color: #7a5c1e !important;
      border-color: rgba(122,92,30,0.5) !important;
      background: rgba(122,92,30,0.06) !important;
    }

    /* ── Results label ── */
    body.light-mode #results-label { color: #7a5c1e !important; }

    /* ── Legend ── */
    body.light-mode #legend {
      background: rgba(244,240,232,0.75) !important;
      padding: 10px 12px !important;
      border-radius: 3px !important;
      border: 0.5px solid rgba(44,36,22,0.1) !important;
      backdrop-filter: blur(8px) !important;
    }
    body.light-mode .legend-row { color: rgba(44,36,22,0.42) !important; }
    body.light-mode .legend-row.active,
    body.light-mode .legend-row:hover { color: #2c2416 !important; }
    body.light-mode .legend-group-header { color: rgba(44,36,22,0.28) !important; }

    /* ── Misc HUD ── */
    body.light-mode #star-count { color: rgba(44,36,22,0.28) !important; }
    body.light-mode #instructions { color: rgba(44,36,22,0.22) !important; }
    body.light-mode #warp-overlay {
      background: radial-gradient(ellipse at center,
        rgba(122,92,30,0.06) 0%, transparent 70%) !important;
    }

    /* ── Time travel + meteor ── */
    body.light-mode #time-travel,
    body.light-mode #meteor-fact {
      background: rgba(255,252,245,0.82) !important;
      border: 0.5px solid rgba(44,36,22,0.12) !important;
      box-shadow: 0 2px 14px rgba(44,36,22,0.06) !important;
    }
    body.light-mode .tt-heading,
    body.light-mode .meteor-label { color: #7a5c1e !important; }
    body.light-mode .meteor-title { color: #2c2416 !important; }
    body.light-mode .meteor-meta { color: rgba(44,36,22,0.42) !important; }
    body.light-mode #year-readout { color: rgba(44,36,22,0.48) !important; }
    body.light-mode #year-slider { accent-color: #7a5c1e !important; }

    /* ── Detail panel - frosted ivory ── */
    body.light-mode #detail-panel {
      background: rgba(244,240,232,0.97) !important;
      border-left: 0.5px solid rgba(44,36,22,0.12) !important;
      box-shadow: -8px 0 32px rgba(44,36,22,0.08) !important;
    }
    body.light-mode #detail-close { color: rgba(44,36,22,0.35) !important; }
    body.light-mode #detail-close:hover { color: #2c2416 !important; }
    body.light-mode #detail-category { }
    body.light-mode #detail-title {
      color: #2c2416 !important;
      font-weight: 400 !important;
    }
    body.light-mode #detail-authors { color: rgba(44,36,22,0.52) !important; }
    body.light-mode #detail-year { color: #7a5c1e !important; }
    body.light-mode .detail-field-label { color: rgba(44,36,22,0.38) !important; }
    body.light-mode #detail-abstract {
      color: rgba(44,36,22,0.68) !important;
      border-left-color: rgba(122,92,30,0.3) !important;
    }
    body.light-mode .score-bar-wrap { background: rgba(44,36,22,0.1) !important; }
    body.light-mode .score-bar { background: #7a5c1e !important; }
    body.light-mode .score-val { color: #7a5c1e !important; }
    body.light-mode .similar-item {
      border-color: rgba(44,36,22,0.1) !important;
      background: transparent !important;
    }
    body.light-mode .similar-item:hover {
      background: rgba(122,92,30,0.05) !important;
      border-color: rgba(122,92,30,0.22) !important;
    }
    body.light-mode .similar-title { color: #2c2416 !important; }
    body.light-mode .similar-meta { color: rgba(44,36,22,0.4) !important; }
    body.light-mode .elastic-query-box {
      background: rgba(44,36,22,0.04) !important;
      border-color: rgba(44,36,22,0.1) !important;
      color: rgba(44,36,22,0.48) !important;
    }
    body.light-mode .detail-action-btn {
      background: rgba(122,92,30,0.07) !important;
      border-color: rgba(122,92,30,0.22) !important;
      color: #7a5c1e !important;
    }
    body.light-mode .detail-action-btn:hover {
      background: rgba(122,92,30,0.13) !important;
      border-color: rgba(122,92,30,0.4) !important;
    }

    /* ── Tooltip ── */
    body.light-mode #tooltip {
      background: rgba(255,252,245,0.95) !important;
      border-color: rgba(44,36,22,0.14) !important;
      box-shadow: 0 4px 16px rgba(44,36,22,0.1) !important;
    }
    body.light-mode #tt-title { color: #2c2416 !important; }
    body.light-mode #tt-meta { color: rgba(44,36,22,0.44) !important; }

    /* ── Comet toast ── */
    body.light-mode #comet-toast {
      background: rgba(255,252,245,0.94) !important;
      border-color: rgba(122,92,30,0.4) !important;
      color: #7a5c1e !important;
      box-shadow: 0 4px 16px rgba(44,36,22,0.1) !important;
    }

    /* ── Wormhole button ── */
    body.light-mode #wormhole-btn svg {
      filter: drop-shadow(0 0 4px rgba(122,92,30,0.45)) !important;
    }
    `;
  document.head.appendChild(s);
}

// ── Inject button ─────────────────────────────────────────────────────────────

function _injectButton() {
  const btn = document.createElement('button');
  btn.id = 'wormhole-btn';
  btn.title = 'Toggle light/dark mode';
  btn.innerHTML = _wormholeSVG('dark');
  btn.addEventListener('click', _handleClick);
  document.body.appendChild(btn);
}

function _wormholeSVG(mode) {
  const gold = mode === 'dark' ? '#c9a84c' : '#8b6914';
  const dim  = mode === 'dark' ? 'rgba(201,168,76,0.25)' : 'rgba(139,105,20,0.25)';
  return `
    <svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
      <!-- Outer ring -->
      <ellipse cx="14" cy="14" rx="12" ry="5" fill="none" stroke="${gold}" stroke-width="1" opacity="0.6"/>
      <!-- Middle ring -->
      <ellipse cx="14" cy="14" rx="8" ry="3.2" fill="none" stroke="${gold}" stroke-width="0.8" opacity="0.8"/>
      <!-- Inner ring -->
      <ellipse cx="14" cy="14" rx="4" ry="1.6" fill="none" stroke="${gold}" stroke-width="0.6" opacity="1"/>
      <!-- Core glow -->
      <circle cx="14" cy="14" r="2" fill="${dim}"/>
      <circle cx="14" cy="14" r="1" fill="${gold}" opacity="0.9"/>
      <!-- Vertical ring -->
      <ellipse cx="14" cy="14" rx="2.5" ry="11" fill="none" stroke="${gold}" stroke-width="0.5" opacity="0.3"/>
    </svg>
  `;
}

// ── Inject overlay divs ───────────────────────────────────────────────────────

function _injectOverlays() {
  const sn = document.createElement('div');
  sn.id = 'supernova-overlay';
  document.body.appendChild(sn);

  const dw = document.createElement('div');
  dw.id = 'dwarf-overlay';
  document.body.appendChild(dw);
}

// ── Click handler ─────────────────────────────────────────────────────────────

function _handleClick() {
  if (_animating) return;
  if (_mode === 'dark') {
    _triggerSupernova();
  } else {
    _triggerDwarfDeath();
  }
}

// ── Supernova: dark → light ───────────────────────────────────────────────────

function _triggerSupernova() {
  _animating = true;
  playSupernova();

  const overlay = document.getElementById('supernova-overlay');

  // Phase 1: Flash expands (0-400ms)
  overlay.style.transition = 'none';
  overlay.style.opacity = '0';
  overlay.style.transform = 'scale(0.1)';
  overlay.style.transition = 'opacity 0.08s ease-out, transform 0.4s cubic-bezier(0.1,0.8,0.3,1)';

  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    overlay.style.transform = 'scale(2.5)';
  });

  // Phase 2: Hold white (400-600ms), apply light mode
  setTimeout(() => {
    _applyMode('light');
    if (_renderer) _renderer.setClearColor(0xf4f0e8, 1);
    document.getElementById('wormhole-btn').innerHTML = _wormholeSVG('light');
  }, 380);

  // Phase 3: Fade overlay out (600-1100ms)
  setTimeout(() => {
    overlay.style.transition = 'opacity 0.55s ease-in, transform 0.55s ease-in';
    overlay.style.opacity = '0';
    overlay.style.transform = 'scale(3.5)';
  }, 600);

  setTimeout(() => {
    overlay.style.transform = 'scale(1)';
    _animating = false;
    if (_onToggle) _onToggle('light');
  }, 1200);
}

// ── Dwarf death: light → dark ─────────────────────────────────────────────────

function _triggerDwarfDeath() {
  _animating = true;
  playDwarfDeath();

  const overlay = document.getElementById('dwarf-overlay');

  // Phase 1: Darkness closes in from edges (0-600ms)
  overlay.style.transition = 'none';
  overlay.style.opacity = '0';
  overlay.style.transform = 'scale(2)';

  requestAnimationFrame(() => {
    overlay.style.transition = 'opacity 0.5s ease-in, transform 0.6s cubic-bezier(0.7,0,1,0.8)';
    overlay.style.opacity = '1';
    overlay.style.transform = 'scale(1)';
  });

  // Phase 2: Apply dark mode at peak (600ms)
  setTimeout(() => {
    _applyMode('dark');
    if (_renderer) _renderer.setClearColor(0x06060f, 1);
    document.getElementById('wormhole-btn').innerHTML = _wormholeSVG('dark');
  }, 580);

  // Phase 3: Final implosion flash + fade (600-900ms)
  setTimeout(() => {
    overlay.style.transition = 'opacity 0.3s ease-out';
    overlay.style.opacity = '0';
  }, 650);

  setTimeout(() => {
    overlay.style.transform = 'scale(2)';
    _animating = false;
    if (_onToggle) _onToggle('dark');
  }, 1000);
}

// ── Apply mode ────────────────────────────────────────────────────────────────

function _applyMode(mode) {
  _mode = mode;
  if (mode === 'light') {
    document.body.classList.add('light-mode');
  } else {
    document.body.classList.remove('light-mode');
  }
}