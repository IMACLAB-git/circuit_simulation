import { Simulator } from '../engine/simulator';
import { buildNetlist, engineParams, key, type Netlist, type Schematic } from '../model/schematic';
import { COMPONENTS } from '../model/components';

export interface Probe {
  id: string;
  /** 'v' probes a net voltage, 'i' probes a component's branch current. */
  kind: 'v' | 'i';
  /** Grid point key for 'v', component id for 'i'. */
  target: string;
  label: string;
}

const SCOPE_LEN = 1024;

/** Solver time allowed per animation frame, leaving the rest for painting. */
const FRAME_BUDGET_MS = 8;

/**
 * Animation dot speed in dot-spacings per second, for a branch current.
 *
 * Logarithmic, so a 1 uA bias current and a 1 A supply current are both
 * legible, but with enough slope left that the eye can still tell them apart —
 * a flat compression makes every wire look identically busy.
 */
export function flowRate(i: number): number {
  const a = Math.abs(i);
  if (a < 1e-9) return 0;
  return Math.sign(i) * Math.min(4.5, 0.25 + 0.45 * Math.log10(a / 1e-9));
}

/**
 * Drives the solver in real time and derives everything the canvas draws:
 * per-wire current, animation phases and the oscilloscope ring buffers.
 */
export class SimRunner {
  sim = new Simulator();
  net: Netlist | null = null;
  sch: Schematic = { comps: [], wires: [] };

  running = false;
  /** Simulated seconds per wall-clock second. */
  timeScale = 1;
  /** Fixed integration step, chosen from the circuit unless overridden. */
  dt = 1e-5;
  autoStep = true;
  maxStepsPerFrame = 6000;
  /** Steps actually executed in the last frame, for the status bar. */
  lastSteps = 0;
  error: string | null = null;

  wireCur = new Float64Array(0);
  wirePhase = new Float64Array(0);
  private acc = new Float64Array(0);
  /** Per component, one animation phase per pin (pin -> body direction). */
  pinPhase = new Map<string, Float64Array>();

  probes: Probe[] = [];
  scopeT = new Float32Array(SCOPE_LEN);
  scopeV: Float32Array[] = [];
  scopeCount = 0;
  scopeHead = 0;
  /** Oscilloscope window in simulated seconds. */
  timebase = 0.02;
  private nextSample = 0;

  rebuild(sch: Schematic): void {
    this.sch = sch;
    const net = buildNetlist(sch);
    this.net = net;
    this.sim.build(net.devices, net.nNodes);
    this.wireCur = new Float64Array(net.nWires);
    this.wirePhase = new Float64Array(net.nWires);
    this.acc = new Float64Array(net.nPoints);
    this.error = null;
    if (this.autoStep) this.dt = this.pickStep();
    this.allocScope();
  }

  /** Re-reads component parameters without disturbing the solver state. */
  syncParams(): void {
    const net = this.net;
    if (!net) return;
    for (const c of this.sch.comps) {
      const d = net.deviceOf.get(c.id);
      if (d) Object.assign(d.p, engineParams(c));
    }
    if (this.autoStep) {
      const s = this.pickStep();
      if (s !== this.dt) this.dt = s;
    }
    this.sim.invalidate();
    this.error = null;
  }

  /** Jumps to the steady state instead of watching it charge up. */
  operatingPoint(): void {
    this.sim.solveDC();
    this.wireCur.fill(0);
    this.wirePhase.fill(0);
    this.pinPhase.clear();
    this.scopeCount = 0;
    this.scopeHead = 0;
    this.nextSample = 0;
    this.error = null;
    this.distributeWireCurrents();
  }

  reset(): void {
    this.sim.reset();
    this.wireCur.fill(0);
    this.wirePhase.fill(0);
    this.pinPhase.clear();
    this.scopeCount = 0;
    this.scopeHead = 0;
    this.nextSample = 0;
    this.error = null;
  }

  /**
   * Picks an integration step from the circuit's own time scales: fast enough
   * to resolve the highest source frequency and the smallest RC / L-R corner.
   */
  private pickStep(): number {
    let fmax = 0;
    let tauMin = Infinity;
    for (const c of this.sch.comps) {
      const p = c.params;
      if (c.type === 'vsine' || c.type === 'vpulse') fmax = Math.max(fmax, p.freq);
      if (c.type === 'capacitor') tauMin = Math.min(tauMin, Math.max(p.c, 1e-15) * 50);
      if (c.type === 'inductor') tauMin = Math.min(tauMin, Math.max(p.l, 1e-12) / 50);
    }
    let dt = 1e-5;
    if (fmax > 0) dt = Math.min(dt, 1 / (200 * fmax));
    if (isFinite(tauMin)) dt = Math.min(dt, Math.max(tauMin / 20, 1e-9));
    return Math.max(1e-10, Math.min(dt, 1e-3));
  }

  /** A time scale that shows roughly 20 source periods per wall second. */
  suggestTimeScale(): number {
    let fmax = 0;
    for (const c of this.sch.comps) {
      if (c.type === 'vsine' || c.type === 'vpulse') fmax = Math.max(fmax, c.params.freq);
    }
    if (fmax <= 0) return 1;
    return Math.max(1e-7, Math.min(1, 20 / fmax));
  }

  addProbe(kind: 'v' | 'i', target: string, label: string): void {
    const id = `${kind}:${target}`;
    const at = this.probes.findIndex((p) => p.id === id);
    if (at >= 0) { this.probes.splice(at, 1); }
    else {
      if (this.probes.length >= 8) this.probes.shift();
      // Trace colours come from the theme, by position, at draw time.
      this.probes.push({ id, kind, target, label });
    }
    this.allocScope();
  }

  clearProbes(): void {
    this.probes = [];
    this.allocScope();
  }

  private allocScope(): void {
    this.scopeV = this.probes.map(() => new Float32Array(SCOPE_LEN));
    this.scopeCount = 0;
    this.scopeHead = 0;
    this.nextSample = this.sim.t;
  }

  private probeValue(p: Probe): number {
    const net = this.net;
    if (!net) return 0;
    if (p.kind === 'v') {
      const pi = net.pointIndex.get(p.target);
      if (pi === undefined) return 0;
      return this.sim.nodeVoltage(net.pointNode[pi]);
    }
    const d = net.deviceOf.get(p.target);
    return d ? d.cur : 0;
  }

  private sample(): void {
    if (this.probes.length === 0) return;
    const interval = this.timebase / SCOPE_LEN;
    if (this.sim.t < this.nextSample) return;
    this.nextSample = this.sim.t + interval;
    const h = this.scopeHead;
    this.scopeT[h] = this.sim.t;
    for (let i = 0; i < this.probes.length; i++) {
      this.scopeV[i][h] = this.probeValue(this.probes[i]);
    }
    this.scopeHead = (h + 1) % SCOPE_LEN;
    if (this.scopeCount < SCOPE_LEN) this.scopeCount++;
  }

  /**
   * Distributes device pin currents onto wire segments.
   *
   * Each net's wire graph is a spanning tree; walking it leaf-to-root, the
   * current on the edge above a sub-tree is exactly minus the current injected
   * into that sub-tree. Edges outside the tree (parallel wires forming a loop)
   * carry no drawn current, which is only a cosmetic approximation.
   */
  private distributeWireCurrents(): void {
    const net = this.net;
    if (!net) return;
    const acc = this.acc;
    acc.fill(0);
    for (const c of this.sch.comps) {
      const d = net.deviceOf.get(c.id);
      if (!d) continue;
      const pts = net.pinPoints.get(c.id)!;
      for (let i = 0; i < pts.length; i++) acc[pts[i]] += d.pinCur[i];
    }
    this.wireCur.fill(0);
    const { order, parent, parentWire, parentDir } = net;
    for (let i = net.nPoints - 1; i >= 0; i--) {
      const p = order[i];
      const par = parent[p];
      if (par < 0) continue;
      this.wireCur[parentWire[p]] = -acc[p] * parentDir[p];
      acc[par] += acc[p];
    }
  }

  /**
   * Advances animation phases. Dot speed is log-compressed over ~6 decades so
   * that a 1 µA bias current and a 1 A supply current are both legible.
   */
  private advancePhases(realDt: number): void {
    for (let w = 0; w < this.wireCur.length; w++) {
      this.wirePhase[w] = (this.wirePhase[w] + flowRate(this.wireCur[w]) * realDt) % 1;
    }
    const net = this.net;
    if (!net) return;
    for (const c of this.sch.comps) {
      const d = net.deviceOf.get(c.id);
      if (!d) continue;
      let ph = this.pinPhase.get(c.id);
      if (!ph || ph.length !== d.pinCur.length) {
        ph = new Float64Array(d.pinCur.length);
        this.pinPhase.set(c.id, ph);
      }
      // Each lead is drawn from its pin towards the body, so the flow along it
      // is the current entering the device at that pin.
      for (let i = 0; i < ph.length; i++) {
        ph[i] = (ph[i] + flowRate(-d.pinCur[i]) * realDt) % 1;
      }
    }
  }

  /** Advances the simulation by one animation frame of `realDt` seconds. */
  tick(realDt: number): void {
    if (!this.net) return;
    if (this.running && !this.error) {
      const target = Math.min(realDt, 0.05) * this.timeScale;
      const steps = Math.min(Math.ceil(target / this.dt), this.maxStepsPerFrame);
      // A step count alone is no budget: one hard switching instant can cost
      // more than a thousand easy steps. Stop on wall-clock time as well, so
      // no circuit can freeze the page; the simulation just falls a little
      // behind real time for that frame.
      const deadline = performance.now() + FRAME_BUDGET_MS;
      let done = 0;
      for (let i = 0; i < steps; i++) {
        if (i > 0 && performance.now() > deadline) break;
        if (!this.sim.step(this.dt)) {
          this.error = this.sim.n === 0
            ? null
            : '해를 구하지 못했습니다 — 회로가 끊겼거나 수렴하지 않습니다.';
          break;
        }
        this.sample();
        done = i + 1;
      }
      this.lastSteps = done;
      this.distributeWireCurrents();
    }
    this.advancePhases(realDt);
  }

  /** Node voltage at a grid point, for wire colouring. */
  voltageAt(x: number, y: number): number {
    const net = this.net;
    if (!net) return 0;
    const pi = net.pointIndex.get(key(x, y));
    if (pi === undefined) return 0;
    return this.sim.nodeVoltage(net.pointNode[pi]);
  }

  /** Largest node voltage magnitude, used to auto-scale the voltage colours. */
  voltageSpan(): number {
    let m = 0.5;
    const x = this.sim.x;
    for (let i = 0; i < this.sim.nNodes; i++) m = Math.max(m, Math.abs(x[i]));
    return m;
  }

  /** LED drive level in 0..1, from the device current against its rating. */
  ledBrightness(compId: string): number {
    const d = this.net?.deviceOf.get(compId);
    if (!d) return 0;
    const c = this.sch.comps.find((k) => k.id === compId);
    const rated = c?.params.irated ?? 0.02;
    return Math.max(0, Math.min(1, d.cur / rated));
  }

  labelFor(compId: string): string {
    const c = this.sch.comps.find((k) => k.id === compId);
    return c ? c.name : compId;
  }

  designator(type: keyof typeof COMPONENTS): string {
    return COMPONENTS[type].desig;
  }
}
