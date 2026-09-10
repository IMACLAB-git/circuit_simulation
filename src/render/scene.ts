import { COMPONENTS, rotate } from '../model/components';
import { pinPositions, type Comp, type Schematic, type Wire } from '../model/schematic';
import { drawSymbol, type SymCtx } from './symbols';
import { flowRate, type SimRunner } from '../sim/runner';
import { probeColor, type CanvasTheme } from '../theme';
import { formatUnit } from '../util/si';

/** Pan and zoom. `g` is the on-screen size of one grid cell in pixels. */
export interface Camera { x: number; y: number; g: number; }

export const toScreen = (cam: Camera, gx: number, gy: number): [number, number] =>
  [cam.x + gx * cam.g, cam.y + gy * cam.g];

export const toGrid = (cam: Camera, sx: number, sy: number): [number, number] =>
  [(sx - cam.x) / cam.g, (sy - cam.y) / cam.g];

/**
 * Voltage-to-colour ramp: blue for the most negative node, slate at zero, red
 * at the most positive. The span is auto-scaled to the circuit so a 3.3 V logic
 * board and a 240 V rectifier both use the full range.
 */
export function voltageColor(v: number, span: number, stops: CanvasTheme['ramp']): string {
  const t = Math.max(-1, Math.min(1, v / Math.max(span, 1e-9)));
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
  const [t0, c0] = stops[i];
  const [t1, c1] = stops[i + 1];
  const f = (t - t0) / (t1 - t0 || 1);
  const c = c0.map((v0, k) => Math.round(v0 + (c1[k] - v0) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export interface DrawOpts {
  sch: Schematic;
  runner: SimRunner;
  cam: Camera;
  width: number;
  height: number;
  selection: Set<string>;
  hoverComp: string | null;
  hoverPoint: [number, number] | null;
  /** In-progress wire, from a fixed start to the cursor. */
  pendingWire: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Ghost of the component about to be dropped. */
  ghost: { type: Comp['type']; x: number; y: number; rot: number } | null;
  showVoltage: boolean;
  showCurrent: boolean;
  showLabels: boolean;
  theme: CanvasTheme;
}

function drawGrid(ctx: CanvasRenderingContext2D, o: DrawOpts) {
  const { cam, width, height } = o;
  ctx.fillStyle = o.theme.bg;
  ctx.fillRect(0, 0, width, height);
  if (cam.g < 7) return;
  const x0 = Math.floor(-cam.x / cam.g) - 1;
  const y0 = Math.floor(-cam.y / cam.g) - 1;
  const x1 = x0 + Math.ceil(width / cam.g) + 2;
  const y1 = y0 + Math.ceil(height / cam.g) + 2;
  ctx.fillStyle = o.theme.grid;
  const r = cam.g > 16 ? 1.2 : 0.9;
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const [sx, sy] = toScreen(cam, gx, gy);
      const major = gx % 5 === 0 && gy % 5 === 0;
      ctx.fillStyle = major ? o.theme.gridStrong : o.theme.grid;
      ctx.beginPath();
      ctx.arc(sx, sy, major ? r + 0.6 : r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Charge dots travelling along a segment.
 *
 * Dots go into one of three brightness buckets by how fast they are moving, so
 * a wire carrying microamps reads as a faint trickle next to a milliamp branch
 * instead of both being equally loud.
 */
const DOT_BUCKETS = 3;

function flowDots(
  buckets: Path2D[], cam: Camera,
  x1: number, y1: number, x2: number, y2: number,
  phase: number, current: number,
) {
  const speed = Math.abs(flowRate(current));
  if (speed < 0.2) return;
  const [ax, ay] = toScreen(cam, x1, y1);
  const [bx, by] = toScreen(cam, x2, y2);
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  const spacing = cam.g * 1.15;
  if (len < 1 || spacing < 8) return;
  const path = buckets[Math.min(DOT_BUCKETS - 1, Math.floor(speed / 1.6))];
  const ux = dx / len, uy = dy / len;
  const r = Math.max(1.2, cam.g * 0.075);
  let s = (((phase % 1) + 1) % 1) * spacing;
  for (; s < len; s += spacing) {
    path.moveTo(ax + ux * s + r, ay + uy * s);
    path.arc(ax + ux * s, ay + uy * s, r, 0, Math.PI * 2);
  }
}

function drawWires(ctx: CanvasRenderingContext2D, o: DrawOpts, dots: Path2D[]) {
  const { sch, runner, cam } = o;
  const span = runner.voltageSpan();
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.8, cam.g * 0.11);
  sch.wires.forEach((w, i) => {
    const v = runner.voltageAt(w.x1, w.y1);
    ctx.strokeStyle = o.showVoltage ? voltageColor(v, span, o.theme.ramp) : o.theme.wireIdle;
    if (o.selection.has(w.id)) ctx.strokeStyle = o.theme.select;
    const [ax, ay] = toScreen(cam, w.x1, w.y1);
    const [bx, by] = toScreen(cam, w.x2, w.y2);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    if (o.showCurrent) {
      flowDots(dots, cam, w.x1, w.y1, w.x2, w.y2, runner.wirePhase[i] ?? 0, runner.wireCur[i] ?? 0);
    }
  });
}

function drawJunctions(ctx: CanvasRenderingContext2D, o: DrawOpts) {
  const net = o.runner.net;
  if (!net) return;
  const span = o.runner.voltageSpan();
  ctx.fillStyle = o.theme.body;
  for (let p = 0; p < net.nPoints; p++) {
    if (net.degree[p] < 3) continue;
    const gx = net.pointXY[p * 2], gy = net.pointXY[p * 2 + 1];
    const [sx, sy] = toScreen(o.cam, gx, gy);
    ctx.fillStyle = o.showVoltage
      ? voltageColor(o.runner.sim.nodeVoltage(net.pointNode[p]), span, o.theme.ramp)
      : o.theme.wireIdle;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(2.2, o.cam.g * 0.15), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawComp(ctx: CanvasRenderingContext2D, o: DrawOpts, c: Comp, dots: Path2D[], ghost = false) {
  const { cam, runner } = o;
  const def = COMPONENTS[c.type];
  const span = runner.voltageSpan();
  const nodes = runner.net?.pinNodes.get(c.id);

  const leadColors = def.pins.map((_, i) => {
    if (ghost) return o.theme.ghostLead;
    if (!o.showVoltage || !nodes) return o.theme.wireIdle;
    return voltageColor(runner.sim.nodeVoltage(nodes[i]), span, o.theme.ramp);
  });

  const [sx, sy] = toScreen(cam, c.x, c.y);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate((c.rot * Math.PI) / 2);
  const sym: SymCtx = {
    g: cam.g,
    body: ghost ? o.theme.ghostBody : o.selection.has(c.id) ? o.theme.select
      : o.hoverComp === c.id ? o.theme.hover : o.theme.body,
    lead: leadColors,
    bg: o.theme.bg,
    params: c.params,
    glow: c.type === 'led' && !ghost ? runner.ledBrightness(c.id) : 0,
    ledOff: o.theme.ledOff,
  };
  drawSymbol(ctx, c.type, sym);
  ctx.restore();

  if (ghost || !o.showCurrent) return;
  // Current dots run from each pin towards the body centre.
  const dev = runner.net?.deviceOf.get(c.id);
  const ph = runner.pinPhase.get(c.id);
  if (!dev || !ph) return;
  def.pins.forEach(([dx, dy], i) => {
    const [rx, ry] = rotate(dx, dy, c.rot);
    flowDots(dots, cam, c.x + rx, c.y + ry, c.x, c.y, ph[i], -dev.pinCur[i]);
  });
}

/**
 * Reference designator and value next to each part.
 *
 * A horizontal part gets its caption underneath; a vertical one gets it to the
 * right. Putting it underneath in both cases would drop the text straight onto
 * the wire leaving the bottom pin, which is where schematics never put it.
 */
function drawLabels(ctx: CanvasRenderingContext2D, o: DrawOpts) {
  const { cam } = o;
  if (cam.g < 12) return;
  const fs = Math.max(9, Math.min(14, cam.g * 0.52));
  ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'top';
  for (const c of o.sch.comps) {
    const def = COMPONENTS[c.type];
    if (def.type === 'ground') continue;
    const value = def.display
      ? (() => {
        const spec = def.params.find((p) => p.key === def.display);
        if (!spec) return null;
        const v = def.type === 'potentiometer' ? c.params.rmax * c.params.pos : c.params[def.display];
        return formatUnit(v, spec.unit);
      })()
      : null;

    const [bx0, by0, bx1, by1] = compBounds(c);
    const vertical = c.rot % 2 === 1;
    let sx: number, sy: number;
    if (vertical) {
      ctx.textAlign = 'left';
      [sx] = toScreen(cam, bx1, 0);
      [, sy] = toScreen(cam, 0, (by0 + by1) / 2);
      sx += 5;
      sy -= value ? fs + 1 : fs / 2;
    } else {
      ctx.textAlign = 'center';
      [sx] = toScreen(cam, (bx0 + bx1) / 2, 0);
      [, sy] = toScreen(cam, 0, by1);
      sy += 3;
    }

    ctx.fillStyle = o.selection.has(c.id) ? o.theme.select : o.theme.text;
    ctx.fillText(c.name, sx, sy);
    if (value) {
      ctx.fillStyle = o.theme.textStrong;
      ctx.fillText(value, sx, sy + fs + 1);
    }
  }
}

function drawProbes(ctx: CanvasRenderingContext2D, o: DrawOpts) {
  const net = o.runner.net;
  if (!net) return;
  const fs = Math.max(9, Math.min(13, o.cam.g * 0.5));
  ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let idx = 0; idx < o.runner.probes.length; idx++) {
    const p = o.runner.probes[idx];
    if (p.kind !== 'v') continue;
    const colour = probeColor(o.theme, idx);
    const pi = net.pointIndex.get(p.target);
    if (pi === undefined) continue;
    const gx = net.pointXY[pi * 2], gy = net.pointXY[pi * 2 + 1];
    const [sx, sy] = toScreen(o.cam, gx, gy);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(3, o.cam.g * 0.2), 0, Math.PI * 2);
    ctx.fill();
    const v = o.runner.sim.nodeVoltage(net.pointNode[pi]);
    const text = formatUnit(v, 'V');
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = o.theme.probeLabelBg;
    ctx.fillRect(sx + 7, sy - fs * 0.75, tw + 8, fs * 1.5);
    ctx.fillStyle = colour;
    ctx.fillText(text, sx + 11, sy + 1);
  }
}

export function drawScene(ctx: CanvasRenderingContext2D, o: DrawOpts): void {
  drawGrid(ctx, o);
  const dots = Array.from({ length: DOT_BUCKETS }, () => new Path2D());

  drawWires(ctx, o, dots);

  if (o.pendingWire) {
    const { cam } = o;
    const [ax, ay] = toScreen(cam, o.pendingWire.x1, o.pendingWire.y1);
    const [bx, by] = toScreen(cam, o.pendingWire.x2, o.pendingWire.y2);
    ctx.strokeStyle = o.theme.hover;
    ctx.lineWidth = Math.max(1.8, cam.g * 0.11);
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const c of o.sch.comps) drawComp(ctx, o, c, dots);
  drawJunctions(ctx, o);

  if (o.showCurrent) {
    const alpha = [0.4, 0.72, 1];
    ctx.shadowColor = o.theme.dotHalo;
    for (let b = 0; b < DOT_BUCKETS; b++) {
      ctx.globalAlpha = alpha[b];
      ctx.shadowBlur = b === DOT_BUCKETS - 1 ? Math.max(2, o.cam.g * 0.18) : 0;
      ctx.fillStyle = o.theme.dot;
      ctx.fill(dots[b]);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  if (o.ghost) {
    drawComp(ctx, o, {
      id: '__ghost__', name: '', params: {} as Record<string, number>,
      type: o.ghost.type, x: o.ghost.x, y: o.ghost.y, rot: o.ghost.rot,
    }, dots, true);
  }

  if (o.hoverPoint) {
    const [sx, sy] = toScreen(o.cam, o.hoverPoint[0], o.hoverPoint[1]);
    ctx.strokeStyle = o.theme.hover;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(4, o.cam.g * 0.24), 0, Math.PI * 2);
    ctx.stroke();
  }

  if (o.showLabels) drawLabels(ctx, o);
  drawProbes(ctx, o);
}

/* ---------------------------------------------------------------- hit tests */

/** Axis-aligned bounds of a placed component, in grid units. */
export function compBounds(c: Comp): [number, number, number, number] {
  const [x0, y0, x1, y1] = COMPONENTS[c.type].box;
  const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [dx, dy] of corners) {
    const [rx, ry] = rotate(dx, dy, c.rot);
    minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
  }
  return [c.x + minX, c.y + minY, c.x + maxX, c.y + maxY];
}

export function hitComp(sch: Schematic, gx: number, gy: number): Comp | null {
  for (let i = sch.comps.length - 1; i >= 0; i--) {
    const c = sch.comps[i];
    const [x0, y0, x1, y1] = compBounds(c);
    if (gx >= x0 - 0.2 && gx <= x1 + 0.2 && gy >= y0 - 0.2 && gy <= y1 + 0.2) return c;
  }
  return null;
}

export function hitPin(
  sch: Schematic, gx: number, gy: number, tol = 0.45,
): { comp: Comp; pin: number } | null {
  for (let i = sch.comps.length - 1; i >= 0; i--) {
    const c = sch.comps[i];
    const pins = pinPositions(c);
    for (let p = 0; p < pins.length; p++) {
      if (Math.hypot(pins[p][0] - gx, pins[p][1] - gy) <= tol) return { comp: c, pin: p };
    }
  }
  return null;
}

export function hitWire(sch: Schematic, gx: number, gy: number, tol = 0.3): Wire | null {
  for (let i = sch.wires.length - 1; i >= 0; i--) {
    const w = sch.wires[i];
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((gx - w.x1) * dx + (gy - w.y1) * dy) / len2));
    const px = w.x1 + t * dx, py = w.y1 + t * dy;
    if (Math.hypot(px - gx, py - gy) <= tol) return w;
  }
  return null;
}

/** Speed of the current animation, exported for the status readout. */
export { flowRate };
