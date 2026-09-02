import { useSyncExternalStore } from 'react';
import { COMPONENTS, defaultParams, type CompType } from './model/components';
import { key, pinPositions, type Comp, type Schematic } from './model/schematic';
import { SimRunner } from './sim/runner';
import { EXAMPLES } from './examples';

export type Tool = 'select' | 'wire' | 'probe';

export interface State {
  sch: Schematic;
  selection: string[];
  tool: Tool;
  /** Component type waiting to be dropped on the canvas. */
  placing: CompType | null;
  placingRot: number;
  running: boolean;
  showVoltage: boolean;
  showCurrent: boolean;
  showLabels: boolean;
  timeScale: number;
  timebase: number;
  autoStep: boolean;
  dt: number;
  scopeOpen: boolean;
  exampleId: string | null;
  /** Bumped whenever the schematic changes, so effects can react. */
  rev: number;
  /** Bumped to ask the canvas to re-centre on the circuit. */
  fitTick: number;
}

/** The solver lives outside React: it runs per animation frame, not per render. */
export const runner = new SimRunner();

const STORAGE_KEY = 'circuit-lab.v1';

let state: State = {
  sch: { comps: [], wires: [] },
  selection: [],
  tool: 'select',
  placing: null,
  placingRot: 0,
  running: true,
  showVoltage: true,
  showCurrent: true,
  showLabels: true,
  timeScale: 1,
  timebase: 0.02,
  autoStep: true,
  dt: 1e-5,
  scopeOpen: true,
  exampleId: null,
  rev: 0,
  fitTick: 0,
};

const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function getState(): State { return state; }
export function useStore(): State {
  return useSyncExternalStore(subscribe, getState, getState);
}

let past: Schematic[] = [];
let future: Schematic[] = [];

const clone = (s: Schematic): Schematic => ({
  comps: s.comps.map((c) => ({ ...c, params: { ...c.params } })),
  wires: s.wires.map((w) => ({ ...w })),
});

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  runner.running = state.running;
  runner.timeScale = state.timeScale;
  runner.timebase = state.timebase;
  runner.autoStep = state.autoStep;
  if (!state.autoStep) runner.dt = state.dt;
  emit();
}

/** Applies a schematic edit, rebuilding the netlist and pushing undo history. */
function edit(next: Schematic, opts: { topology?: boolean; history?: boolean } = {}): void {
  const { topology = true, history = true } = opts;
  if (history) {
    past.push(clone(state.sch));
    if (past.length > 100) past.shift();
    future = [];
  }
  state = { ...state, sch: next, rev: state.rev + 1 };
  if (topology) runner.rebuild(next);
  else { runner.sch = next; runner.syncParams(); }
  save();
  emit();
}

let saveTimer: number | undefined;
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        sch: state.sch,
        probes: runner.probes.map((p) => ({ kind: p.kind, target: p.target, label: p.label })),
        timeScale: state.timeScale,
        timebase: state.timebase,
      }));
    } catch { /* private mode or quota: not worth surfacing */ }
  }, 400);
}

let uid = 0;
const nextId = () => `n${Date.now().toString(36)}${(uid++).toString(36)}`;

/** R1, R2, C1 ... picking the lowest free index for the designator. */
function nextName(sch: Schematic, type: CompType): string {
  const d = COMPONENTS[type].desig;
  if (type === 'ground') return '';
  const used = new Set(
    sch.comps.filter((c) => COMPONENTS[c.type].desig === d)
      .map((c) => parseInt(c.name.slice(d.length), 10)),
  );
  let i = 1;
  while (used.has(i)) i++;
  return `${d}${i}`;
}

/* ------------------------------------------------------------------ actions */

export const actions = {
  setTool(tool: Tool) { set({ tool, placing: null }); },

  startPlacing(type: CompType | null) {
    set({ placing: type, tool: 'select', selection: [] });
  },

  setPlacingRot(rot: number) { set({ placingRot: ((rot % 4) + 4) % 4 }); },

  addComp(type: CompType, x: number, y: number, rot: number) {
    const sch = clone(state.sch);
    const c: Comp = {
      id: nextId(), type, x, y, rot,
      params: defaultParams(type),
      name: nextName(sch, type),
    };
    sch.comps.push(c);
    edit(sch);
    set({ selection: [c.id] });
  },

  addWire(x1: number, y1: number, x2: number, y2: number) {
    if (x1 === x2 && y1 === y2) return;
    const sch = clone(state.sch);
    sch.wires.push({ id: nextId(), x1, y1, x2, y2 });
    edit(sch);
  },

  moveSelection(dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    const sel = new Set(state.selection);
    const sch = clone(state.sch);
    for (const c of sch.comps) if (sel.has(c.id)) { c.x += dx; c.y += dy; }
    for (const w of sch.wires) {
      if (!sel.has(w.id)) continue;
      w.x1 += dx; w.y1 += dy; w.x2 += dx; w.y2 += dy;
    }
    edit(sch);
  },

  rotateSelection() {
    const sel = new Set(state.selection);
    const sch = clone(state.sch);
    for (const c of sch.comps) if (sel.has(c.id)) c.rot = (c.rot + 1) % 4;
    edit(sch);
  },

  deleteSelection() {
    if (state.selection.length === 0) return;
    const sel = new Set(state.selection);
    const sch = clone(state.sch);
    sch.comps = sch.comps.filter((c) => !sel.has(c.id));
    sch.wires = sch.wires.filter((w) => !sel.has(w.id));
    edit(sch);
    set({ selection: [] });
  },

  select(ids: string[]) { set({ selection: ids }); },

  setParam(id: string, k: string, value: number) {
    const sch = clone(state.sch);
    const c = sch.comps.find((x) => x.id === id);
    if (!c) return;
    c.params[k] = value;
    // Parameter tweaks keep the topology, so the solver state survives.
    edit(sch, { topology: false, history: false });
  },

  /** Click a switch or button body: flip its state without touching history. */
  toggleComp(id: string, value?: boolean) {
    const c = state.sch.comps.find((x) => x.id === id);
    if (!c) return;
    const t = COMPONENTS[c.type].toggle;
    if (!t) return;
    const next = value === undefined ? (c.params[t] > 0.5 ? 0 : 1) : (value ? 1 : 0);
    actions.setParam(id, t, next);
  },

  rename(id: string, name: string) {
    const sch = clone(state.sch);
    const c = sch.comps.find((x) => x.id === id);
    if (!c) return;
    c.name = name;
    edit(sch, { topology: false, history: false });
  },

  undo() {
    const prev = past.pop();
    if (!prev) return;
    future.push(clone(state.sch));
    state = { ...state, sch: prev, rev: state.rev + 1, selection: [] };
    runner.rebuild(prev);
    save();
    emit();
  },

  redo() {
    const next = future.pop();
    if (!next) return;
    past.push(clone(state.sch));
    state = { ...state, sch: next, rev: state.rev + 1, selection: [] };
    runner.rebuild(next);
    save();
    emit();
  },

  clearAll() {
    edit({ comps: [], wires: [] });
    runner.clearProbes();
    set({ selection: [], exampleId: null });
  },

  toggleRun() { set({ running: !state.running }); },

  fitView() { set({ fitTick: state.fitTick + 1 }); },

  reset() { runner.reset(); emit(); },

  operatingPoint() { runner.operatingPoint(); emit(); },

  setTimeScale(v: number) { set({ timeScale: v }); },
  setTimebase(v: number) { runner.timebase = v; set({ timebase: v }); },
  setAutoStep(v: boolean) { set({ autoStep: v }); if (v) runner.rebuild(state.sch); },
  setDt(v: number) { set({ autoStep: false, dt: v }); runner.dt = v; },
  setScopeOpen(v: boolean) { set({ scopeOpen: v }); },
  setShow(patch: Partial<Pick<State, 'showVoltage' | 'showCurrent' | 'showLabels'>>) { set(patch); },

  probeNode(x: number, y: number, label?: string) {
    runner.addProbe('v', key(x, y), label ?? `노드 ${x},${y}`);
    emit();
  },

  probeCurrent(compId: string) {
    const c = state.sch.comps.find((x) => x.id === compId);
    runner.addProbe('i', compId, `${c?.name ?? compId} 전류`);
    emit();
  },

  clearProbes() { runner.clearProbes(); emit(); },

  loadExample(id: string) {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    const sch = ex.build();
    past = []; future = [];
    state = { ...state, sch, selection: [], rev: state.rev + 1, exampleId: id };
    runner.clearProbes();
    runner.rebuild(sch);
    if (ex.timeScale !== undefined) state = { ...state, timeScale: ex.timeScale };
    if (ex.timebase !== undefined) state = { ...state, timebase: ex.timebase };
    runner.timeScale = state.timeScale;
    runner.timebase = state.timebase;
    for (const p of ex.probes ?? []) runner.addProbe('v', key(p.x, p.y), p.label);
    runner.reset();
    state = { ...state, fitTick: state.fitTick + 1 };
    save();
    emit();
  },

  loadJSON(text: string): string | null {
    try {
      const data = JSON.parse(text);
      const sch = data.sch ?? data;
      if (!Array.isArray(sch.comps) || !Array.isArray(sch.wires)) return '형식이 올바르지 않습니다.';
      past = []; future = [];
      state = { ...state, sch, selection: [], rev: state.rev + 1, exampleId: null };
      runner.clearProbes();
      runner.rebuild(sch);
      for (const p of data.probes ?? []) runner.addProbe(p.kind, p.target, p.label);
      state = { ...state, fitTick: state.fitTick + 1 };
      save();
      emit();
      return null;
    } catch (e) {
      return `읽지 못했습니다: ${(e as Error).message}`;
    }
  },

  exportJSON(): string {
    return JSON.stringify({
      sch: state.sch,
      probes: runner.probes.map((p) => ({ kind: p.kind, target: p.target, label: p.label })),
      timeScale: state.timeScale,
      timebase: state.timebase,
    }, null, 2);
  },
};

/** Point keys that a wire could usefully snap to: pins and wire endpoints. */
export function snapTargets(sch: Schematic): Set<string> {
  const s = new Set<string>();
  for (const c of sch.comps) for (const [x, y] of pinPositions(c)) s.add(key(x, y));
  for (const w of sch.wires) { s.add(key(w.x1, w.y1)); s.add(key(w.x2, w.y2)); }
  return s;
}

/**
 * Restores the last session, falling back to the LED blinker demo.
 *
 * `#ex=<id>` in the URL overrides both, which makes a particular demo
 * linkable and gives the screenshot tooling a way in.
 */
export function boot(): void {
  const wanted = /[#&?]ex=([\w-]+)/.exec(location.hash + location.search)?.[1];
  if (wanted && EXAMPLES.some((e) => e.id === wanted)) {
    actions.loadExample(wanted);
    runner.running = state.running;
    emit();
    return;
  }
  let restored = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data?.sch?.comps?.length) {
        state = {
          ...state,
          sch: data.sch,
          timeScale: data.timeScale ?? state.timeScale,
          timebase: data.timebase ?? state.timebase,
        };
        runner.timeScale = state.timeScale;
        runner.timebase = state.timebase;
        runner.rebuild(data.sch);
        for (const p of data.probes ?? []) runner.addProbe(p.kind, p.target, p.label);
        restored = true;
        state = { ...state, fitTick: state.fitTick + 1 };
      }
    }
  } catch { /* corrupt payload: fall through to the demo */ }
  if (!restored) actions.loadExample('led-blinker');
  runner.running = state.running;
  emit();
}
