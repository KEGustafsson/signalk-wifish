// Toolbar and tile icons (own drawings, in the style of the app's round white-outline buttons).

/** Wrap SVG `body` in a stroked, currentColor icon element hidden from assistive tech. */
const svg = (body: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  viewSwitcher: svg('<rect x="3.5" y="5" width="11" height="8" rx="2" opacity=".6"/><rect x="8.5" y="10" width="11" height="8" rx="2"/>'),
  pause: svg('<rect x="7" y="5" width="3.2" height="14" rx=".6" fill="currentColor" stroke="none"/><rect x="13.8" y="5" width="3.2" height="14" rx=".6" fill="currentColor" stroke="none"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>'),
  camera: svg('<path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z" fill="currentColor" stroke="none"/><circle cx="12" cy="13.3" r="3.3" fill="#242328" stroke="none"/>'),
  more: svg('<circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  sonar: svg('<path d="M7 5.5c3-2 7-2 10 0M8.5 8c2-1.3 5-1.3 7 0"/><path d="M4.5 15.5c3-3.2 9-3.8 12.5 0-3.5 3.8-9.5 3.2-12.5 0z"/><path d="M17 15.5l3-2.2v4.4z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.5"/>'),
  fastForward: svg('<path d="M4 6v12l8-6zM12 6v12l8-6z" fill="currentColor" stroke="none"/>'),
};

/** Large tile art for the view switcher (fish = CHIRP sonar, tree = DownVision). */
const fish = '<g stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"><path d="M34 16c7-4 16-4 22 0M38 22c4-2.5 10-2.5 14 0"/><path d="M22 40c8-9 24-10 34 0-10 10-26 9-34 0z"/><path d="M56 40l10-7v14z"/></g>';
const tree = '<g stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"><path d="M34 13c7-4 16-4 22 0M36 18c5-3 13-3 18 0M38 23c4-2 10-2 14 0"/><path d="M45 56V36M45 44l-8-8M45 40l7-7M37 36l-4 1M52 33l3-3M45 48l6 4"/></g>';
export const TILES = {
  split: `<svg viewBox="0 0 90 120" aria-hidden="true"><defs><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2231a"/><stop offset="1" stop-color="#9b0d06"/></linearGradient><linearGradient id="gg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#666"/><stop offset="1" stop-color="#333"/></linearGradient></defs><rect width="90" height="60" fill="url(#gr)"/><rect y="60" width="90" height="60" fill="url(#gg)"/><g transform="translate(0,-2) scale(1)">${fish}</g><g transform="translate(0,58)">${tree}</g></svg>`,
  sonar: `<svg viewBox="0 0 90 120" aria-hidden="true"><defs><linearGradient id="gr2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2231a"/><stop offset="1" stop-color="#9b0d06"/></linearGradient></defs><rect width="90" height="120" fill="url(#gr2)"/><g transform="translate(-22,10) scale(1.5)">${fish}</g></svg>`,
  downvision: `<svg viewBox="0 0 90 120" aria-hidden="true"><defs><linearGradient id="gg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#666"/><stop offset="1" stop-color="#333"/></linearGradient></defs><rect width="90" height="120" fill="url(#gg2)"/><g transform="translate(-22,12) scale(1.5)">${tree}</g></svg>`,
};
