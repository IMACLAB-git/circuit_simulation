import { COMPONENTS, defaultParams, type CompType } from './model/components';
import type { Comp, Schematic, Wire } from './model/schematic';

/**
 * Built-in demo circuits.
 *
 * Each entry is written with a tiny DSL: `c()` places a component and `w()`
 * draws a wire segment. Grid coordinates are integers; a terminal that lands
 * anywhere along a wire joins it, so taps are written as plain endpoints.
 */

let seq = 0;
const counters: Record<string, number> = {};

function c(
  type: CompType, x: number, y: number, rot = 0, params: Record<string, number> = {},
): Comp {
  const d = COMPONENTS[type];
  const n = (counters[d.desig] = (counters[d.desig] ?? 0) + 1);
  return {
    id: `c${++seq}`,
    type, x, y, rot,
    params: { ...defaultParams(type), ...params },
    name: type === 'ground' ? '' : `${d.desig}${n}`,
  };
}

function w(x1: number, y1: number, x2: number, y2: number): Wire {
  return { id: `w${++seq}`, x1, y1, x2, y2 };
}

function circuit(build: () => Schematic): Schematic {
  for (const k of Object.keys(counters)) delete counters[k];
  return build();
}

export interface Example {
  id: string;
  name: string;
  note: string;
  build: () => Schematic;
  /** Probes to arm on load: 'v' with a grid point, or 'i' with a comp index. */
  probes?: { kind: 'v'; x: number; y: number; label: string }[];
  timeScale?: number;
  timebase?: number;
}

const rcLowpass = (): Schematic => circuit(() => ({
  comps: [
    c('vsine', 4, 8, 1, { amp: 5, freq: 1000 }),
    c('resistor', 10, 4, 0, { r: 1000 }),
    c('capacitor', 14, 6, 1, { c: 1e-7 }),
    c('ground', 9, 10),
  ],
  wires: [
    w(4, 7, 4, 4), w(4, 4, 9, 4),
    w(11, 4, 14, 4), w(14, 4, 14, 5),
    w(14, 7, 14, 10),
    w(4, 9, 4, 10), w(4, 10, 14, 10),
  ],
}));

const ledBlinker = (): Schematic => circuit(() => ({
  comps: [
    c('battery', 2, 8, 1, { dc: 5 }),
    c('resistor', 9, 4, 1, { r: 470 }),      // R1 collector load, Q1
    c('led', 9, 7, 1, { hue: 0 }),           // D1
    c('resistor', 5, 5, 1, { r: 22000 }),    // R2 base, Q1
    c('resistor', 15, 5, 1, { r: 22000 }),   // R3 base, Q2
    c('resistor', 19, 4, 1, { r: 470 }),     // R4 collector load, Q2
    c('led', 19, 7, 1, { hue: 205 }),        // D2
    c('npn', 8, 10, 0, { bf: 150 }),         // Q1
    c('npn', 18, 10, 0, { bf: 150 }),        // Q2
    c('capacitor', 12, 7, 0, { c: 2.2e-5 }), // C1
    c('capacitor', 12, 16, 0, { c: 3.3e-5 }), // C2 — unequal on purpose,
    //   so the pair latches one way immediately instead of sitting symmetric
    c('ground', 2, 13), c('ground', 9, 13), c('ground', 19, 13),
  ],
  wires: [
    w(2, 7, 2, 2), w(2, 2, 19, 2), w(2, 9, 2, 13),
    // Q1 collector branch
    w(9, 2, 9, 3), w(9, 5, 9, 6), w(9, 8, 9, 9),
    // Q2 collector branch
    w(19, 2, 19, 3), w(19, 5, 19, 6), w(19, 8, 19, 9),
    // base networks
    w(5, 2, 5, 4), w(5, 6, 5, 10), w(5, 10, 7, 10),
    w(15, 2, 15, 4), w(15, 6, 15, 10), w(15, 10, 17, 10),
    // emitters
    w(9, 11, 9, 13), w(19, 11, 19, 13),
    // C1: Q1 collector -> Q2 base
    w(11, 7, 11, 9), w(11, 9, 9, 9), w(13, 7, 15, 7),
    // C2: Q2 collector -> Q1 base
    w(11, 16, 6, 16), w(6, 16, 6, 10),
    w(13, 16, 21, 16), w(21, 16, 21, 9), w(21, 9, 19, 9),
  ],
}));

const nonInverting = (): Schematic => circuit(() => ({
  comps: [
    c('vsine', 3, 10, 1, { amp: 0.5, freq: 1000 }),
    c('opamp', 10, 8, 0),
    c('resistor', 12, 12, 0, { r: 10000 }),
    c('resistor', 6, 14, 1, { r: 1000 }),
    c('ground', 3, 13), c('ground', 6, 17),
  ],
  wires: [
    w(3, 11, 3, 13),
    w(3, 9, 3, 7), w(3, 7, 8, 7),
    w(12, 8, 15, 8), w(15, 8, 15, 12), w(15, 12, 13, 12),
    w(11, 12, 6, 12), w(6, 12, 6, 9), w(6, 9, 8, 9),
    w(6, 12, 6, 13), w(6, 15, 6, 17),
  ],
}));

const seriesRLC = (): Schematic => circuit(() => ({
  comps: [
    c('vpulse', 4, 8, 1, { vhigh: 5, vlow: 0, freq: 50, duty: 0.5 }),
    c('resistor', 9, 4, 0, { r: 20 }),
    c('inductor', 14, 4, 0, { l: 1e-2 }),
    c('capacitor', 18, 6, 1, { c: 1e-6 }),
    c('ground', 10, 10),
  ],
  wires: [
    w(4, 7, 4, 4), w(4, 4, 8, 4),
    w(10, 4, 13, 4), w(15, 4, 18, 4), w(18, 4, 18, 5),
    w(18, 7, 18, 10),
    w(4, 9, 4, 10), w(4, 10, 18, 10),
  ],
}));

const halfWave = (): Schematic => circuit(() => ({
  comps: [
    c('vsine', 4, 8, 1, { amp: 10, freq: 60 }),
    c('diode', 9, 4, 0),
    c('capacitor', 13, 6, 1, { c: 1e-4 }),
    c('resistor', 17, 6, 1, { r: 1000 }),
    c('ground', 10, 10),
  ],
  wires: [
    w(4, 7, 4, 4), w(4, 4, 8, 4),
    w(10, 4, 17, 4),
    w(13, 4, 13, 5), w(13, 7, 13, 10),
    w(17, 4, 17, 5), w(17, 7, 17, 10),
    w(4, 9, 4, 10), w(4, 10, 17, 10),
  ],
}));

const commonEmitter = (): Schematic => circuit(() => ({
  comps: [
    c('battery', 0, 5, 1, { dc: 12 }),
    c('resistor', 8, 4, 1, { r: 68000 }),    // R1 upper bias
    c('resistor', 8, 12, 1, { r: 12000 }),   // R2 lower bias
    c('resistor', 14, 4, 1, { r: 2200 }),    // R3 collector load
    c('resistor', 14, 14, 1, { r: 470 }),    // R4 emitter degeneration
    c('capacitor', 5, 9, 0, { c: 4.7e-7 }),  // input coupling
    c('vsine', 3, 14, 1, { amp: 0.05, freq: 1000 }),
    c('npn', 13, 9, 0, { bf: 200 }),
    c('ground', 0, 8), c('ground', 3, 17), c('ground', 8, 17), c('ground', 14, 17),
  ],
  wires: [
    w(0, 4, 0, 2), w(0, 2, 14, 2), w(0, 6, 0, 8),
    // bias divider and base
    w(8, 2, 8, 3), w(8, 5, 8, 9), w(8, 9, 12, 9),
    w(8, 9, 8, 11), w(8, 13, 8, 17),
    // collector and emitter
    w(14, 2, 14, 3), w(14, 5, 14, 8),
    w(14, 10, 14, 13), w(14, 15, 14, 17),
    // source through the coupling capacitor
    w(3, 15, 3, 17), w(3, 13, 3, 9), w(3, 9, 4, 9), w(6, 9, 8, 9),
  ],
}));

export const EXAMPLES: Example[] = [
  {
    id: 'led-blinker',
    name: 'LED 점멸기 (비안정 멀티바이브레이터)',
    note: '두 개의 NPN이 서로를 번갈아 꺼뜨리며 LED가 교대로 깜빡입니다. 커패시터 값을 바꾸면 점멸 주기가 달라집니다.',
    build: ledBlinker,
    timeScale: 1,
    timebase: 2,
    probes: [
      { kind: 'v', x: 9, y: 9, label: 'Q1 C' },
      { kind: 'v', x: 19, y: 9, label: 'Q2 C' },
    ],
  },
  {
    id: 'rc-lowpass',
    name: 'RC 저역통과 필터',
    note: '1 kHz 정현파를 R–C로 걸러냅니다. 주파수를 올리면 출력 진폭이 줄고 위상이 뒤처집니다.',
    build: rcLowpass,
    timeScale: 0.02,
    timebase: 4e-3,
    probes: [
      { kind: 'v', x: 4, y: 4, label: '입력' },
      { kind: 'v', x: 14, y: 4, label: '출력' },
    ],
  },
  {
    id: 'rlc',
    name: '직렬 RLC 계단 응답',
    note: '구형파로 RLC를 때려 공진 링잉을 봅니다. R을 줄이면 감쇠가 약해져 오래 울립니다.',
    build: seriesRLC,
    timeScale: 0.05,
    timebase: 0.02,
    probes: [
      { kind: 'v', x: 4, y: 4, label: '입력' },
      { kind: 'v', x: 18, y: 4, label: 'C 전압' },
    ],
  },
  {
    id: 'rectifier',
    name: '반파 정류 + 평활 회로',
    note: '다이오드가 음의 반주기를 잘라내고 커패시터가 리플을 메웁니다. 부하 저항을 줄이면 리플이 커집니다.',
    build: halfWave,
    timeScale: 0.1,
    timebase: 0.08,
    probes: [
      { kind: 'v', x: 4, y: 4, label: '입력' },
      { kind: 'v', x: 17, y: 4, label: '출력' },
    ],
  },
  {
    id: 'noninv-amp',
    name: '연산증폭기 비반전 증폭기',
    note: '이득은 1 + Rf/Rg = 11배입니다. 입력 진폭을 키우면 포화 전압에서 잘립니다.',
    build: nonInverting,
    timeScale: 0.02,
    timebase: 4e-3,
    probes: [
      { kind: 'v', x: 3, y: 7, label: '입력' },
      { kind: 'v', x: 15, y: 8, label: '출력' },
    ],
  },
  {
    id: 'common-emitter',
    name: '이미터 접지 증폭기',
    note: '분압 바이어스를 건 NPN 한 석 증폭기입니다. 컬렉터 전압이 입력과 반대 위상으로 흔들립니다.',
    build: commonEmitter,
    timeScale: 0.02,
    timebase: 4e-3,
    probes: [
      { kind: 'v', x: 12, y: 9, label: '베이스' },
      { kind: 'v', x: 14, y: 8, label: '컬렉터' },
    ],
  },
];
