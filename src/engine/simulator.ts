import { LU } from './linalg';

/**
 * Transient circuit solver.
 *
 * Formulation: Modified Nodal Analysis. The unknown vector is
 *   x = [ v_1 .. v_N , i_1 .. i_M ]
 * where v are node voltages (ground is excluded and carries node index -1) and
 * i are the branch currents of devices that need one: voltage sources,
 * inductors and op-amp outputs.
 *
 * Time integration uses backward Euler companion models. BE is only first
 * order, but it is unconditionally stable and never rings on an LC tank, which
 * matters far more than accuracy for an interactive animated simulator.
 *
 * Nonlinear devices (diodes, BJTs, MOSFETs) are solved by Newton-Raphson with
 * the usual SPICE junction limiting to stop exp() from overflowing.
 */

export type DeviceType =
  | 'resistor' | 'capacitor' | 'inductor' | 'vsource' | 'isource'
  | 'diode' | 'led' | 'switch' | 'npn' | 'pnp' | 'nmos' | 'pmos' | 'opamp';

export interface Device {
  id: string;
  type: DeviceType;
  /** Node indices; -1 means ground. Pin order is device specific. */
  nodes: number[];
  p: Record<string, number>;
  /** Index of this device's first extra unknown, or -1. */
  extra: number;
  /** Branch current pin0 -> pin1, refreshed after every accepted step. */
  cur: number;
  /** Voltage across pin0 - pin1, or a device specific equivalent. */
  volt: number;
  /**
   * Current flowing OUT of each pin into the surrounding net. Sums to zero by
   * KCL; the schematic layer uses it to distribute current onto wires.
   */
  pinCur: Float64Array;
  /** Scratch state: previous junction voltages, terminal currents. */
  st: Float64Array;
}

export const VT = 0.025852; // kT/q at 300 K
const GMIN = 1e-12;
const RELTOL = 1e-3;
const VNTOL = 1e-6;
const ABSTOL = 1e-9;
/** Absolute convergence floor, as a fraction of the circuit's own span. */
const SPANTOL = 2e-4;

/**
 * Default junction capacitances, in farads.
 *
 * These are not decoration. Without them a transistor switches infinitely
 * fast: the junction voltage may jump arbitrarily between two time points, so
 * no step size puts Newton near the answer and a multivibrator's latching
 * instant never converges. Real devices have picofarads here, and adding them
 * both fixes the solve and makes the switching edge physical.
 */
const CJE = 10e-12; // bipolar base-emitter
const CJC = 5e-12;  // bipolar base-collector
const CGS = 20e-12; // MOS gate-source
const CGD = 5e-12;  // MOS gate-drain
const CJD = 5e-12;  // diode / LED junction
/**
 * Newton iterations per attempt, kept short on purpose as in SPICE's ITL4. An
 * attempt still unconverged after a few dozen passes is stuck rather than slow,
 * and cutting the step gets there far sooner than grinding on.
 */
const MAX_ITER = 30;
/** Newton iterations run undamped before under-relaxation kicks in. */
const DAMP_AFTER = 10;
const DAMP_HARD = 20;
/** How many times a failing step may be quartered before giving up. */
const MAX_SUBDIVIDE = 5;

export function makeDevice(
  id: string,
  type: DeviceType,
  nodes: number[],
  p: Record<string, number>,
): Device {
  return {
    id, type, nodes, p, extra: -1, cur: 0, volt: 0,
    pinCur: new Float64Array(nodes.length),
    st: new Float64Array(4),
  };
}

/** Number of extra (branch-current) unknowns a device contributes. */
function extraCount(type: DeviceType): number {
  switch (type) {
    case 'vsource': case 'inductor': case 'opamp': return 1;
    default: return 0;
  }
}

function isNonlinear(type: DeviceType): boolean {
  switch (type) {
    case 'diode': case 'led': case 'npn': case 'pnp':
    case 'nmos': case 'pmos': case 'opamp': return true;
    default: return false;
  }
}

/**
 * SPICE3 pn-junction limiting: damps a Newton step across an exponential.
 *
 * The reverse branch doubles its clamp each pass (2*vold - 1) rather than
 * holding at a constant. That matters: the caller treats "was limited" as
 * "not converged", so a fixed clamp would leave a deeply reverse-biased diode
 * limited forever and the step would never converge.
 */
function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      // |vnew - vold| > 2 vt here, so |arg| > 2 and both logs stay real.
      const arg = (vnew - vold) / vt;
      vnew = arg > 0
        ? vold + vt * (2 + Math.log(arg - 2))
        : vold - vt * (2 + Math.log(2 - arg));
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
  } else if (vnew < 0) {
    const lim = vold > 0 ? -vold - 1 : 2 * vold - 1;
    if (vnew < lim) vnew = lim;
  }
  return vnew;
}

/** Limits a MOS gate-overdrive step; mirrors SPICE fetlim(). */
function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = Math.max(vtsthi / 2, 2);
  if (vold >= vto) {
    if (vnew <= vold - vtstlo) vnew = vold - vtstlo;
    else if (vnew >= vold + vtsthi) vnew = vold + vtsthi;
  } else {
    if (vnew >= vto + 2) vnew = vto + 2;
    else if (vnew <= vold - vtstlo) vnew = vold - vtstlo;
  }
  return vnew;
}

export class Simulator {
  devices: Device[] = [];
  nNodes = 0;
  nExtra = 0;
  n = 0;
  t = 0;
  h = 2e-5;

  A = new Float64Array(0);
  z = new Float64Array(0);
  x = new Float64Array(0);
  xNew = new Float64Array(0);
  xPrev = new Float64Array(0);
  private xSave = new Float64Array(0);
  private stSave = new Float64Array(0);
  private xBest = new Float64Array(0);

  iterations = 0;
  failed = false;
  /** Steps that had to fall back to the best available iterate. */
  nonConverged = 0;

  private lu = new LU(0);
  private linear = true;
  private factored = false;
  private lastH = 0;
  /**
   * Set whenever a device clamped its own junction voltage during the last
   * stamp. A limited iterate can leave the node voltages almost unchanged even
   * though the device is still nowhere near its operating point, so Newton must
   * not be allowed to declare convergence on that pass.
   */
  private limited = false;

  build(devices: Device[], nNodes: number): void {
    this.devices = devices;
    this.nNodes = nNodes;
    let e = 0;
    this.linear = true;
    for (const d of devices) {
      const k = extraCount(d.type);
      d.extra = k > 0 ? nNodes + e : -1;
      e += k;
      if (isNonlinear(d.type)) this.linear = false;
    }
    this.nExtra = e;
    this.n = nNodes + e;
    const n = this.n;
    this.A = new Float64Array(n * n);
    this.z = new Float64Array(n);
    this.x = new Float64Array(n);
    this.xNew = new Float64Array(n);
    this.xPrev = new Float64Array(n);
    this.xSave = new Float64Array(n);
    this.xBest = new Float64Array(n);
    this.stSave = new Float64Array(devices.length * 4);
    this.lu = new LU(n);
    this.reset();
  }

  reset(): void {
    this.x.fill(0);
    this.xPrev.fill(0);
    this.xNew.fill(0);
    this.t = 0;
    this.factored = false;
    this.failed = false;
    this.nonConverged = 0;
    for (const d of this.devices) { d.cur = 0; d.volt = 0; d.st.fill(0); d.pinCur.fill(0); }
  }

  /** Marks the factorisation stale; call after any parameter edit. */
  invalidate(): void { this.factored = false; this.failed = false; }

  nodeVoltage(i: number): number { return i < 0 ? 0 : this.x[i]; }

  private v(i: number): number { return i < 0 ? 0 : this.x[i]; }
  private vPrev(i: number): number { return i < 0 ? 0 : this.xPrev[i]; }

  private g(i: number, j: number, val: number): void {
    if (i < 0 || j < 0) return;
    this.A[i * this.n + j] += val;
  }

  private rhs(i: number, val: number): void {
    if (i < 0) return;
    this.z[i] += val;
  }

  /** Two-terminal conductance stamp. */
  private stampG(a: number, b: number, g: number): void {
    this.g(a, a, g); this.g(b, b, g);
    this.g(a, b, -g); this.g(b, a, -g);
  }

  /** Backward-Euler companion stamp for a capacitor between nodes a and b. */
  private stampCap(a: number, b: number, c: number): void {
    const geq = c / this.h;
    const vp = this.vPrev(a) - this.vPrev(b);
    this.stampG(a, b, geq);
    this.stampI(b, a, geq * vp);
  }

  /** Current source drawing `i` amps out of node a and into node b. */
  private stampI(a: number, b: number, i: number): void {
    this.rhs(a, -i); this.rhs(b, i);
  }

  /**
   * Generic nonlinear multi-terminal stamp.
   *
   * `cur[k]` is the current flowing INTO terminal k and `jac[k][m]` is
   * d cur[k] / d v[m], both evaluated at `vs`. When junction limiting has
   * moved the operating point, `vs` must be the *limited* terminal voltages,
   * not the raw ones from the solution vector — otherwise the equivalent
   * current is computed at a different point than the model was, and Newton
   * chases a solution that does not exist.
   */
  private stampNL(nds: number[], vs: number[], cur: number[], jac: number[][]): void {
    const K = nds.length;
    for (let k = 0; k < K; k++) {
      let ieq = cur[k];
      for (let m = 0; m < K; m++) {
        this.g(nds[k], nds[m], jac[k][m]);
        ieq -= jac[k][m] * vs[m];
      }
      this.rhs(nds[k], -ieq);
    }
  }

  /** Value of a time dependent source at time `t`. */
  private sourceValue(d: Device, t: number): number {
    const p = d.p;
    switch (p.wave | 0) {
      case 1: { // sine
        return p.offset + p.amp * Math.sin(2 * Math.PI * p.freq * t + (p.phase * Math.PI) / 180);
      }
      case 2: { // square / pulse
        if (!(p.freq > 0)) return p.vhigh;
        const ph = ((t * p.freq) % 1 + 1) % 1;
        return ph < p.duty ? p.vhigh : p.vlow;
      }
      case 3: { // triangle
        if (!(p.freq > 0)) return p.offset;
        const ph = ((t * p.freq) % 1 + 1) % 1;
        const tri = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
        return p.offset + p.amp * tri;
      }
      default:
        return p.dc;
    }
  }

  /** pnjlim, recording whether the value was actually clamped. */
  private lim(vnew: number, vold: number, vt: number, vcrit: number): number {
    const v = pnjlim(vnew, vold, vt, vcrit);
    if (v !== vnew) this.limited = true;
    return v;
  }

  /** fetlim, recording whether the value was actually clamped. */
  private limFet(vnew: number, vold: number, vto: number): number {
    const v = fetlim(vnew, vold, vto);
    if (v !== vnew) this.limited = true;
    return v;
  }

  private stampAll(tNext: number): void {
    const n = this.n;
    this.limited = false;
    this.A.fill(0);
    this.z.fill(0);
    // Leak every node to ground so floating sub-circuits stay solvable.
    for (let i = 0; i < this.nNodes; i++) this.A[i * n + i] += GMIN;
    for (const d of this.devices) this.stamp(d, tNext);
  }

  private stamp(d: Device, t: number): void {
    const p = d.p;
    const nd = d.nodes;
    switch (d.type) {
      case 'resistor': {
        this.stampG(nd[0], nd[1], 1 / Math.max(p.r, 1e-6));
        break;
      }
      case 'switch': {
        this.stampG(nd[0], nd[1], p.closed > 0.5 ? 1e2 : 1e-9);
        break;
      }
      case 'capacitor': {
        const geq = Math.max(p.c, 1e-18) / this.h;
        const vp = this.vPrev(nd[0]) - this.vPrev(nd[1]);
        this.stampG(nd[0], nd[1], geq);
        this.stampI(nd[1], nd[0], geq * vp);
        break;
      }
      case 'inductor': {
        const k = d.extra;
        const l = Math.max(p.l, 1e-12);
        this.g(nd[0], k, 1); this.g(nd[1], k, -1);
        this.g(k, nd[0], 1); this.g(k, nd[1], -1);
        this.A[k * this.n + k] -= l / this.h;
        this.z[k] -= (l / this.h) * this.xPrev[k];
        break;
      }
      case 'vsource': {
        const k = d.extra;
        this.g(nd[0], k, 1); this.g(nd[1], k, -1);
        this.g(k, nd[0], 1); this.g(k, nd[1], -1);
        this.z[k] += this.sourceValue(d, t);
        break;
      }
      case 'isource': {
        this.stampI(nd[0], nd[1], this.sourceValue(d, t));
        break;
      }
      case 'diode': case 'led': {
        const vt = p.n * VT;
        const vcrit = vt * Math.log(vt / (Math.SQRT2 * p.is));
        let vd = this.v(nd[0]) - this.v(nd[1]);
        vd = this.lim(vd, d.st[0], vt, vcrit);
        d.st[0] = vd;
        const ex = Math.exp(Math.min(vd / vt, 80));
        const id = p.is * (ex - 1);
        const gd = (p.is / vt) * ex + GMIN;
        this.stampG(nd[0], nd[1], gd);
        this.stampI(nd[0], nd[1], id - gd * vd);
        this.stampCap(nd[0], nd[1], p.cj ?? CJD);
        break;
      }
      case 'npn': case 'pnp': {
        // Ebers-Moll transport model. Pin order: [base, collector, emitter].
        const s = d.type === 'npn' ? 1 : -1;
        const { is, bf, br } = p;
        const vcrit = VT * Math.log(VT / (Math.SQRT2 * is));
        const vb = this.v(nd[0]), vc = this.v(nd[1]), ve = this.v(nd[2]);
        const vbe = this.lim(s * (vb - ve), d.st[0], VT, vcrit);
        const vbc = this.lim(s * (vb - vc), d.st[1], VT, vcrit);
        d.st[0] = vbe; d.st[1] = vbc;

        const efe = Math.exp(Math.min(vbe / VT, 80));
        const efc = Math.exp(Math.min(vbc / VT, 80));
        const If = is * (efe - 1), Ir = is * (efc - 1);
        const gif = (is / VT) * efe + GMIN;
        const gir = (is / VT) * efc + GMIN;

        const ib = If / bf + Ir / br;
        const ic = If - Ir * (1 + 1 / br);

        // d/dVbe and d/dVbc of the terminal currents.
        const dIb_be = gif / bf, dIb_bc = gir / br;
        const dIc_be = gif, dIc_bc = -gir * (1 + 1 / br);

        // Chain rule to node voltages. Both the current and the voltage carry
        // the polarity factor s, so s*s = 1 drops out of the Jacobian.
        const jb = [dIb_be + dIb_bc, -dIb_bc, -dIb_be];
        const jc = [dIc_be + dIc_bc, -dIc_bc, -dIc_be];
        const je = [-(jb[0] + jc[0]), -(jb[1] + jc[1]), -(jb[2] + jc[2])];

        // Linearisation point expressed in node voltages that reproduce the
        // limited junction voltages. Every Jacobian row sums to zero, so the
        // arbitrary common offset (emitter at 0) cancels out.
        const cur = [s * ib, s * ic, -s * (ib + ic)];
        this.stampNL(nd, [s * vbe, s * (vbe - vbc), 0], cur, [jb, jc, je]);
        this.stampCap(nd[0], nd[2], p.cje ?? CJE);
        this.stampCap(nd[0], nd[1], p.cjc ?? CJC);
        d.st[2] = s * ic;
        d.st[3] = s * ib;
        break;
      }
      case 'nmos': case 'pmos': {
        // Shichman-Hodges level 1. Pin order: [gate, drain, source].
        const s = d.type === 'nmos' ? 1 : -1;
        const { k: beta, vth: vto, lambda } = p;
        const vg = this.v(nd[0]), vdn = this.v(nd[1]), vsn = this.v(nd[2]);
        const vgs = this.limFet(s * (vg - vsn), d.st[0], vto);
        const vds = s * (vdn - vsn);
        d.st[0] = vgs;

        // The device is symmetric: evaluate with drain and source swapped when
        // vds is negative, then flip the resulting current back.
        const rev = vds < 0;
        const vgsE = rev ? vgs - vds : vgs;
        const vdsE = rev ? -vds : vds;
        const vgst = vgsE - vto;

        let id = 0, gm = 0, gds = 0;
        if (vgst > 0) {
          if (vdsE < vgst) {
            id = beta * (vgst * vdsE - 0.5 * vdsE * vdsE) * (1 + lambda * vdsE);
            gm = beta * vdsE * (1 + lambda * vdsE);
            gds = beta * (vgst - vdsE) * (1 + lambda * vdsE)
              + lambda * beta * (vgst * vdsE - 0.5 * vdsE * vdsE);
          } else {
            id = 0.5 * beta * vgst * vgst * (1 + lambda * vdsE);
            gm = beta * vgst * (1 + lambda * vdsE);
            gds = 0.5 * lambda * beta * vgst * vgst;
          }
        }
        gds += GMIN;

        // Drain current and its derivatives w.r.t. [vg, vd, vs].
        let iD: number, jg: number, jd: number, js: number;
        if (!rev) {
          iD = id;
          jg = gm; jd = gds; js = -(gm + gds);
        } else {
          iD = -id;
          jg = -gm; jd = gds; js = gm - gds;
        }
        const row = [jg, jd, js];
        const cur = [0, s * iD, -s * iD];
        // As with the BJT, linearise at the limited gate voltage.
        this.stampNL(nd, [s * vgs, s * vds, 0], cur, [
          [0, 0, 0],
          row,
          [-row[0], -row[1], -row[2]],
        ]);
        this.stampCap(nd[0], nd[2], p.cgs ?? CGS);
        this.stampCap(nd[0], nd[1], p.cgd ?? CGD);
        d.st[1] = s * iD;
        break;
      }
      case 'opamp': {
        // Pin order: [in+, in-, out]. The output is a voltage source whose
        // value soft-saturates at the rails; tanh keeps the transition
        // differentiable so Newton stays well behaved near clipping.
        const k = d.extra;
        const vd = this.v(nd[0]) - this.v(nd[1]);
        const u = (p.gain * vd) / p.vsat;
        const th = Math.tanh(Math.max(-40, Math.min(40, u)));
        const out = p.vsat * th;
        const dOut = p.gain * (1 - th * th) + 1e-9;

        this.g(nd[2], k, 1);
        this.g(k, nd[2], 1);
        this.g(k, nd[0], -dOut);
        this.g(k, nd[1], dOut);
        this.z[k] += out - dOut * vd;
        break;
      }
    }
  }

  /** Fast path for linear circuits: only the RHS changes between steps. */
  private stampRHSOnly(d: Device, t: number): void {
    const nd = d.nodes;
    switch (d.type) {
      case 'capacitor': {
        const geq = Math.max(d.p.c, 1e-18) / this.h;
        const vp = this.vPrev(nd[0]) - this.vPrev(nd[1]);
        this.stampI(nd[1], nd[0], geq * vp);
        break;
      }
      case 'inductor':
        this.z[d.extra] -= (Math.max(d.p.l, 1e-12) / this.h) * this.xPrev[d.extra];
        break;
      case 'vsource':
        this.z[d.extra] += this.sourceValue(d, t);
        break;
      case 'isource':
        this.stampI(nd[0], nd[1], this.sourceValue(d, t));
        break;
      default: break;
    }
  }

  /**
   * Post-solve bookkeeping.
   *
   * `cur` is uniformly the current flowing from pin 0 to pin 1 *through* the
   * device, so a discharging battery reads negative — inside a source the
   * current really does run from minus to plus. `pinCur` is the same quantity
   * redistributed as "current leaving each pin into the net".
   */
  private updateResults(): void {
    for (const d of this.devices) {
      const nd = d.nodes;
      const va = this.v(nd[0]);
      const vb = nd.length > 1 ? this.v(nd[1]) : 0;
      switch (d.type) {
        case 'resistor':
          d.volt = va - vb;
          d.cur = d.volt / Math.max(d.p.r, 1e-6);
          break;
        case 'switch':
          d.volt = va - vb;
          d.cur = d.volt * (d.p.closed > 0.5 ? 1e2 : 1e-9);
          break;
        case 'capacitor': {
          const vp = this.vPrev(nd[0]) - this.vPrev(nd[1]);
          d.volt = va - vb;
          d.cur = (Math.max(d.p.c, 1e-18) / this.h) * (d.volt - vp);
          break;
        }
        case 'inductor':
        case 'vsource':
          d.cur = this.x[d.extra];
          d.volt = va - vb;
          break;
        case 'isource':
          d.cur = this.sourceValue(d, this.t);
          d.volt = va - vb;
          break;
        case 'diode': case 'led': {
          const vt = d.p.n * VT;
          d.volt = va - vb;
          d.cur = d.p.is * (Math.exp(Math.min(d.volt / vt, 80)) - 1);
          break;
        }
        case 'npn': case 'pnp':
          d.cur = d.st[2];
          d.volt = this.v(nd[1]) - this.v(nd[2]);
          break;
        case 'nmos': case 'pmos':
          d.cur = d.st[1];
          d.volt = this.v(nd[1]) - this.v(nd[2]);
          break;
        case 'opamp':
          d.cur = -this.x[d.extra];
          d.volt = this.v(nd[2]);
          break;
      }

      const pc = d.pinCur;
      switch (d.type) {
        case 'npn': case 'pnp': {
          const ib = d.st[3], ic = d.st[2];
          pc[0] = -ib; pc[1] = -ic; pc[2] = ib + ic;
          break;
        }
        case 'nmos': case 'pmos':
          pc[0] = 0; pc[1] = -d.st[1]; pc[2] = d.st[1];
          break;
        case 'opamp':
          pc[0] = 0; pc[1] = 0; pc[2] = d.cur;
          break;
        default:
          pc[0] = -d.cur; pc[1] = d.cur;
          break;
      }
    }
  }

  /**
   * Newton convergence test on the solution increment.
   *
   * The absolute floor is scaled to the circuit rather than fixed. A node
   * sitting at 40 mV inside a 5 V circuit cannot be pinned to 1 uV: a saturated
   * transistor's residual bottoms out around 10 uA, and the inverse Jacobian
   * turns that into ~0.1 mV of unavoidable wobble. Demanding more than the
   * arithmetic can deliver would stall every switching circuit forever, so the
   * floor is 50 ppm of the circuit's own voltage (and current) span.
   */
  private checkConvergence(): boolean {
    let vSpan = 0;
    for (let i = 0; i < this.nNodes; i++) vSpan = Math.max(vSpan, Math.abs(this.xNew[i]));
    let iSpan = 0;
    for (let i = this.nNodes; i < this.n; i++) iSpan = Math.max(iSpan, Math.abs(this.xNew[i]));
    const vFloor = Math.max(VNTOL, SPANTOL * vSpan);
    const iFloor = Math.max(ABSTOL, SPANTOL * iSpan);

    for (let i = 0; i < this.nNodes; i++) {
      const a = this.x[i], b = this.xNew[i];
      if (Math.abs(a - b) > RELTOL * Math.max(Math.abs(a), Math.abs(b)) + vFloor) return false;
    }
    for (let i = this.nNodes; i < this.n; i++) {
      const a = this.x[i], b = this.xNew[i];
      if (Math.abs(a - b) > RELTOL * Math.max(Math.abs(a), Math.abs(b)) + iFloor) return false;
    }
    return true;
  }

  /**
   * Drives the circuit to its DC operating point.
   *
   * Pseudo-transient continuation: start from the zero state with a step so
   * short that every capacitor is effectively a short and every inductor an
   * open, then stretch the step geometrically. Each step is a small nudge from
   * the last, so Newton always has a good starting guess — far more robust than
   * cold-solving the DC equations, and it needs no extra machinery beyond the
   * transient stepper that already exists.
   */
  solveDC(): boolean {
    this.reset();
    let ok = true;
    let h = 1e-9;
    for (let i = 0; i < 140 && h < 1e7; i++, h *= 1.6) {
      if (!this.step(h)) ok = false;
    }
    this.t = 0;
    this.xPrev.set(this.x);
    this.nonConverged = 0;
    return ok;
  }

  /** Saves the state a failed step has to roll back to. */
  private snapshot(): void {
    this.xSave.set(this.x);
    for (let i = 0; i < this.devices.length; i++) this.stSave.set(this.devices[i].st, i * 4);
  }

  private restore(): void {
    this.x.set(this.xSave);
    for (let i = 0; i < this.devices.length; i++) {
      this.devices[i].st.set(this.stSave.subarray(i * 4, i * 4 + 4));
    }
    this.failed = false;
  }

  /**
   * Advances one time step of `h`, subdividing on non-convergence.
   *
   * A hard switching event (a multivibrator flipping, a diode snapping off)
   * happens orders of magnitude faster than the step the animation wants, so
   * Newton simply cannot get there in one jump. Retrying the same interval as
   * four quarter-steps — recursively — keeps `t` exactly on schedule while
   * giving the solver the resolution it needs across the edge.
   */
  step(h: number): boolean {
    if (this.n === 0) { this.t += h; return true; }
    if (this.attempt(h)) return true;
    this.restore();
    if (this.subdivide(h, 0)) return true;

    // Some instants are genuinely unsolvable to full tolerance — a latching
    // multivibrator is the classic one. Freezing the whole simulation over a
    // single step would be worse than committing its closest approach, so take
    // that and keep going; `nonConverged` records how often this happened.
    this.restore();
    this.attempt(h, true);
    this.nonConverged++;
    return true;
  }

  private subdivide(h: number, depth: number): boolean {
    if (depth >= MAX_SUBDIVIDE) return false;
    const sub = h / 4;
    for (let i = 0; i < 4; i++) {
      if (this.attempt(sub)) continue;
      this.restore();
      if (!this.subdivide(sub, depth + 1)) return false;
    }
    return true;
  }

  /**
   * One backward-Euler step. Leaves the state untouched when it fails, unless
   * `accept` is set, in which case the best iterate is committed anyway.
   */
  private attempt(h: number, accept = false): boolean {
    if (h !== this.lastH) { this.factored = false; this.lastH = h; }
    this.h = h;
    this.failed = false;
    this.snapshot();
    this.xPrev.set(this.x);
    const tNext = this.t + h;

    if (this.linear) {
      if (!this.factored) {
        this.stampAll(tNext);
        if (!this.lu.factor(this.A)) { this.failed = true; return false; }
        this.factored = true;
      } else {
        this.z.fill(0);
        for (const d of this.devices) this.stampRHSOnly(d, tNext);
      }
      this.lu.solve(this.z, this.xNew);
      this.x.set(this.xNew);
      this.iterations = 1;
    } else {
      let converged = false;
      let it = 0;
      let bestStep = Infinity;
      for (; it < MAX_ITER; it++) {
        this.stampAll(tNext);
        if (!this.lu.factor(this.A)) { this.failed = true; return false; }
        this.lu.solve(this.z, this.xNew);
        // Convergence is measured on the raw Newton step, before damping.
        converged = this.checkConvergence() && !this.limited;
        // The first pass only linearises around the previous step, so require
        // at least two passes before trusting the convergence test.
        if (converged && it > 0) { this.x.set(this.xNew); break; }

        // Remember the tightest iterate so a step that never converges can
        // still hand back its closest approach rather than wherever Newton
        // happened to stop wandering.
        let step = 0;
        for (let i = 0; i < this.n; i++) step = Math.max(step, Math.abs(this.xNew[i] - this.x[i]));
        if (step < bestStep && isFinite(step)) { bestStep = step; this.xBest.set(this.xNew); }

        // A transistor in deep saturation can put Newton into a limit cycle
        // that no time step will shake off, because the operating point itself
        // is the hard part. Under-relaxing after the first attempts collapses
        // the cycle without moving the solution it is circling.
        const lam = it < DAMP_AFTER ? 1 : it < DAMP_HARD ? 0.5 : 0.2;
        if (lam === 1) this.x.set(this.xNew);
        else for (let i = 0; i < this.n; i++) this.x[i] += lam * (this.xNew[i] - this.x[i]);
      }
      this.iterations = it + 1;
      if (!converged) {
        this.failed = true;
        if (isFinite(bestStep)) this.x.set(this.xBest);
      }
    }

    // Bail out before touching `t`: a failed attempt must leave the clock
    // exactly where it was so the subdivided retry covers the same interval.
    if (this.failed && !accept) return false;
    for (let i = 0; i < this.n; i++) {
      if (!isFinite(this.x[i])) { this.failed = true; return false; }
    }
    this.t = tNext;
    this.updateResults();
    return !this.failed;
  }
}
