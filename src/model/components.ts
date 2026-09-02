import type { DeviceType } from '../engine/simulator';

/**
 * Schematic-level component library.
 *
 * Everything here is expressed in grid units with the component origin at its
 * centre; the renderer and the hit tester both work from `pins` and `box`, so
 * adding a part means adding one entry here plus a symbol painter.
 */

export type CompType =
  | 'ground' | 'resistor' | 'capacitor' | 'inductor' | 'potentiometer'
  | 'battery' | 'vsine' | 'vpulse' | 'isource'
  | 'diode' | 'led' | 'npn' | 'pnp' | 'nmos' | 'pmos' | 'opamp'
  | 'switch' | 'button';

export type ParamKind = 'number' | 'bool' | 'select';

export interface ParamSpec {
  key: string;
  label: string;
  unit: string;
  def: number;
  kind?: ParamKind;
  /** Slider bounds. `log` gives a logarithmic slider, right for R / C / L. */
  min?: number;
  max?: number;
  log?: boolean;
  options?: { label: string; value: number }[];
}

export interface CompDef {
  type: CompType;
  name: string;
  /** Reference designator prefix: R1, C2, Q3 ... */
  desig: string;
  category: 'basic' | 'source' | 'semi' | 'io';
  /** Pin positions in grid units, relative to the component origin. */
  pins: [number, number][];
  pinNames: string[];
  /** Hit-test box [x0, y0, x1, y1] in grid units, relative to the origin. */
  box: [number, number, number, number];
  params: ParamSpec[];
  /** Engine device this maps to. Omitted for pure-schematic parts (ground). */
  device?: DeviceType;
  /** Engine parameters that the component pins down rather than exposing. */
  fixed?: Record<string, number>;
  /** Parameter shown next to the symbol on the canvas. */
  display?: string;
  /** Clicking the body toggles this boolean parameter while running. */
  toggle?: string;
  /** Holding the mouse on the body drives `toggle` high, releasing it low. */
  momentary?: boolean;
}

const H2: [number, number][] = [[-1, 0], [1, 0]];
const BOX2: [number, number, number, number] = [-1, -0.7, 1, 0.7];

export const COMPONENTS: Record<CompType, CompDef> = {
  ground: {
    type: 'ground', name: '접지 (GND)', desig: 'GND', category: 'basic',
    pins: [[0, 0]], pinNames: ['gnd'],
    box: [-0.7, -0.2, 0.7, 1],
    params: [],
  },

  resistor: {
    type: 'resistor', name: '저항', desig: 'R', category: 'basic',
    pins: H2, pinNames: ['a', 'b'], box: BOX2,
    device: 'resistor', display: 'r',
    params: [{ key: 'r', label: '저항', unit: 'Ω', def: 1000, min: 0.01, max: 1e7, log: true }],
  },

  capacitor: {
    type: 'capacitor', name: '커패시터', desig: 'C', category: 'basic',
    pins: H2, pinNames: ['a', 'b'], box: BOX2,
    device: 'capacitor', display: 'c',
    params: [{ key: 'c', label: '용량', unit: 'F', def: 1e-6, min: 1e-12, max: 1e-1, log: true }],
  },

  inductor: {
    type: 'inductor', name: '인덕터', desig: 'L', category: 'basic',
    pins: H2, pinNames: ['a', 'b'], box: BOX2,
    device: 'inductor', display: 'l',
    params: [{ key: 'l', label: '인덕턴스', unit: 'H', def: 1e-3, min: 1e-9, max: 10, log: true }],
  },

  potentiometer: {
    // Modelled as the lower half of the track; the wiper position scales it.
    type: 'potentiometer', name: '가변저항', desig: 'RV', category: 'basic',
    pins: H2, pinNames: ['a', 'b'], box: [-1, -1.1, 1, 0.7],
    device: 'resistor', display: 'r',
    params: [
      { key: 'rmax', label: '최대 저항', unit: 'Ω', def: 10000, min: 1, max: 1e6, log: true },
      { key: 'pos', label: '위치', unit: '', def: 0.5, min: 0.001, max: 1 },
    ],
  },

  battery: {
    type: 'battery', name: '전압원 (DC)', desig: 'V', category: 'source',
    pins: H2, pinNames: ['+', '-'], box: BOX2,
    device: 'vsource', display: 'dc', fixed: { wave: 0 },
    params: [{ key: 'dc', label: '전압', unit: 'V', def: 5, min: -50, max: 50 }],
  },

  vsine: {
    type: 'vsine', name: '정현파 전원', desig: 'V', category: 'source',
    pins: H2, pinNames: ['+', '-'], box: [-1, -0.9, 1, 0.9],
    device: 'vsource', display: 'amp', fixed: { wave: 1 },
    params: [
      { key: 'amp', label: '진폭', unit: 'V', def: 5, min: 0, max: 50 },
      { key: 'freq', label: '주파수', unit: 'Hz', def: 1000, min: 0.1, max: 1e6, log: true },
      { key: 'offset', label: '오프셋', unit: 'V', def: 0, min: -50, max: 50 },
      { key: 'phase', label: '위상', unit: '°', def: 0, min: -180, max: 180 },
    ],
  },

  vpulse: {
    type: 'vpulse', name: '구형파 전원', desig: 'V', category: 'source',
    pins: H2, pinNames: ['+', '-'], box: [-1, -0.9, 1, 0.9],
    device: 'vsource', display: 'vhigh', fixed: { wave: 2 },
    params: [
      { key: 'vhigh', label: 'High', unit: 'V', def: 5, min: -50, max: 50 },
      { key: 'vlow', label: 'Low', unit: 'V', def: 0, min: -50, max: 50 },
      { key: 'freq', label: '주파수', unit: 'Hz', def: 1000, min: 0.1, max: 1e6, log: true },
      { key: 'duty', label: '듀티비', unit: '', def: 0.5, min: 0.01, max: 0.99 },
    ],
  },

  isource: {
    type: 'isource', name: '전류원', desig: 'I', category: 'source',
    pins: H2, pinNames: ['out', 'in'], box: [-1, -0.9, 1, 0.9],
    device: 'isource', display: 'dc', fixed: { wave: 0 },
    params: [{ key: 'dc', label: '전류', unit: 'A', def: 1e-3, min: -1, max: 1 }],
  },

  diode: {
    type: 'diode', name: '다이오드', desig: 'D', category: 'semi',
    pins: H2, pinNames: ['A', 'K'], box: BOX2,
    device: 'diode',
    params: [
      { key: 'is', label: '포화전류 Is', unit: 'A', def: 1e-14, min: 1e-18, max: 1e-6, log: true },
      { key: 'n', label: '이상계수 n', unit: '', def: 1, min: 1, max: 2 },
    ],
  },

  led: {
    type: 'led', name: 'LED', desig: 'D', category: 'semi',
    pins: H2, pinNames: ['A', 'K'], box: BOX2,
    device: 'led',
    params: [
      { key: 'vf', label: '순방향 전압', unit: 'V', def: 2, min: 1.5, max: 3.5 },
      { key: 'irated', label: '정격 전류', unit: 'A', def: 0.02, min: 1e-3, max: 0.1, log: true },
      { key: 'hue', label: '색상', unit: '°', def: 0, min: 0, max: 360 },
    ],
  },

  npn: {
    type: 'npn', name: 'NPN 트랜지스터', desig: 'Q', category: 'semi',
    pins: [[-1, 0], [1, -1], [1, 1]], pinNames: ['B', 'C', 'E'],
    box: [-1, -1, 1, 1],
    device: 'npn',
    params: [
      { key: 'bf', label: '전류이득 β', unit: '', def: 100, min: 1, max: 1000, log: true },
      { key: 'is', label: '포화전류 Is', unit: 'A', def: 1e-15, min: 1e-18, max: 1e-9, log: true },
      { key: 'br', label: '역방향 β', unit: '', def: 1, min: 0.1, max: 10 },
    ],
  },

  pnp: {
    type: 'pnp', name: 'PNP 트랜지스터', desig: 'Q', category: 'semi',
    pins: [[-1, 0], [1, -1], [1, 1]], pinNames: ['B', 'C', 'E'],
    box: [-1, -1, 1, 1],
    device: 'pnp',
    params: [
      { key: 'bf', label: '전류이득 β', unit: '', def: 100, min: 1, max: 1000, log: true },
      { key: 'is', label: '포화전류 Is', unit: 'A', def: 1e-15, min: 1e-18, max: 1e-9, log: true },
      { key: 'br', label: '역방향 β', unit: '', def: 1, min: 0.1, max: 10 },
    ],
  },

  nmos: {
    type: 'nmos', name: 'N채널 MOSFET', desig: 'M', category: 'semi',
    pins: [[-1, 0], [1, -1], [1, 1]], pinNames: ['G', 'D', 'S'],
    box: [-1, -1, 1, 1],
    device: 'nmos',
    params: [
      { key: 'vth', label: '문턱전압 Vth', unit: 'V', def: 1.5, min: 0.2, max: 5 },
      { key: 'k', label: '전달상수 K', unit: 'A/V²', def: 0.05, min: 1e-4, max: 5, log: true },
      { key: 'lambda', label: '채널변조 λ', unit: '1/V', def: 0.02, min: 0, max: 0.5 },
    ],
  },

  pmos: {
    type: 'pmos', name: 'P채널 MOSFET', desig: 'M', category: 'semi',
    pins: [[-1, 0], [1, -1], [1, 1]], pinNames: ['G', 'D', 'S'],
    box: [-1, -1, 1, 1],
    device: 'pmos',
    params: [
      { key: 'vth', label: '문턱전압 |Vth|', unit: 'V', def: 1.5, min: 0.2, max: 5 },
      { key: 'k', label: '전달상수 K', unit: 'A/V²', def: 0.05, min: 1e-4, max: 5, log: true },
      { key: 'lambda', label: '채널변조 λ', unit: '1/V', def: 0.02, min: 0, max: 0.5 },
    ],
  },

  opamp: {
    type: 'opamp', name: '연산증폭기', desig: 'U', category: 'semi',
    pins: [[-2, -1], [-2, 1], [2, 0]], pinNames: ['+', '−', 'out'],
    box: [-2, -1.6, 2, 1.6],
    device: 'opamp',
    params: [
      { key: 'gain', label: '개루프 이득', unit: '', def: 1e5, min: 100, max: 1e7, log: true },
      { key: 'vsat', label: '포화 전압', unit: 'V', def: 12, min: 1, max: 50 },
    ],
  },

  switch: {
    type: 'switch', name: '스위치', desig: 'SW', category: 'io',
    pins: H2, pinNames: ['a', 'b'], box: [-1, -1, 1, 0.7],
    device: 'switch', toggle: 'closed',
    params: [{ key: 'closed', label: '닫힘', unit: '', def: 0, kind: 'bool' }],
  },

  button: {
    type: 'button', name: '푸시버튼', desig: 'SW', category: 'io',
    pins: H2, pinNames: ['a', 'b'], box: [-1, -1, 1, 0.7],
    device: 'switch', toggle: 'closed', momentary: true,
    params: [{ key: 'closed', label: '눌림', unit: '', def: 0, kind: 'bool' }],
  },
};

export const PALETTE_GROUPS: { title: string; items: CompType[] }[] = [
  { title: '기본 소자', items: ['resistor', 'capacitor', 'inductor', 'potentiometer', 'ground'] },
  { title: '전원', items: ['battery', 'vsine', 'vpulse', 'isource'] },
  { title: '반도체', items: ['diode', 'led', 'npn', 'pnp', 'nmos', 'pmos', 'opamp'] },
  { title: '입출력', items: ['switch', 'button'] },
];

export function defaultParams(type: CompType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of COMPONENTS[type].params) out[p.key] = p.def;
  return out;
}

/** Rotates a grid-unit offset by `rot` quarter turns clockwise. */
export function rotate(dx: number, dy: number, rot: number): [number, number] {
  switch (((rot % 4) + 4) % 4) {
    case 1: return [-dy, dx];
    case 2: return [-dx, -dy];
    case 3: return [dy, -dx];
    default: return [dx, dy];
  }
}
