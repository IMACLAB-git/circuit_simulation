import type { CompType } from '../model/components';

/**
 * Schematic symbol painters.
 *
 * Each painter draws in a local frame where the component origin is (0,0), the
 * grid pitch is `g` pixels and the caller has already applied rotation. Leads
 * are painted by the symbol itself so that every pin can carry the colour of
 * the net it belongs to.
 */
export interface SymCtx {
  g: number;
  /** Body stroke colour. */
  body: string;
  /** Lead colour per pin, in the component's pin order. */
  lead: string[];
  /** Canvas background, for knocking holes in crossing lines. */
  bg: string;
  params: Record<string, number>;
  /** 0..1 drive level, used by the LED. */
  glow: number;
  /** HSL lightness for an unlit LED, so it reads as dark on either theme. */
  ledOff: number;
}

type Painter = (ctx: CanvasRenderingContext2D, s: SymCtx) => void;

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** Straight lead from pin `i` towards the body, ending `t` grid units out. */
function lead(ctx: CanvasRenderingContext2D, s: SymCtx, i: number, x1: number, y1: number, x2: number, y2: number) {
  ctx.strokeStyle = s.lead[i] ?? s.body;
  line(ctx, x1 * s.g, y1 * s.g, x2 * s.g, y2 * s.g);
}

const painters: Record<CompType, Painter> = {
  ground: (ctx, s) => {
    const g = s.g;
    ctx.strokeStyle = s.lead[0] ?? s.body;
    line(ctx, 0, 0, 0, 0.35 * g);
    for (let i = 0; i < 3; i++) {
      const w = (0.5 - i * 0.15) * g;
      const y = (0.35 + i * 0.18) * g;
      line(ctx, -w, y, w, y);
    }
  },

  resistor: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.5, 0);
    lead(ctx, s, 1, 0.5, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.beginPath();
    ctx.moveTo(-0.5 * g, 0);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const x = (-0.5 + ((i + 0.5) / n)) * g;
      ctx.lineTo(x, (i % 2 === 0 ? -0.3 : 0.3) * g);
    }
    ctx.lineTo(0.5 * g, 0);
    ctx.stroke();
  },

  capacitor: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.14, 0);
    lead(ctx, s, 1, 0.14, 0, 1, 0);
    ctx.strokeStyle = s.body;
    line(ctx, -0.14 * g, -0.45 * g, -0.14 * g, 0.45 * g);
    line(ctx, 0.14 * g, -0.45 * g, 0.14 * g, 0.45 * g);
  },

  inductor: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.6, 0);
    lead(ctx, s, 1, 0.6, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.beginPath();
    const r = 0.15 * g;
    for (let i = 0; i < 4; i++) {
      ctx.arc(-0.6 * g + r * (2 * i + 1), 0, r, Math.PI, 0, false);
    }
    ctx.stroke();
  },

  potentiometer: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.5, 0);
    lead(ctx, s, 1, 0.5, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.strokeRect(-0.5 * g, -0.28 * g, g, 0.56 * g);
    // Wiper, positioned by the knob setting.
    const x = (-0.42 + 0.84 * (s.params.pos ?? 0.5)) * g;
    ctx.beginPath();
    ctx.moveTo(x, -0.95 * g);
    ctx.lineTo(x, -0.38 * g);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, -0.3 * g);
    ctx.lineTo(x - 0.13 * g, -0.5 * g);
    ctx.lineTo(x + 0.13 * g, -0.5 * g);
    ctx.closePath();
    ctx.fillStyle = s.body;
    ctx.fill();
  },

  battery: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.22, 0);
    lead(ctx, s, 1, 0.22, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.lineWidth = Math.max(1.4, g * 0.075);
    line(ctx, -0.22 * g, -0.52 * g, -0.22 * g, 0.52 * g);
    line(ctx, 0.22 * g, -0.26 * g, 0.22 * g, 0.26 * g);
  },

  vsine: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.55, 0);
    lead(ctx, s, 1, 0.55, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.beginPath();
    ctx.arc(0, 0, 0.55 * g, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = (-0.34 + 0.68 * t) * g;
      const y = -Math.sin(t * Math.PI * 2) * 0.26 * g;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  },

  vpulse: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.55, 0);
    lead(ctx, s, 1, 0.55, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.beginPath();
    ctx.arc(0, 0, 0.55 * g, 0, Math.PI * 2);
    ctx.stroke();
    const a = 0.24 * g, x0 = -0.34 * g, x1 = 0.34 * g, xm = 0;
    ctx.beginPath();
    ctx.moveTo(x0, a);
    ctx.lineTo(x0, -a);
    ctx.lineTo(xm, -a);
    ctx.lineTo(xm, a);
    ctx.lineTo(x1, a);
    ctx.lineTo(x1, -a);
    ctx.stroke();
  },

  isource: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.55, 0);
    lead(ctx, s, 1, 0.55, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.beginPath();
    ctx.arc(0, 0, 0.55 * g, 0, Math.PI * 2);
    ctx.stroke();
    // Arrow points from pin 1 to pin 0: conventional current leaves pin 0.
    line(ctx, 0.3 * g, 0, -0.3 * g, 0);
    ctx.beginPath();
    ctx.moveTo(-0.34 * g, 0);
    ctx.lineTo(-0.1 * g, -0.16 * g);
    ctx.lineTo(-0.1 * g, 0.16 * g);
    ctx.closePath();
    ctx.fillStyle = s.body;
    ctx.fill();
  },

  diode: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -1, 0, -0.3, 0);
    lead(ctx, s, 1, 0.28, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.fillStyle = s.body;
    ctx.beginPath();
    ctx.moveTo(-0.3 * g, -0.38 * g);
    ctx.lineTo(-0.3 * g, 0.38 * g);
    ctx.lineTo(0.28 * g, 0);
    ctx.closePath();
    ctx.fill();
    line(ctx, 0.28 * g, -0.4 * g, 0.28 * g, 0.4 * g);
  },

  led: (ctx, s) => {
    const g = s.g;
    if (s.glow > 0.02) {
      const r = (0.7 + s.glow * 1.1) * g;
      const hue = s.params.hue ?? 0;
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      grad.addColorStop(0, `hsla(${hue}, 100%, 65%, ${0.55 * s.glow})`);
      grad.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    }
    lead(ctx, s, 0, -1, 0, -0.3, 0);
    lead(ctx, s, 1, 0.28, 0, 1, 0);
    const hue = s.params.hue ?? 0;
    ctx.strokeStyle = s.body;
    // A dark tint of its own colour when dark, so an unlit LED reads as unlit
    // rather than as a bright white triangle.
    ctx.fillStyle = s.glow > 0.02
      ? `hsl(${hue}, 100%, ${35 + 45 * s.glow}%)`
      : `hsl(${hue}, 40%, ${s.ledOff}%)`;
    ctx.beginPath();
    ctx.moveTo(-0.3 * g, -0.38 * g);
    ctx.lineTo(-0.3 * g, 0.38 * g);
    ctx.lineTo(0.28 * g, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = s.body;
    line(ctx, 0.28 * g, -0.4 * g, 0.28 * g, 0.4 * g);
    // Emission arrows.
    ctx.strokeStyle = s.glow > 0.02 ? `hsl(${hue}, 90%, 70%)` : s.body;
    for (const dy of [-0.15, 0.2]) {
      const x0 = 0.05 * g, y0 = (-0.5 + dy) * g;
      const x1 = x0 + 0.34 * g, y1 = y0 - 0.34 * g;
      line(ctx, x0, y0, x1, y1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - 0.16 * g, y1 + 0.05 * g);
      ctx.lineTo(x1 - 0.05 * g, y1 + 0.16 * g);
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.fill();
    }
  },

  npn: (ctx, s) => bjt(ctx, s, true),
  pnp: (ctx, s) => bjt(ctx, s, false),
  nmos: (ctx, s) => mos(ctx, s, true),
  pmos: (ctx, s) => mos(ctx, s, false),

  opamp: (ctx, s) => {
    const g = s.g;
    lead(ctx, s, 0, -2, -1, -1.2, -1);
    lead(ctx, s, 1, -2, 1, -1.2, 1);
    lead(ctx, s, 2, 1.2, 0, 2, 0);
    ctx.strokeStyle = s.body;
    ctx.fillStyle = s.bg;
    ctx.beginPath();
    ctx.moveTo(-1.2 * g, -1.5 * g);
    ctx.lineTo(-1.2 * g, 1.5 * g);
    ctx.lineTo(1.2 * g, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // + and - markers at the inputs.
    line(ctx, -1.05 * g, -1 * g, -0.75 * g, -1 * g);
    line(ctx, -0.9 * g, -1.15 * g, -0.9 * g, -0.85 * g);
    line(ctx, -1.05 * g, 1 * g, -0.75 * g, 1 * g);
  },

  switch: (ctx, s) => {
    const g = s.g;
    const closed = (s.params.closed ?? 0) > 0.5;
    lead(ctx, s, 0, -1, 0, -0.55, 0);
    lead(ctx, s, 1, 0.55, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.fillStyle = s.body;
    for (const x of [-0.55, 0.55]) {
      ctx.beginPath();
      ctx.arc(x * g, 0, 0.11 * g, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(-0.55 * g, 0);
    if (closed) ctx.lineTo(0.55 * g, 0);
    else ctx.lineTo(0.5 * g, -0.62 * g);
    ctx.stroke();
  },

  button: (ctx, s) => {
    const g = s.g;
    const pressed = (s.params.closed ?? 0) > 0.5;
    lead(ctx, s, 0, -1, 0, -0.5, 0);
    lead(ctx, s, 1, 0.5, 0, 1, 0);
    ctx.strokeStyle = s.body;
    ctx.fillStyle = s.body;
    for (const x of [-0.5, 0.5]) {
      ctx.beginPath();
      ctx.arc(x * g, 0, 0.1 * g, 0, Math.PI * 2);
      ctx.fill();
      line(ctx, x * g, 0, x * g, -0.28 * g);
    }
    const y = pressed ? -0.28 * g : -0.6 * g;
    line(ctx, -0.62 * g, y, 0.62 * g, y);
    line(ctx, 0, y, 0, y - 0.3 * g);
    ctx.fillRect(-0.28 * g, y - 0.52 * g, 0.56 * g, 0.22 * g);
  },
};

/** Bipolar transistor. Pin order: base, collector, emitter. */
function bjt(ctx: CanvasRenderingContext2D, s: SymCtx, npn: boolean) {
  const g = s.g;
  lead(ctx, s, 0, -1, 0, -0.42, 0);
  ctx.strokeStyle = s.body;
  ctx.lineWidth = Math.max(1.6, g * 0.09);
  line(ctx, -0.42 * g, -0.55 * g, -0.42 * g, 0.55 * g);
  ctx.lineWidth = Math.max(1.2, g * 0.06);

  // Collector and emitter slants, then their leads out to the pins.
  const cx = 0.55, cy = -0.62, ex = 0.55, ey = 0.62;
  ctx.strokeStyle = s.lead[1] ?? s.body;
  line(ctx, -0.42 * g, -0.3 * g, cx * g, cy * g);
  line(ctx, cx * g, cy * g, 1 * g, -1 * g);
  ctx.strokeStyle = s.lead[2] ?? s.body;
  line(ctx, -0.42 * g, 0.3 * g, ex * g, ey * g);
  line(ctx, ex * g, ey * g, 1 * g, 1 * g);

  // Emitter arrow, sitting on the emitter slant: outward for NPN, inward for
  // PNP. `t` slides it along the slant so the head lands clear of the base bar.
  const x0 = -0.42, y0 = 0.3;
  const dx = ex - x0, dy = ey - y0;
  const len = Math.hypot(dx, dy) || 1;
  const dir = npn ? 1 : -1;
  const ux = (dir * dx) / len, uy = (dir * dy) / len;
  const t = npn ? 0.62 : 0.42;
  const px = (x0 + dx * t) * g;
  const py = (y0 + dy * t) * g;
  ctx.fillStyle = s.lead[2] ?? s.body;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(Math.atan2(uy, ux));
  ctx.beginPath();
  ctx.moveTo(0.2 * g, 0);
  ctx.lineTo(-0.12 * g, -0.14 * g);
  ctx.lineTo(-0.12 * g, 0.14 * g);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** MOSFET. Pin order: gate, drain, source. */
function mos(ctx: CanvasRenderingContext2D, s: SymCtx, nch: boolean) {
  const g = s.g;
  lead(ctx, s, 0, -1, 0, -0.6, 0);
  ctx.strokeStyle = s.body;
  line(ctx, -0.6 * g, -0.55 * g, -0.6 * g, 0.55 * g);
  // Channel: three segments, enhancement style.
  for (const [y0, y1] of [[-0.62, -0.28], [-0.17, 0.17], [0.28, 0.62]] as const) {
    ctx.lineWidth = Math.max(1.6, g * 0.09);
    line(ctx, -0.36 * g, y0 * g, -0.36 * g, y1 * g);
  }
  ctx.lineWidth = Math.max(1.2, g * 0.06);
  ctx.strokeStyle = s.lead[1] ?? s.body;
  line(ctx, -0.36 * g, -0.45 * g, 0.5 * g, -0.45 * g);
  line(ctx, 0.5 * g, -0.45 * g, 0.5 * g, -1 * g);
  line(ctx, 0.5 * g, -1 * g, 1 * g, -1 * g);
  ctx.strokeStyle = s.lead[2] ?? s.body;
  line(ctx, -0.36 * g, 0.45 * g, 0.5 * g, 0.45 * g);
  line(ctx, 0.5 * g, 0.45 * g, 0.5 * g, 1 * g);
  line(ctx, 0.5 * g, 1 * g, 1 * g, 1 * g);
  // Bulk arrow on the middle segment.
  ctx.fillStyle = s.body;
  ctx.save();
  ctx.translate(-0.18 * g, 0);
  if (!nch) ctx.rotate(Math.PI);
  ctx.beginPath();
  ctx.moveTo(-0.16 * g, 0);
  ctx.lineTo(0.08 * g, -0.13 * g);
  ctx.lineTo(0.08 * g, 0.13 * g);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  line(ctx, -0.02 * g, 0, 0.5 * g, 0);
  line(ctx, 0.5 * g, 0, 0.5 * g, -0.45 * g);
}

export function drawSymbol(ctx: CanvasRenderingContext2D, type: CompType, s: SymCtx): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.2, s.g * 0.06);
  painters[type](ctx, s);
  ctx.restore();
}
