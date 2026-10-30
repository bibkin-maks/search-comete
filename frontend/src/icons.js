/**
 * search-comete - icons.js
 * Inline SVG icons (24px grid, stroke) and the brand mark.
 */

const svg = (body) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const icon = {
  search:   svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  arrow:    svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  close:    svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  layers:   svg('<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>'),
  pin:      svg('<path d="M9 3h6l-1 6 4 4H6l4-4-1-6z"/><path d="M12 13v8"/>'),
  link:     svg('<path d="M4 18c4-1 6-12 16-12"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="6" r="2"/>'),
  web:      svg('<circle cx="12" cy="12" r="2.2"/><circle cx="4.5" cy="6" r="1.6"/><circle cx="19.5" cy="5" r="1.6"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="18.5" r="1.6"/><path d="M10.2 10.8 5.8 7M13.9 10.6l4.3-4.4M10.3 13.4 6.2 17.8M13.8 13.5l4 4"/>'),
  sparkle:  svg('<path d="M12 3c.8 4.5 2.7 6.4 7 7-4.3.8-6.2 2.7-7 7-.8-4.3-2.7-6.2-7-7 4.3-.6 6.2-2.5 7-7z"/><path d="M19 15c.3 1.6 1 2.3 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z"/>'),
  play:     svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>'),
  pause:    svg('<path d="M8 5v14M16 5v14" stroke-width="2.6"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2"/><circle cx="12" cy="12" r="7"/>'),
  locate:   svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  trash:    svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  compare:  svg('<circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/>'),
  quote:    svg('<path d="M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6"/>'),
};

export const brandMark = `
<svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
  <defs>
    <radialGradient id="bm-core" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fff7e6"/>
      <stop offset="45%" stop-color="#e3c27a"/>
      <stop offset="100%" stop-color="#e3c27a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bm-tail" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#9fb4ff" stop-opacity="0"/>
      <stop offset="100%" stop-color="#9fb4ff" stop-opacity="0.9"/>
    </linearGradient>
  </defs>
  <ellipse cx="20" cy="20" rx="17" ry="7" fill="none" stroke="rgba(243,239,230,0.22)" transform="rotate(-24 20 20)"/>
  <path d="M5 33 C 13 27, 19 22, 25.5 15" stroke="url(#bm-tail)" stroke-width="3" stroke-linecap="round" fill="none"/>
  <circle cx="26.5" cy="14" r="7" fill="url(#bm-core)"/>
  <circle cx="26.5" cy="14" r="2.4" fill="#fffaf0"/>
</svg>`;
