import { COMPONENTS, rotate, type CompType } from './components';
import { makeDevice, VT, type Device } from '../engine/simulator';

/** A placed component. Coordinates are integer grid cells. */
export interface Comp {
  id: string;
  type: CompType;
  x: number;
  y: number;
  /** Quarter turns clockwise, 0..3. */
  rot: number;
  params: Record<string, number>;
  name: string;
}

/** A single wire segment between two grid points. */
export interface Wire {
  id: string;
  x1: number; y1: number;
  x2: number; y2: number;
}

export interface Schematic {
  comps: Comp[];
  wires: Wire[];
}

export const key = (x: number, y: number) => `${x},${y}`;

/** Absolute grid positions of a component's pins, after rotation. */
export function pinPositions(c: Comp): [number, number][] {
  return COMPONENTS[c.type].pins.map(([dx, dy]) => {
    const [rx, ry] = rotate(dx, dy, c.rot);
    return [c.x + rx, c.y + ry] as [number, number];
  });
}

/** True if (px,py) lies on the closed segment (x1,y1)-(x2,y2). */
function onSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): boolean {
  const cross = (px - x1) * (y2 - y1) - (py - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-9) return false;
  const dot = (px - x1) * (x2 - x1) + (py - y1) * (y2 - y1);
  if (dot < 0) return false;
  const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  return dot <= len2;
}

class UnionFind {
  private p: number[] = [];
  add(): number { this.p.push(this.p.length); return this.p.length - 1; }
  find(i: number): number {
    while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p[rb] = ra;
  }
}

export interface Netlist {
  nNodes: number;
  devices: Device[];
  /** Distinct grid points that carry a connection, in index order. */
  pointXY: Float64Array;
  nPoints: number;
  /** Point key -> point index. */
  pointIndex: Map<string, number>;
  /** Point index -> node index (-1 = ground). */
  pointNode: Int32Array;
  /** Component id -> point index per pin. */
  pinPoints: Map<string, number[]>;
  /** Component id -> node index per pin. */
  pinNodes: Map<string, number[]>;
  /** Component id -> its engine device, if it maps to one. */
  deviceOf: Map<string, Device>;
  /** Connection count at each point; >= 3 means a junction dot is drawn. */
  degree: Int32Array;
  /** Spanning forest used to push pin currents onto wire segments. */
  order: Int32Array;
  parent: Int32Array;
  parentWire: Int32Array;
  parentDir: Float64Array;
  nWires: number;
}

const SOURCE_DEFAULTS = {
  dc: 0, wave: 0, offset: 0, amp: 0, freq: 0, phase: 0,
  vhigh: 0, vlow: 0, duty: 0.5,
};

/** Maps schematic parameters onto the parameters the engine model expects. */
export function engineParams(c: Comp): Record<string, number> {
  const def = COMPONENTS[c.type];
  const p: Record<string, number> = { ...c.params, ...(def.fixed ?? {}) };
  switch (c.type) {
    case 'potentiometer':
      p.r = Math.max(c.params.rmax * c.params.pos, 0.01);
      break;
    case 'led': {
      // Pick a saturation current that puts the knee at the rated Vf.
      const n = 2;
      const vt = n * VT;
      p.n = n;
      p.is = c.params.irated / (Math.exp(c.params.vf / vt) - 1);
      break;
    }
    case 'battery': case 'vsine': case 'vpulse': case 'isource':
      return { ...SOURCE_DEFAULTS, ...p };
    default:
      break;
  }
  return p;
}

/**
 * Turns a schematic into an engine netlist.
 *
 * Connectivity rule: two terminals are joined when they share a grid point, and
 * a terminal sitting anywhere along a wire segment joins that wire too, so
 * T-junctions work without an explicit junction dot.
 */
export function buildNetlist(sch: Schematic): Netlist {
  const pointIndex = new Map<string, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const uf = new UnionFind();

  const addPoint = (x: number, y: number): number => {
    const k = key(x, y);
    let i = pointIndex.get(k);
    if (i === undefined) {
      i = uf.add();
      pointIndex.set(k, i);
      xs.push(x); ys.push(y);
    }
    return i;
  };

  // 1. Register every terminal: component pins and wire endpoints.
  const pinPoints = new Map<string, number[]>();
  for (const c of sch.comps) {
    pinPoints.set(c.id, pinPositions(c).map(([x, y]) => addPoint(x, y)));
  }
  const wireA: number[] = [];
  const wireB: number[] = [];
  for (const w of sch.wires) {
    wireA.push(addPoint(w.x1, w.y1));
    wireB.push(addPoint(w.x2, w.y2));
  }

  // 2. Every point lying on a wire joins that wire's net. Collect the wire's
  //    on-segment members so the spanning tree can chain through them.
  const nPoints = xs.length;
  const wireMembers: number[][] = [];
  for (let wi = 0; wi < sch.wires.length; wi++) {
    const w = sch.wires[wi];
    const members: number[] = [];
    for (let p = 0; p < nPoints; p++) {
      if (onSegment(xs[p], ys[p], w.x1, w.y1, w.x2, w.y2)) members.push(p);
    }
    // Order members along the segment so adjacent pairs form the tree edges.
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    members.sort((a, b) => (xs[a] * dx + ys[a] * dy) - (xs[b] * dx + ys[b] * dy));
    wireMembers.push(members);
    for (let i = 1; i < members.length; i++) uf.union(members[i - 1], members[i]);
    uf.union(wireA[wi], wireB[wi]);
  }

  // 3. Ground nets, then number the remaining nets.
  const groundRoots = new Set<number>();
  for (const c of sch.comps) {
    if (c.type === 'ground') groundRoots.add(uf.find(pinPoints.get(c.id)![0]));
  }
  const rootNode = new Map<number, number>();
  let nNodes = 0;
  const pointNode = new Int32Array(nPoints);
  for (let p = 0; p < nPoints; p++) {
    const r = uf.find(p);
    if (groundRoots.has(r)) { pointNode[p] = -1; continue; }
    let idx = rootNode.get(r);
    if (idx === undefined) { idx = nNodes++; rootNode.set(r, idx); }
    pointNode[p] = idx;
  }

  // 4. Devices.
  const devices: Device[] = [];
  const deviceOf = new Map<string, Device>();
  const pinNodes = new Map<string, number[]>();
  for (const c of sch.comps) {
    const nodes = pinPoints.get(c.id)!.map((p) => pointNode[p]);
    pinNodes.set(c.id, nodes);
    const dt = COMPONENTS[c.type].device;
    if (!dt) continue;
    const d = makeDevice(c.id, dt, nodes, engineParams(c));
    devices.push(d);
    deviceOf.set(c.id, d);
  }

  // 5. Spanning forest over the wire graph, one BFS per net.
  const adjHead = new Int32Array(nPoints).fill(-1);
  const adjNext: number[] = [];
  const adjTo: number[] = [];
  const adjWire: number[] = [];
  const adjDir: number[] = [];
  const link = (from: number, to: number, wi: number, dir: number) => {
    adjTo.push(to); adjWire.push(wi); adjDir.push(dir);
    adjNext.push(adjHead[from]);
    adjHead[from] = adjTo.length - 1;
  };
  for (let wi = 0; wi < wireMembers.length; wi++) {
    const m = wireMembers[wi];
    for (let i = 1; i < m.length; i++) {
      if (m[i - 1] === m[i]) continue;
      link(m[i - 1], m[i], wi, 1);
      link(m[i], m[i - 1], wi, -1);
    }
  }

  const order = new Int32Array(nPoints);
  const parent = new Int32Array(nPoints).fill(-1);
  const parentWire = new Int32Array(nPoints).fill(-1);
  const parentDir = new Float64Array(nPoints);
  const seen = new Uint8Array(nPoints);
  let head = 0, tail = 0;
  for (let s = 0; s < nPoints; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    order[tail++] = s;
    while (head < tail) {
      const u = order[head++];
      for (let e = adjHead[u]; e !== -1; e = adjNext[e]) {
        const v = adjTo[e];
        if (seen[v]) continue;
        seen[v] = 1;
        parent[v] = u;
        parentWire[v] = adjWire[e];
        parentDir[v] = adjDir[e];
        order[tail++] = v;
      }
    }
  }

  // 6. Connection degree, for drawing junction dots.
  const degree = new Int32Array(nPoints);
  for (const m of wireMembers) {
    for (let i = 0; i < m.length; i++) {
      degree[m[i]] += (i > 0 ? 1 : 0) + (i < m.length - 1 ? 1 : 0);
    }
  }
  for (const pts of pinPoints.values()) for (const p of pts) degree[p] += 1;

  return {
    nNodes, devices,
    pointXY: Float64Array.from(xs.flatMap((x, i) => [x, ys[i]])),
    nPoints, pointIndex, pointNode,
    pinPoints, pinNodes, deviceOf, degree,
    order, parent, parentWire, parentDir,
    nWires: sch.wires.length,
  };
}
