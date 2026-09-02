import { useEffect, useRef, useState } from 'react';
import { EXAMPLES } from '../examples';
import { actions, runner, useStore } from '../store';
import { formatUnit } from '../util/si';

export default function Toolbar() {
  const st = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [full, setFull] = useState(false);

  // Worth having on its own, and necessary when the app is embedded in a small
  // iframe on someone else's page.
  useEffect(() => {
    const sync = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => { /* denied by the host page */ });
  };

  const download = () => {
    const blob = new Blob([actions.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `circuit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openFile = (file: File) => {
    file.text().then((text) => {
      const err = actions.loadJSON(text);
      if (err) window.alert(err);
    });
  };

  return (
    <header className="toolbar">
      <div className="brand">회로<span>랩</span></div>

      <button className={st.running ? 'on' : ''} onClick={actions.toggleRun} title="Space">
        {st.running ? '⏸ 일시정지' : '▶ 실행'}
      </button>
      <button onClick={actions.reset} title="시간을 0으로 되돌리고 모든 커패시터를 방전">
        ⟲ 초기화
      </button>
      <button
        onClick={actions.operatingPoint}
        title="충전 과도 구간을 건너뛰고 정상상태(DC 동작점)로 바로 이동"
      >
        ⚡ 동작점
      </button>

      <div className="sep" />

      <label className="slider" title="실제 1초에 흐르는 시뮬레이션 시간">
        속도
        <input
          type="range" min={-7} max={0.7} step={0.01}
          value={Math.log10(st.timeScale)}
          onChange={(e) => actions.setTimeScale(10 ** Number(e.target.value))}
        />
        <b style={{ minWidth: 62, display: 'inline-block' }}>
          {st.timeScale >= 1 ? `${st.timeScale.toFixed(1)}×` : `${formatUnit(st.timeScale, '×')}`}
        </b>
      </label>
      <button
        className="ghost"
        onClick={() => actions.setTimeScale(runner.suggestTimeScale())}
        title="회로의 가장 빠른 신호에 맞춰 속도를 자동으로 맞춥니다"
      >
        자동
      </button>

      <div className="sep" />

      <button className={st.tool === 'wire' ? 'on' : ''} onClick={() => actions.setTool(st.tool === 'wire' ? 'select' : 'wire')} title="W">
        배선
      </button>
      <button className={st.tool === 'probe' ? 'on' : ''} onClick={() => actions.setTool(st.tool === 'probe' ? 'select' : 'probe')} title="P">
        프로브
      </button>
      <button onClick={actions.undo} title="Ctrl+Z">되돌리기</button>
      <button onClick={actions.fitView} title="F">화면 맞춤</button>

      <div className="sep" />

      <button className={st.showVoltage ? 'on' : ''} onClick={() => actions.setShow({ showVoltage: !st.showVoltage })}>
        전압
      </button>
      <button className={st.showCurrent ? 'on' : ''} onClick={() => actions.setShow({ showCurrent: !st.showCurrent })}>
        전류
      </button>
      <button className={st.showLabels ? 'on' : ''} onClick={() => actions.setShow({ showLabels: !st.showLabels })}>
        라벨
      </button>
      {!st.scopeOpen && <button onClick={() => actions.setScopeOpen(true)}>스코프</button>}

      <div className="spacer" />

      <select
        value={st.exampleId ?? ''}
        onChange={(e) => e.target.value && actions.loadExample(e.target.value)}
      >
        <option value="">예제 회로 불러오기…</option>
        {EXAMPLES.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
      </select>
      <button onClick={download} title="회로를 JSON 파일로 저장">저장</button>
      <button onClick={() => fileRef.current?.click()}>열기</button>
      <input
        ref={fileRef} type="file" accept="application/json,.json" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }}
      />
      <button
        onClick={() => { if (window.confirm('회로를 모두 지울까요?')) actions.clearAll(); }}
      >
        새 회로
      </button>
      <button onClick={toggleFullscreen} title="전체화면 전환">
        {full ? '⤡ 창으로' : '⤢ 전체화면'}
      </button>
    </header>
  );
}
