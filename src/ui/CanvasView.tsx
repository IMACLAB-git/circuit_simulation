import { useCallback, useEffect, useRef, useState } from 'react';
import {
  compBounds, drawScene, hitComp, hitPin, hitWire, toGrid, toScreen, type Camera,
} from '../render/scene';
import { COMPONENTS } from '../model/components';
import { pinPositions } from '../model/schematic';
import { actions, getState, runner, useStore } from '../store';

type Drag =
  | { mode: 'none' }
  | { mode: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { mode: 'move'; gx: number; gy: number; moved: boolean }
  | { mode: 'wire'; x1: number; y1: number; x2: number; y2: number }
  | { mode: 'marquee'; x1: number; y1: number; x2: number; y2: number }
  | { mode: 'press'; id: string; momentary: boolean; gx: number; gy: number };

const snap = (v: number) => Math.round(v);

/**
 * The schematic editor.
 *
 * All per-frame work happens in a requestAnimationFrame loop reading the runner
 * directly; React state only carries things that change when the user edits, so
 * a running simulation never triggers a re-render.
 */
export default function CanvasView() {
  const st = useStore();
  const ref = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>({ x: 60, y: 60, g: 26 });
  const drag = useRef<Drag>({ mode: 'none' });
  const cursor = useRef<{ gx: number; gy: number } | null>(null);
  const hover = useRef<{ comp: string | null; point: [number, number] | null }>({ comp: null, point: null });
  const [cursorStyle, setCursorStyle] = useState('default');

  /** Centres and scales the view on the whole circuit. */
  const fit = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { sch } = getState();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of sch.comps) {
      const b = compBounds(c);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
    for (const wr of sch.wires) {
      x0 = Math.min(x0, wr.x1, wr.x2); y0 = Math.min(y0, wr.y1, wr.y2);
      x1 = Math.max(x1, wr.x1, wr.x2); y1 = Math.max(y1, wr.y1, wr.y2);
    }
    if (!isFinite(x0)) { cam.current = { x: w / 2, y: h / 2, g: 26 }; return; }
    const pad = 2.5;
    const g = Math.max(8, Math.min(46, Math.min(w / (x1 - x0 + pad * 2), h / (y1 - y0 + pad * 2))));
    cam.current = {
      g,
      x: w / 2 - ((x0 + x1) / 2) * g,
      y: h / 2 - ((y0 + y1) / 2) * g,
    };
  }, []);

  useEffect(() => { fit(); }, [fit, st.fitTick]);

  // Render loop: advance the solver, then paint.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      runner.tick(dt);

      const s = getState();
      const d = drag.current;
      drawScene(ctx, {
        sch: s.sch,
        runner,
        cam: cam.current,
        width: w,
        height: h,
        selection: new Set(s.selection),
        hoverComp: hover.current.comp,
        hoverPoint: hover.current.point,
        pendingWire: d.mode === 'wire' ? d : null,
        ghost: s.placing && cursor.current
          ? { type: s.placing, x: cursor.current.gx, y: cursor.current.gy, rot: s.placingRot }
          : null,
        showVoltage: s.showVoltage,
        showCurrent: s.showCurrent,
        showLabels: s.showLabels,
      });

      if (d.mode === 'marquee') {
        const [ax, ay] = toScreen(cam.current, d.x1, d.y1);
        const [bx, by] = toScreen(cam.current, d.x2, d.y2);
        ctx.fillStyle = 'rgba(56,189,248,0.12)';
        ctx.strokeStyle = 'rgba(56,189,248,0.8)';
        ctx.lineWidth = 1;
        ctx.fillRect(ax, ay, bx - ax, by - ay);
        ctx.strokeRect(ax + 0.5, ay + 0.5, bx - ax, by - ay);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const s = getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? actions.redo() : actions.undo();
        return;
      }
      switch (e.key) {
        case 'r': case 'R': case 'ㄱ':
          e.preventDefault();
          if (s.placing) actions.setPlacingRot(s.placingRot + 1);
          else actions.rotateSelection();
          break;
        case 'Delete': case 'Backspace':
          e.preventDefault();
          actions.deleteSelection();
          break;
        case 'Escape':
          if (s.placing) actions.startPlacing(null);
          else if (s.tool !== 'select') actions.setTool('select');
          else actions.select([]);
          break;
        case ' ':
          e.preventDefault();
          actions.toggleRun();
          break;
        case 'w': case 'W':
          actions.setTool(s.tool === 'wire' ? 'select' : 'wire');
          break;
        case 'p': case 'P':
          actions.setTool(s.tool === 'probe' ? 'select' : 'probe');
          break;
        case 'f': case 'F':
          fit();
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fit]);

  /* -------------------------------------------------------------- pointer */

  const gridAt = (e: React.PointerEvent | React.WheelEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return toGrid(cam.current, e.clientX - r.left, e.clientY - r.top);
  };

  /** Adds a wire from (x1,y1) to (x2,y2), routed as an L when not aligned. */
  const commitWire = (x1: number, y1: number, x2: number, y2: number) => {
    if (x1 === x2 && y1 === y2) return;
    if (x1 === x2 || y1 === y2) { actions.addWire(x1, y1, x2, y2); return; }
    // Elbow first along the longer axis, which is what people expect.
    if (Math.abs(x2 - x1) >= Math.abs(y2 - y1)) {
      actions.addWire(x1, y1, x2, y1);
      actions.addWire(x2, y1, x2, y2);
    } else {
      actions.addWire(x1, y1, x1, y2);
      actions.addWire(x1, y2, x2, y2);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    ref.current!.setPointerCapture(e.pointerId);
    const [gx, gy] = gridAt(e);
    const s = getState();

    if (e.button === 1 || e.button === 2 || e.altKey) {
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.current.x, cy: cam.current.y };
      setCursorStyle('grabbing');
      return;
    }

    if (s.placing) {
      actions.addComp(s.placing, snap(gx), snap(gy), s.placingRot);
      if (!e.shiftKey) actions.startPlacing(null);
      return;
    }

    const pin = hitPin(s.sch, gx, gy);
    const wire = hitWire(s.sch, gx, gy);
    const comp = hitComp(s.sch, gx, gy);

    // Probing: the probe tool, or shift-click anywhere on a net.
    if (s.tool === 'probe' || e.shiftKey) {
      if (pin) {
        const [px, py] = pinPositions(pin.comp)[pin.pin];
        actions.probeNode(px, py, `${pin.comp.name}.${COMPONENTS[pin.comp.type].pinNames[pin.pin]}`);
      } else if (wire) {
        actions.probeNode(wire.x1, wire.y1, `노드 (${wire.x1},${wire.y1})`);
      } else if (comp) {
        actions.probeCurrent(comp.id);
      }
      return;
    }

    if (s.tool === 'wire') {
      drag.current = { mode: 'wire', x1: snap(gx), y1: snap(gy), x2: snap(gx), y2: snap(gy) };
      return;
    }

    // Dragging off a pin starts a wire; that beats moving the part, since the
    // pin is the smaller target and the intent is unambiguous.
    if (pin) {
      const [px, py] = pinPositions(pin.comp)[pin.pin];
      drag.current = { mode: 'wire', x1: px, y1: py, x2: px, y2: py };
      return;
    }

    if (comp) {
      const def = COMPONENTS[comp.type];
      const already = s.selection.includes(comp.id);
      if (e.ctrlKey || e.metaKey) {
        actions.select(already ? s.selection.filter((i) => i !== comp.id) : [...s.selection, comp.id]);
      } else if (!already) {
        actions.select([comp.id]);
      }
      if (def.toggle) {
        // Switches and buttons are meant to be poked while the circuit runs.
        // A push-button closes on the way down; a toggle waits for the release,
        // so that either one can still be dragged somewhere else without
        // flipping on the way.
        if (def.momentary) actions.toggleComp(comp.id, true);
        drag.current = {
          mode: 'press', id: comp.id, momentary: !!def.momentary,
          gx: snap(gx), gy: snap(gy),
        };
        return;
      }
      drag.current = { mode: 'move', gx: snap(gx), gy: snap(gy), moved: false };
      return;
    }

    if (wire) {
      const already = s.selection.includes(wire.id);
      if (e.ctrlKey || e.metaKey) {
        actions.select(already ? s.selection.filter((i) => i !== wire.id) : [...s.selection, wire.id]);
      } else if (!already) {
        actions.select([wire.id]);
      }
      drag.current = { mode: 'move', gx: snap(gx), gy: snap(gy), moved: false };
      return;
    }

    if (!e.ctrlKey && !e.metaKey) actions.select([]);
    drag.current = { mode: 'marquee', x1: gx, y1: gy, x2: gx, y2: gy };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [gx, gy] = gridAt(e);
    cursor.current = { gx: snap(gx), gy: snap(gy) };
    const s = getState();
    const d = drag.current;

    switch (d.mode) {
      case 'pan':
        cam.current.x = d.cx + (e.clientX - d.sx);
        cam.current.y = d.cy + (e.clientY - d.sy);
        return;
      case 'wire':
        drag.current = { ...d, x2: snap(gx), y2: snap(gy) };
        return;
      case 'marquee':
        drag.current = { ...d, x2: gx, y2: gy };
        return;
      case 'press': {
        // Dragging off the part means "move me", not "press me".
        const nx = snap(gx), ny = snap(gy);
        if (nx !== d.gx || ny !== d.gy) {
          if (d.momentary) actions.toggleComp(d.id, false);
          actions.moveSelection(nx - d.gx, ny - d.gy);
          drag.current = { mode: 'move', gx: nx, gy: ny, moved: true };
        }
        return;
      }
      case 'move': {
        const nx = snap(gx), ny = snap(gy);
        if (nx !== d.gx || ny !== d.gy) {
          actions.moveSelection(nx - d.gx, ny - d.gy);
          drag.current = { mode: 'move', gx: nx, gy: ny, moved: true };
        }
        return;
      }
      default: break;
    }

    const pin = hitPin(s.sch, gx, gy);
    const comp = pin ? null : hitComp(s.sch, gx, gy);
    hover.current = {
      comp: comp?.id ?? null,
      point: pin ? pinPositions(pin.comp)[pin.pin] : null,
    };
    setCursorStyle(
      s.placing ? 'copy'
        : s.tool === 'probe' ? 'crosshair'
          : pin || s.tool === 'wire' ? 'crosshair'
            : comp ? 'move' : 'default',
    );
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = { mode: 'none' };
    setCursorStyle('default');
    if (d.mode === 'wire') {
      commitWire(d.x1, d.y1, d.x2, d.y2);
    } else if (d.mode === 'press') {
      if (d.momentary) actions.toggleComp(d.id, false);
      else actions.toggleComp(d.id);
    } else if (d.mode === 'marquee') {
      const s = getState();
      const x0 = Math.min(d.x1, d.x2), x1 = Math.max(d.x1, d.x2);
      const y0 = Math.min(d.y1, d.y2), y1 = Math.max(d.y1, d.y2);
      if (Math.abs(x1 - x0) > 0.3 || Math.abs(y1 - y0) > 0.3) {
        const inside = (px: number, py: number) => px >= x0 && px <= x1 && py >= y0 && py <= y1;
        const ids: string[] = [];
        for (const c of s.sch.comps) if (inside(c.x, c.y)) ids.push(c.id);
        for (const w of s.sch.wires) if (inside(w.x1, w.y1) && inside(w.x2, w.y2)) ids.push(w.id);
        actions.select(e.ctrlKey || e.metaKey ? [...s.selection, ...ids] : ids);
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const [gx, gy] = toGrid(cam.current, mx, my);
    const g = Math.max(6, Math.min(70, cam.current.g * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    cam.current = { g, x: mx - gx * g, y: my - gy * g };
  };

  const err = runner.error;
  return (
    <div className="canvas-wrap">
      <canvas
        ref={ref}
        style={{ cursor: cursorStyle }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { hover.current = { comp: null, point: null }; cursor.current = null; }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      {err && <div className="banner">{err}</div>}
      <div className="hint">
        {st.placing
          ? <><b>{COMPONENTS[st.placing].name}</b> 배치 — 클릭해서 놓고, <kbd>R</kbd> 회전, <kbd>Shift</kbd>+클릭으로 연속 배치, <kbd>Esc</kbd> 취소</>
          : st.tool === 'wire'
            ? <>배선 모드 — 드래그해서 선을 그립니다. <kbd>Esc</kbd>로 선택 모드로</>
            : st.tool === 'probe'
              ? <>프로브 모드 — 선이나 핀을 클릭하면 전압, 소자 몸통을 클릭하면 전류를 스코프에 추가합니다</>
              : <>핀에서 <b>드래그</b>해 배선 · 소자 <b>드래그</b>로 이동 · <kbd>R</kbd> 회전 · <kbd>Shift</kbd>+클릭 프로브 · 휠 확대 · 우클릭 드래그 이동</>}
      </div>
    </div>
  );
}
