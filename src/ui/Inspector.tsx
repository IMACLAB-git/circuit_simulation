import { useEffect, useState } from 'react';
import { COMPONENTS, type ParamSpec } from '../model/components';
import { pinPositions, type Comp } from '../model/schematic';
import { actions, runner, useStore } from '../store';
import { formatSI, formatUnit, parseSI } from '../util/si';

/** Maps a parameter value to a 0..1 slider position, log-scaled when asked. */
function toSlider(spec: ParamSpec, v: number): number {
  const min = spec.min ?? 0, max = spec.max ?? 1;
  if (spec.log) {
    const lo = Math.log10(Math.max(min, 1e-18)), hi = Math.log10(Math.max(max, 1e-18));
    return (Math.log10(Math.max(v, 1e-18)) - lo) / (hi - lo);
  }
  return (v - min) / (max - min);
}

function fromSlider(spec: ParamSpec, t: number): number {
  const min = spec.min ?? 0, max = spec.max ?? 1;
  if (spec.log) {
    const lo = Math.log10(Math.max(min, 1e-18)), hi = Math.log10(Math.max(max, 1e-18));
    const v = 10 ** (lo + t * (hi - lo));
    // Snap to 3 significant figures so dragging lands on readable values.
    const mag = 10 ** Math.floor(Math.log10(v));
    return Math.round((v / mag) * 100) / 100 * mag;
  }
  const v = min + t * (max - min);
  const step = (max - min) / 1000;
  return Math.round(v / step) * step;
}

function Field({ comp, spec }: { comp: Comp; spec: ParamSpec }) {
  const value = comp.params[spec.key] ?? spec.def;
  const [text, setText] = useState<string | null>(null);

  if (spec.kind === 'bool') {
    return (
      <div className="toggle-row">
        <button
          className={value > 0.5 ? 'on' : ''}
          onClick={() => actions.setParam(comp.id, spec.key, value > 0.5 ? 0 : 1)}
        >
          {spec.label}: {value > 0.5 ? 'ON' : 'OFF'}
        </button>
      </div>
    );
  }

  return (
    <div className="field">
      <div className="row">
        <label>{spec.label}</label>
        <span className="val">{formatUnit(value, spec.unit)}</span>
      </div>
      <input
        type="range" min={0} max={1} step={0.001}
        value={toSlider(spec, value)}
        onChange={(e) => actions.setParam(comp.id, spec.key, fromSlider(spec, Number(e.target.value)))}
      />
      <input
        type="text"
        value={text ?? formatSI(value, 4)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null) actions.setParam(comp.id, spec.key, parseSI(text, value));
          setText(null);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}

export default function Inspector() {
  const st = useStore();
  const [, tick] = useState(0);

  // Live readouts refresh on their own clock; the solver runs far faster than
  // anyone can read, and re-rendering React per frame would be wasteful.
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, []);

  if (st.selection.length === 0) {
    return (
      <div className="inspector">
        <div className="empty">
          소자를 클릭하면 여기서 값을 바꿀 수 있습니다. 시뮬레이션이 도는 중에도 슬라이더를
          움직이면 회로가 즉시 반응합니다.
          <br /><br />
          <kbd>R</kbd> 회전 · <kbd>Del</kbd> 삭제 · <kbd>Ctrl</kbd>+<kbd>Z</kbd> 되돌리기
          <br />
          <kbd>Space</kbd> 실행/일시정지 · <kbd>F</kbd> 화면 맞춤
          <br />
          <kbd>Shift</kbd>+클릭 프로브 · <kbd>W</kbd> 배선 · <kbd>P</kbd> 프로브 모드
        </div>
      </div>
    );
  }

  if (st.selection.length > 1) {
    return (
      <div className="inspector">
        <div className="insp-head"><span className="name">{st.selection.length}개 선택됨</span></div>
        <div className="insp-actions">
          <button onClick={actions.rotateSelection}>회전 (R)</button>
          <button onClick={actions.deleteSelection}>삭제 (Del)</button>
          <button onClick={() => actions.select([])}>선택 해제</button>
        </div>
      </div>
    );
  }

  const comp = st.sch.comps.find((c) => c.id === st.selection[0]);
  if (!comp) {
    return (
      <div className="inspector">
        <div className="insp-head"><span className="name">배선</span></div>
        <div className="insp-actions">
          <button onClick={actions.deleteSelection}>삭제 (Del)</button>
        </div>
      </div>
    );
  }

  const def = COMPONENTS[comp.type];
  const dev = runner.net?.deviceOf.get(comp.id);
  const pins = pinPositions(comp);

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="name">{comp.name || def.name}</span>
        <span className="type">{def.name}</span>
      </div>

      {dev && (
        <div className="readout">
          <div><span>전압</span><b>{formatUnit(dev.volt, 'V')}</b></div>
          <div><span>전류</span><b>{formatUnit(dev.cur, 'A')}</b></div>
          <div><span>전력</span><b>{formatUnit(Math.abs(dev.volt * dev.cur), 'W')}</b></div>
          <div>
            <span>{comp.type === 'led' ? '밝기' : '핀 전압'}</span>
            <b>
              {comp.type === 'led'
                ? `${Math.round(runner.ledBrightness(comp.id) * 100)}%`
                : formatUnit(runner.voltageAt(pins[0][0], pins[0][1]), 'V')}
            </b>
          </div>
        </div>
      )}

      {def.params.map((spec) => <Field key={spec.key} comp={comp} spec={spec} />)}

      <div className="insp-actions">
        <button onClick={actions.rotateSelection}>회전</button>
        <button onClick={() => actions.probeCurrent(comp.id)}>전류 프로브</button>
        {pins.map(([x, y], i) => (
          <button
            key={i}
            onClick={() => actions.probeNode(x, y, `${comp.name}.${def.pinNames[i]}`)}
            title={`${def.pinNames[i]} 핀의 전압을 스코프에 추가`}
          >
            {def.pinNames[i]} 전압
          </button>
        ))}
        <button onClick={actions.deleteSelection}>삭제</button>
      </div>
    </div>
  );
}
