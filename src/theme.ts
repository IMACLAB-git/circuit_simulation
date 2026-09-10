/**
 * Colour themes.
 *
 * CSS custom properties cover the HTML chrome (see styles.css). The canvases
 * repaint every frame and cannot cheaply read those, so everything they draw
 * comes from here, keyed by the same name that sits on <html data-theme>.
 */
export type ThemeName = 'dark' | 'light';

type Rgb = [number, number, number];

export interface CanvasTheme {
  bg: string;
  grid: string;
  gridStrong: string;
  /** Component bodies. */
  body: string;
  text: string;
  textStrong: string;
  select: string;
  hover: string;
  /** Wires and leads when voltage colouring is off. */
  wireIdle: string;
  /** Charge dots, and the halo that lifts them off the wire underneath. */
  dot: string;
  dotHalo: string;
  ghostBody: string;
  ghostLead: string;
  probeLabelBg: string;
  marqueeFill: string;
  marqueeStroke: string;
  /** HSL lightness of an unlit LED's own colour. */
  ledOff: number;
  /** Voltage ramp stops, position in -1..1 against the circuit's voltage span. */
  ramp: [number, Rgb][];
  /** Scope trace colours, assigned to probes by position. */
  probes: string[];
  scopeGrid: string;
  scopeZero: string;
  scopeLabel: string;
  /** Palette icons: idle, and on the accent-filled active row. */
  iconBody: string;
  iconLead: string;
  iconOnAccent: string;
  /** Browser UI tint, for <meta name="theme-color">. */
  chrome: string;
}

export const THEMES: Record<ThemeName, CanvasTheme> = {
  dark: {
    bg: '#0b1220',
    grid: '#1b2740',
    gridStrong: '#243352',
    body: '#cbd5e1',
    text: '#94a3b8',
    textStrong: '#e2e8f0',
    select: '#facc15',
    hover: '#38bdf8',
    wireIdle: '#64748b',
    dot: '#fef9c3',
    dotHalo: 'rgba(254,249,195,0.55)',
    ghostBody: 'rgba(203,213,225,0.45)',
    ghostLead: 'rgba(148,163,184,0.5)',
    probeLabelBg: 'rgba(11,18,32,0.85)',
    marqueeFill: 'rgba(56,189,248,0.12)',
    marqueeStroke: 'rgba(56,189,248,0.8)',
    ledOff: 26,
    ramp: [
      [-1, [37, 99, 235]],
      [-0.45, [34, 211, 238]],
      [0, [120, 133, 156]],
      [0.45, [250, 204, 21]],
      [1, [239, 68, 68]],
    ],
    probes: ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185', '#2dd4bf', '#f97316'],
    scopeGrid: '#1b2740',
    scopeZero: '#2b3d61',
    scopeLabel: '#64748b',
    iconBody: '#cbd5e1',
    iconLead: '#64748b',
    iconOnAccent: '#06263a',
    chrome: '#0b1220',
  },
  light: {
    bg: '#fbfcfe',
    grid: '#dfe5ee',
    gridStrong: '#c9d2df',
    body: '#334155',
    text: '#64748b',
    textStrong: '#0f172a',
    // Yellow and pale cyan vanish on white, so the accents shift a shade darker.
    select: '#d97706',
    hover: '#0284c7',
    wireIdle: '#94a3b8',
    // Pale dots would disappear wherever they overhang the wire onto white.
    dot: '#0f172a',
    dotHalo: 'rgba(255,255,255,0.95)',
    ghostBody: 'rgba(51,65,85,0.4)',
    ghostLead: 'rgba(100,116,139,0.45)',
    probeLabelBg: 'rgba(255,255,255,0.92)',
    marqueeFill: 'rgba(2,132,199,0.10)',
    marqueeStroke: 'rgba(2,132,199,0.75)',
    ledOff: 84,
    ramp: [
      [-1, [29, 78, 216]],
      [-0.45, [8, 145, 178]],
      [0, [100, 116, 139]],
      [0.45, [217, 119, 6]],
      [1, [220, 38, 38]],
    ],
    probes: ['#0284c7', '#db2777', '#65a30d', '#d97706', '#7c3aed', '#e11d48', '#0d9488', '#ea580c'],
    scopeGrid: '#e2e8f0',
    scopeZero: '#cbd5e1',
    scopeLabel: '#64748b',
    iconBody: '#334155',
    iconLead: '#94a3b8',
    iconOnAccent: '#ffffff',
    chrome: '#ffffff',
  },
};

export const probeColor = (theme: CanvasTheme, index: number) =>
  theme.probes[index % theme.probes.length];

const STORAGE_KEY = 'circuit-lab.theme';

/** `#theme=light` / `?theme=dark` in the URL: a per-view override for embeds. */
export function themeFromUrl(): ThemeName | null {
  const m = /[#&?]theme=(light|dark)/.exec(location.hash + location.search);
  return m ? (m[1] as ThemeName) : null;
}

export function storedTheme(): ThemeName | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null; // storage blocked, e.g. a third-party iframe
  }
}

export function storeTheme(t: ThemeName): void {
  try { localStorage.setItem(STORAGE_KEY, t); } catch { /* not worth surfacing */ }
}

/**
 * The theme the page opened with. index.html resolves it before first paint
 * (URL, then saved choice, then the OS setting) and stamps it on <html>, so a
 * light-mode visitor never sees a dark flash; this just reads that result.
 */
export function initialTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Puts a theme on the document: CSS variables and the browser UI tint. */
export function applyTheme(t: ThemeName): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[t].chrome);
}
