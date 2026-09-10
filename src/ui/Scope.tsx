import { useEffect, useRef, useState } from 'react';
import { actions, getState, runner, useStore } from '../store';
import { THEMES, probeColor } from '../theme';
import { formatSI, formatUnit } from '../util/si';

const HEIGHT = 190;

/**
 * Rolling oscilloscope.
 *
 * Traces are drawn straight from the runner's ring buffers each frame; the
 * vertical scale auto-ranges over the visible window so a 5 V rail and a 50 mV
 * signal are both readable without a manual gain control.
 */
export default function Scope() {
  const st = useStore();
  const ref = useRef<HTMLCanvasElement>(null);
  const [values, setValues] = useState<number[]>([]);

  // Re-arm whenever the panel is shown: closing it unmounts the canvas, so a
  // loop started for the previous one would keep painting a detached element
  // and the reopened scope would sit blank.
  useEffect(() => {
    if (!st.scopeOpen) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let lastRead = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(HEIGHT * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(HEIGHT * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, HEIGHT);
      const theme = THEMES[getState().theme];

      const n = runner.scopeCount;
      const len = runner.scopeT.length;
      const head = runner.scopeHead;
      const probes = runner.probes;

      // Grid.
      ctx.strokeStyle = theme.scopeGrid;
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (HEIGHT * i) / 4;
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
      }
      for (let i = 1; i < 8; i++) {
        const x = (w * i) / 8;
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, HEIGHT); ctx.stroke();
      }

      if (probes.length === 0 || n < 2) return;

      // Auto range across every trace in the window, kept symmetric about zero
      // when the signal straddles it so the zero line stays meaningful.
      let lo = Infinity, hi = -Infinity;
      for (let p = 0; p < probes.length; p++) {
        const buf = runner.scopeV[p];
        for (let i = 0; i < n; i++) {
          const v = buf[(head - n + i + len) % len];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!isFinite(lo)) return;
      const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 1e-3, 1e-9);
      lo -= pad; hi += pad;
      if (lo > 0 && lo < (hi - lo) * 0.5) lo = 0;
      if (hi < 0 && -hi < (hi - lo) * 0.5) hi = 0;

      const yOf = (v: number) => HEIGHT - ((v - lo) / (hi - lo)) * HEIGHT;

      if (lo < 0 && hi > 0) {
        ctx.strokeStyle = theme.scopeZero;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, yOf(0)); ctx.lineTo(w, yOf(0)); ctx.stroke();
        ctx.setLineDash([]);
      }

      for (let p = 0; p < probes.length; p++) {
        const buf = runner.scopeV[p];
        ctx.strokeStyle = probeColor(theme, p);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const v = buf[(head - n + i + len) % len];
          const x = (i / (len - 1)) * w;
          const y = yOf(v);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Vertical scale labels.
      ctx.fillStyle = theme.scopeLabel;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(formatSI(hi, 3), 4, 3);
      ctx.textBaseline = 'bottom';
      ctx.fillText(formatSI(lo, 3), 4, HEIGHT - 3);

      if (now - lastRead > 120) {
        lastRead = now;
        const last = (head - 1 + len) % len;
        setValues(runner.scopeV.map((b) => b[last]));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [st.scopeOpen]);

  if (!st.scopeOpen) return null;

  return (
    <div className="scope">
      <header>
        오실로스코프
        <span className="spacer" />
        {runner.probes.length > 0 && <button onClick={actions.clearProbes}>지우기</button>}
        <button onClick={() => actions.setScopeOpen(false)}>닫기</button>
      </header>
      <canvas ref={ref} />
      {runner.probes.length === 0 ? (
        <div className="none">
          회로에서 <kbd>Shift</kbd>+클릭하면 그 지점의 전압이, 소자를 <kbd>Shift</kbd>+클릭하면
          전류가 여기 그려집니다.
        </div>
      ) : (
        <>
          <div className="legend">
            {runner.probes.map((p, i) => (
              <div key={p.id}>
                <i style={{ background: probeColor(THEMES[st.theme], i) }} />
                {p.label}{' '}
                <span>{formatUnit(values[i] ?? 0, p.kind === 'v' ? 'V' : 'A')}</span>
              </div>
            ))}
          </div>
          <div className="tb">
            <span>가로축 {formatUnit(st.timebase, 's')}</span>
            <input
              type="range" min={-4} max={1} step={0.05}
              value={Math.log10(st.timebase)}
              onChange={(e) => actions.setTimebase(10 ** Number(e.target.value))}
            />
          </div>
        </>
      )}
    </div>
  );
}
