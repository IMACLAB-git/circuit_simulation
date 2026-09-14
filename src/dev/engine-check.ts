/**
 * Headless sanity checks for the solver.
 *
 * Bundled with esbuild and run under node (see package.json "check"). Each case
 * compares the transient result against a closed-form or textbook expectation,
 * so a regression in a device stamp shows up as a number, not as a wrong-looking
 * animation.
 */
import {
  buildNetlist, dragSelection, key, pinPositions, rotateSelection, type Schematic,
} from '../model/schematic';
import { Simulator } from '../engine/simulator';
import { EXAMPLES } from '../examples';

// This file runs under node, not in the browser, so `process` is not in the
// DOM lib. Declaring the one member used avoids pulling in @types/node.
declare const process: { exit(code: number): never };

interface Run {
  sim: Simulator;
  vAt: (x: number, y: number) => number;
  run: (seconds: number, dt: number, onStep?: () => void) => void;
}

function prepare(sch: Schematic): Run {
  const net = buildNetlist(sch);
  const sim = new Simulator();
  sim.build(net.devices, net.nNodes);
  const vAt = (x: number, y: number) => {
    const pi = net.pointIndex.get(key(x, y));
    if (pi === undefined) throw new Error(`no point at ${x},${y}`);
    return sim.nodeVoltage(net.pointNode[pi]);
  };
  const run = (seconds: number, dt: number, onStep?: () => void) => {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      if (!sim.step(dt)) throw new Error(`solver failed at t=${sim.t.toExponential(3)}`);
      onStep?.();
    }
  };
  return { sim, vAt, run };
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`  [${mark}] ${name}  ${detail}`);
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------- unit circuits */

function meterTest() {
  console.log('전압계·전류계');
  const sch = EXAMPLES.find((e) => e.id === 'meters')!.build();
  const vmId = sch.comps.find((c) => c.type === 'voltmeter')!.id;
  const amId = sch.comps.find((c) => c.type === 'ammeter')!.id;
  const r = prepare(sch);
  r.sim.solveDC();
  const vm = r.sim.devices.find((d) => d.id === vmId)!;
  const am = r.sim.devices.find((d) => d.id === amId)!;
  // 10 V across 1k + 2k draws 3.333 mA and leaves 6.667 V across R2.
  check('전류계 = 3.333 mA', near(am.cur, 1 / 300, 1e-6), `${(am.cur * 1e3).toFixed(4)} mA`);
  check('전압계 = 6.667 V', near(vm.volt, 20 / 3, 1e-3), `${vm.volt.toFixed(4)} V`);
  check('전압계 부하 오차 < 1 mV', Math.abs(vm.volt - 20 / 3) < 1e-3,
    `${((vm.volt - 20 / 3) * 1e3).toExponential(2)} mV`);
  check('전류계 부담 전압 < 1 mV', Math.abs(am.volt) < 1e-3,
    `${(am.volt * 1e6).toFixed(2)} uV`);
}

function dragTest() {
  console.log('소자 드래그: 배선 따라오기');
  const sch = EXAMPLES.find((e) => e.id === 'meters')!.build();
  const amId = sch.comps.find((c) => c.type === 'ammeter')!.id;
  const before = prepare(sch);
  before.sim.solveDC();
  const iBefore = before.sim.devices.find((d) => d.id === amId)!.cur;

  // Drag R1 three cells down: its two wires should stretch, not detach.
  const r1 = sch.comps.find((c) => c.name === 'R1')!;
  const pins = pinPositions(r1).map(([x, y]) => key(x, y));
  const moved = dragSelection(sch, new Set([r1.id]), 0, 3);
  const after = prepare(moved);
  after.sim.solveDC();
  const iAfter = after.sim.devices.find((d) => d.id === amId)!.cur;

  const movedR1 = moved.comps.find((c) => c.id === r1.id)!;
  const ends = new Set(moved.wires.flatMap((w) => [key(w.x1, w.y1), key(w.x2, w.y2)]));
  const attached = pinPositions(movedR1).every(([x, y]) => ends.has(key(x, y)));
  const netA = buildNetlist(sch);
  const netB = buildNetlist(moved);

  // Wires with no end on a moved pin must not have shifted at all.
  const othersHeld = moved.wires.every((w, i) => {
    const o = sch.wires[i];
    if (pins.includes(key(o.x1, o.y1)) || pins.includes(key(o.x2, o.y2))) return true;
    return w.x1 === o.x1 && w.y1 === o.y1 && w.x2 === o.x2 && w.y2 === o.y2;
  });

  check('R1이 이동했다', movedR1.y === r1.y + 3, `y ${r1.y} -> ${movedR1.y}`);
  check('배선 끝이 핀을 따라왔다', attached,
    pinPositions(movedR1).map((p) => p.join(',')).join(' / '));
  check('붙지 않은 배선은 그대로', othersHeld, `${moved.wires.length}개 검사`);
  check('노드 수 그대로', netA.nNodes === netB.nNodes, `${netA.nNodes} -> ${netB.nNodes}`);
  check('전류계 눈금 그대로', near(iAfter, iBefore, 1e-12),
    `${(iBefore * 1e3).toFixed(4)} -> ${(iAfter * 1e3).toFixed(4)} mA`);
}

function rotateTest() {
  console.log('소자 회전: 배선 따라오기');
  const sch = EXAMPLES.find((e) => e.id === 'meters')!.build();
  const amId = sch.comps.find((c) => c.type === 'ammeter')!.id;
  const before = prepare(sch);
  before.sim.solveDC();
  const iBefore = before.sim.devices.find((d) => d.id === amId)!.cur;

  // One part alone: spins in place, its wires bend to the new pin positions.
  const r1 = sch.comps.find((c) => c.name === 'R1')!;
  const turned = rotateSelection(sch, new Set([r1.id]));
  const tr1 = turned.comps.find((c) => c.id === r1.id)!;
  const ends = new Set(turned.wires.flatMap((w) => [key(w.x1, w.y1), key(w.x2, w.y2)]));
  const after = prepare(turned);
  after.sim.solveDC();
  const iAfter = after.sim.devices.find((d) => d.id === amId)!.cur;

  check('제자리에서 90도 돌았다', tr1.x === r1.x && tr1.y === r1.y && tr1.rot === (r1.rot + 1) % 4,
    `(${tr1.x},${tr1.y}) rot ${r1.rot} -> ${tr1.rot}`);
  check('배선 끝이 새 핀 자리로', pinPositions(tr1).every(([x, y]) => ends.has(key(x, y))),
    pinPositions(tr1).map((p) => p.join(',')).join(' / '));
  check('노드 수 그대로', buildNetlist(sch).nNodes === buildNetlist(turned).nNodes,
    `${buildNetlist(sch).nNodes} -> ${buildNetlist(turned).nNodes}`);
  check('전류계 눈금 그대로', near(iAfter, iBefore, 1e-12),
    `${(iBefore * 1e3).toFixed(4)} -> ${(iAfter * 1e3).toFixed(4)} mA`);

  // A part plus a wire: the pair turns together about the middle of the two.
  const wire = sch.wires.find((w) => w.x1 === 6 && w.y1 === 2 && w.x2 === 8 && w.y2 === 2)!;
  const block = rotateSelection(sch, new Set([r1.id, wire.id]));
  const bw = block.wires.find((w) => w.id === wire.id)!;
  const br1 = block.comps.find((c) => c.id === r1.id)!;
  // Pivot is the rounded mean of (9,2), (6,2) and (8,2) -> (8,2).
  const spun = (x: number, y: number) => [8 - (y - 2), 2 + (x - 8)];
  const okWire = bw.x1 === spun(6, 2)[0] && bw.y1 === spun(6, 2)[1]
    && bw.x2 === spun(8, 2)[0] && bw.y2 === spun(8, 2)[1];
  check('선택한 배선도 함께 돌았다', okWire, `(${bw.x1},${bw.y1})-(${bw.x2},${bw.y2})`);
  check('소자도 같은 축으로 돌았다', br1.x === spun(9, 2)[0] && br1.y === spun(9, 2)[1],
    `(${br1.x},${br1.y})`);
}

function dividerTest() {
  console.log('저항 분압기');
  const sch: Schematic = {
    comps: [
      { id: 'v', type: 'battery', x: 2, y: 4, rot: 1, name: 'V1', params: { dc: 10 } },
      { id: 'r1', type: 'resistor', x: 6, y: 2, rot: 0, name: 'R1', params: { r: 1000 } },
      { id: 'r2', type: 'resistor', x: 10, y: 2, rot: 0, name: 'R2', params: { r: 3000 } },
      { id: 'g', type: 'ground', x: 12, y: 6, rot: 0, name: '', params: {} },
    ],
    wires: [
      { id: 'w1', x1: 2, y1: 3, x2: 2, y2: 2 }, { id: 'w2', x1: 2, y1: 2, x2: 5, y2: 2 },
      { id: 'w3', x1: 7, y1: 2, x2: 9, y2: 2 },
      { id: 'w4', x1: 11, y1: 2, x2: 12, y2: 2 }, { id: 'w5', x1: 12, y1: 2, x2: 12, y2: 6 },
      { id: 'w6', x1: 2, y1: 5, x2: 2, y2: 6 }, { id: 'w7', x1: 2, y1: 6, x2: 12, y2: 6 },
    ],
  };
  const r = prepare(sch);
  r.run(1e-3, 1e-5);
  const mid = r.vAt(7, 2);
  check('중간 노드 = 7.5 V', near(mid, 7.5, 1e-3), `${mid.toFixed(4)} V`);
  const i = r.sim.devices.find((d) => d.id === 'r1')!.cur;
  check('전류 = 2.5 mA', near(Math.abs(i), 2.5e-3, 1e-6), `${(i * 1e3).toFixed(4)} mA`);
}

function rcStepTest() {
  console.log('RC 계단 응답 (tau = 1 ms)');
  const sch: Schematic = {
    comps: [
      { id: 'v', type: 'battery', x: 2, y: 4, rot: 1, name: 'V1', params: { dc: 5 } },
      { id: 'r', type: 'resistor', x: 6, y: 2, rot: 0, name: 'R1', params: { r: 1000 } },
      { id: 'c', type: 'capacitor', x: 10, y: 4, rot: 1, name: 'C1', params: { c: 1e-6 } },
      { id: 'g', type: 'ground', x: 6, y: 6, rot: 0, name: '', params: {} },
    ],
    wires: [
      { id: 'w1', x1: 2, y1: 3, x2: 2, y2: 2 }, { id: 'w2', x1: 2, y1: 2, x2: 5, y2: 2 },
      { id: 'w3', x1: 7, y1: 2, x2: 10, y2: 2 }, { id: 'w4', x1: 10, y1: 2, x2: 10, y2: 3 },
      { id: 'w5', x1: 10, y1: 5, x2: 10, y2: 6 },
      { id: 'w6', x1: 2, y1: 5, x2: 2, y2: 6 }, { id: 'w7', x1: 2, y1: 6, x2: 10, y2: 6 },
    ],
  };
  const dt = 1e-7;
  const r = prepare(sch);
  r.run(1e-3, dt);
  const v = r.vAt(10, 2);
  const exact = 5 * (1 - Math.exp(-1));
  check('t = tau 에서 63.2 %', near(v, exact, 0.01), `${v.toFixed(4)} V (이론 ${exact.toFixed(4)})`);
  r.run(4e-3, dt);
  const v5 = r.vAt(10, 2);
  check('t = 5tau 에서 정상상태', near(v5, 5, 0.05), `${v5.toFixed(4)} V`);
}

function diodeTest() {
  console.log('다이오드 순방향 강하');
  const sch: Schematic = {
    comps: [
      { id: 'v', type: 'battery', x: 2, y: 4, rot: 1, name: 'V1', params: { dc: 5 } },
      { id: 'r', type: 'resistor', x: 6, y: 2, rot: 0, name: 'R1', params: { r: 1000 } },
      { id: 'd', type: 'diode', x: 10, y: 2, rot: 0, name: 'D1', params: { is: 1e-14, n: 1 } },
      { id: 'g', type: 'ground', x: 6, y: 6, rot: 0, name: '', params: {} },
    ],
    wires: [
      { id: 'w1', x1: 2, y1: 3, x2: 2, y2: 2 }, { id: 'w2', x1: 2, y1: 2, x2: 5, y2: 2 },
      { id: 'w3', x1: 7, y1: 2, x2: 9, y2: 2 },
      { id: 'w4', x1: 11, y1: 2, x2: 12, y2: 2 }, { id: 'w5', x1: 12, y1: 2, x2: 12, y2: 6 },
      { id: 'w6', x1: 2, y1: 5, x2: 2, y2: 6 }, { id: 'w7', x1: 2, y1: 6, x2: 12, y2: 6 },
    ],
  };
  const r = prepare(sch);
  r.run(1e-3, 1e-5);
  const vd = r.vAt(9, 2);
  const id = r.sim.devices.find((d) => d.id === 'd')!.cur;
  // Solve I = (5 - n Vt ln(I/Is + 1)) / R by iteration for the reference value.
  let iRef = 4e-3;
  for (let k = 0; k < 200; k++) {
    const vdRef = 0.025852 * Math.log(iRef / 1e-14 + 1);
    iRef = 0.5 * iRef + 0.5 * (5 - vdRef) / 1000;
  }
  check('순방향 전압 0.6~0.8 V', vd > 0.6 && vd < 0.8, `${vd.toFixed(4)} V`);
  check('전류가 해석해와 일치', near(id, iRef, iRef * 1e-3), `${(id * 1e3).toFixed(4)} mA (이론 ${(iRef * 1e3).toFixed(4)})`);
}

function bjtBiasTest() {
  console.log('NPN 공통 이미터 바이어스');
  // 5 V through 100k into the base, 1k collector load, emitter grounded.
  const sch: Schematic = {
    comps: [
      { id: 'v', type: 'battery', x: 2, y: 6, rot: 1, name: 'V1', params: { dc: 5 } },
      { id: 'rb', type: 'resistor', x: 6, y: 4, rot: 0, name: 'R1', params: { r: 100000 } },
      { id: 'rc', type: 'resistor', x: 11, y: 1, rot: 1, name: 'R2', params: { r: 1000 } },
      { id: 'q', type: 'npn', x: 10, y: 4, rot: 0, name: 'Q1', params: { bf: 100, is: 1e-15, br: 1 } },
      { id: 'g', type: 'ground', x: 6, y: 9, rot: 0, name: '', params: {} },
    ],
    wires: [
      { id: 'w1', x1: 2, y1: 5, x2: 2, y2: 0 }, { id: 'w2', x1: 2, y1: 0, x2: 11, y2: 0 },
      { id: 'w3', x1: 5, y1: 4, x2: 2, y2: 4 },
      { id: 'w4', x1: 7, y1: 4, x2: 9, y2: 4 },
      { id: 'w5', x1: 11, y1: 2, x2: 11, y2: 3 },
      { id: 'w6', x1: 11, y1: 5, x2: 11, y2: 9 },
      { id: 'w7', x1: 2, y1: 7, x2: 2, y2: 9 }, { id: 'w8', x1: 2, y1: 9, x2: 11, y2: 9 },
    ],
  };
  const r = prepare(sch);
  r.run(1e-3, 1e-5);
  const q = r.sim.devices.find((d) => d.id === 'q')!;
  const ib = q.st[3];
  const ic = q.st[2];
  const vbe = r.vAt(9, 4);
  const vce = r.vAt(11, 3);
  check('Vbe ~ 0.7 V', vbe > 0.6 && vbe < 0.8, `${vbe.toFixed(4)} V`);
  check('Ib ~ (5-Vbe)/100k', near(ib, (5 - vbe) / 1e5, 1e-8), `${(ib * 1e6).toFixed(3)} uA`);
  check('Ic ~ beta x Ib', near(ic, 100 * ib, 100 * ib * 0.05), `${(ic * 1e3).toFixed(4)} mA (beta*Ib ${(100 * ib * 1e3).toFixed(4)})`);
  check('부하선 Vce = 5 - Ic x 1k', near(vce, 5 - ic * 1000, 5e-3), `Vce=${vce.toFixed(4)} V`);
}

function opampTest() {
  console.log('연산증폭기 비반전 증폭기 (이득 11)');
  const sch = EXAMPLES.find((e) => e.id === 'noninv-amp')!.build();
  // Freeze the source at a DC level so the gain is easy to read off.
  const src = sch.comps.find((c) => c.type === 'vsine')!;
  src.params.freq = 0;
  src.params.amp = 0;
  src.params.offset = 0.2;
  src.params.wave = 1;
  const r = prepare(sch);
  r.run(2e-3, 1e-6);
  const vin = r.vAt(3, 7);
  const vout = r.vAt(15, 8);
  check('입력 = 0.2 V', near(vin, 0.2, 1e-4), `${vin.toFixed(5)} V`);
  check('출력 = 11 x 입력', near(vout, 2.2, 5e-3), `${vout.toFixed(5)} V (이론 2.2)`);
}

function rlcTest() {
  console.log('직렬 RLC 링잉 주파수');
  const sch = EXAMPLES.find((e) => e.id === 'rlc')!.build();
  const r = prepare(sch);
  const dt = 2e-7;
  // The pulse starts high at t = 0, so the ringing sits right at the origin.
  // Count upward crossings of the 5 V settling value while it is still alive.
  let last = r.vAt(18, 4) - 5;
  let crossings = 0;
  let firstT = 0;
  let lastT = 0;
  r.run(2.5e-3, dt, () => {
    const v = r.vAt(18, 4) - 5;
    if (last < 0 && v >= 0) {
      crossings++;
      if (crossings === 1) firstT = r.sim.t; else lastT = r.sim.t;
    }
    last = v;
  });
  const fMeas = crossings > 1 ? (crossings - 1) / (lastT - firstT) : 0;
  const fTheory = 1 / (2 * Math.PI * Math.sqrt(1e-2 * 1e-6));
  check('링잉이 보인다', crossings >= 3, `교차 ${crossings}회`);
  check('공진 주파수 ~1.59 kHz', near(fMeas, fTheory, fTheory * 0.06),
    `${fMeas.toFixed(1)} Hz (이론 ${fTheory.toFixed(1)} Hz)`);
}

function rectifierTest() {
  console.log('반파 정류 회로');
  const sch = EXAMPLES.find((e) => e.id === 'rectifier')!.build();
  const r = prepare(sch);
  r.run(0.15, 2e-6);
  let min = Infinity, max = -Infinity;
  r.run(1 / 60, 2e-6, () => {
    const v = r.vAt(17, 4);
    min = Math.min(min, v); max = Math.max(max, v);
  });
  // Ripple of a capacitor-input filter: dV = I T / C, with I = Vout / Rload.
  const ripple = max - min;
  const expected = (max / 1000) * (1 / 60) / 1e-4;
  check('출력이 10 V 근처로 유지', max > 8.8 && max < 10.1, `최대 ${max.toFixed(3)} V`);
  check('리플 = I T / C', near(ripple, expected, expected * 0.25),
    `${ripple.toFixed(3)} V (이론 ${expected.toFixed(3)} V)`);
}

function blinkerTest() {
  console.log('비안정 멀티바이브레이터');
  const sch = EXAMPLES.find((e) => e.id === 'led-blinker')!.build();
  const r = prepare(sch);
  const dt = 2e-5;
  r.run(0.5, dt);
  let high = 0, low = 0, edges = 0, prev = r.vAt(9, 9) > 2.5;
  let firstEdge = 0, lastEdge = 0;
  r.run(5.0, dt, () => {
    const v = r.vAt(9, 9);
    if (v > 2.5) high++; else low++;
    const now = v > 2.5;
    if (now !== prev) {
      edges++;
      if (edges === 1) firstEdge = r.sim.t; else lastEdge = r.sim.t;
      prev = now;
    }
  });
  const period = edges > 2 ? (2 * (lastEdge - firstEdge)) / (edges - 1) : 0;
  check('발진한다 (엣지 >= 4)', edges >= 4, `엣지 ${edges}회`);
  check('주기 0.3~1.5 s', period > 0.3 && period < 1.5, `${period.toFixed(3)} s`);
  check('양쪽 상태를 모두 지난다', high > 0 && low > 0, `high ${high}, low ${low} 스텝`);
  const nc = r.sim.nonConverged;
  // A latching multivibrator has instants no step size resolves exactly; the
  // solver commits its closest iterate there. Those must stay a rounding error.
  const total = 5.5 / dt;
  check('비수렴 스텝이 드물다 (<1%)', nc < total * 0.01,
    `${nc}회 / ${total.toFixed(0)}스텝 (${(100 * nc / total).toFixed(2)}%)`);
}

function rcFilterGainTest() {
  console.log('RC 저역통과 이득');
  const sch = EXAMPLES.find((e) => e.id === 'rc-lowpass')!.build();
  const r = prepare(sch);
  const dt = 5e-8;
  r.run(0.01, dt);
  let vmax = -Infinity, vmin = Infinity;
  r.run(3e-3, dt, () => {
    const v = r.vAt(14, 4);
    vmax = Math.max(vmax, v); vmin = Math.min(vmin, v);
  });
  const amp = (vmax - vmin) / 2;
  const fc = 1 / (2 * Math.PI * 1000 * 1e-7);
  const theory = 5 / Math.sqrt(1 + (1000 / fc) ** 2);
  check('출력 진폭이 1차 저역통과와 일치', near(amp, theory, theory * 0.02),
    `${amp.toFixed(4)} V (이론 ${theory.toFixed(4)} V, fc=${fc.toFixed(0)} Hz)`);
}

function commonEmitterTest() {
  console.log('이미터 접지 증폭기');
  const sch = EXAMPLES.find((e) => e.id === 'common-emitter')!.build();
  const r = prepare(sch);
  const dt = 5e-7;
  r.run(0.05, dt);
  let vmax = -Infinity, vmin = Infinity;
  r.run(2e-3, dt, () => {
    const v = r.vAt(14, 8);
    vmax = Math.max(vmax, v); vmin = Math.min(vmin, v);
  });
  const vc = (vmax + vmin) / 2;
  const gain = (vmax - vmin) / 2 / 0.05;
  // Rc/Re sets the gain to roughly 2200/470 = 4.7 once Re is included.
  check('컬렉터 동작점이 레일 사이', vc > 2 && vc < 10, `${vc.toFixed(3)} V`);
  check('이득 3~7배 (Rc/Re = 4.7)', gain > 3 && gain < 7, `${gain.toFixed(2)} 배`);
}

console.log('== 회로 엔진 검증 ==\n');
function dcOperatingPointTest() {
  console.log('DC 동작점 해석');
  const sch = EXAMPLES.find((e) => e.id === 'common-emitter')!.build();
  const r = prepare(sch);
  const ok = r.sim.solveDC();
  const vb = r.vAt(12, 9);
  const vc = r.vAt(14, 8);
  const ve = r.vAt(14, 10);
  check('수렴했다', ok, `t=${r.sim.t}`);
  check('분압 바이어스 Vb ~ 1.8 V', near(vb, 1.8, 0.15), `${vb.toFixed(4)} V`);
  check('Ve = Vb - 0.7', near(ve, vb - 0.7, 0.08), `${ve.toFixed(4)} V`);
  check('컬렉터가 레일 사이', vc > 4 && vc < 10, `${vc.toFixed(4)} V`);
  // The same point must be what the transient settles to on its own.
  const r2 = prepare(sch);
  r2.run(0.08, 5e-7);
  check('과도해석 정상상태와 일치', near(r2.vAt(14, 8), vc, 0.15),
    `${r2.vAt(14, 8).toFixed(4)} V vs DC ${vc.toFixed(4)} V`);
}

dividerTest();
meterTest();
dragTest();
rotateTest();
rcStepTest();
diodeTest();
bjtBiasTest();
opampTest();
rlcTest();
rectifierTest();
rcFilterGainTest();
commonEmitterTest();
blinkerTest();
dcOperatingPointTest();
console.log(`\n${failures === 0 ? '모두 통과' : `${failures}건 실패`}`);
process.exit(failures === 0 ? 0 : 1);
