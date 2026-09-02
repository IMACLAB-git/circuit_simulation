import { useEffect, useState } from 'react';
import CanvasView from './CanvasView';
import Inspector from './Inspector';
import Palette from './Palette';
import Scope from './Scope';
import Toolbar from './Toolbar';
import { EXAMPLES } from '../examples';
import { runner, useStore } from '../store';
import { formatUnit } from '../util/si';

/** Bottom bar: simulation clock, step size, node count, solver health. */
function StatusBar() {
  const st = useStore();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 200);
    return () => window.clearInterval(id);
  }, []);

  const net = runner.net;
  const note = EXAMPLES.find((e) => e.id === st.exampleId)?.note;
  const nc = runner.sim.nonConverged;

  return (
    <footer className="status">
      <span>시간 <b>{formatUnit(runner.sim.t, 's')}</b></span>
      <span>스텝 <b>{formatUnit(runner.dt, 's')}</b></span>
      <span>노드 <b>{net?.nNodes ?? 0}</b> · 소자 <b>{net?.devices.length ?? 0}</b></span>
      <span>프레임당 <b>{runner.lastSteps}</b> 스텝</span>
      {nc > 0 && <span className="warn">근사 스텝 {nc}회</span>}
      {note && <span style={{ flex: 1, minWidth: 200 }}>{note}</span>}
    </footer>
  );
}

export default function App() {
  return (
    <div className="app">
      <Toolbar />
      <div className="body">
        <Palette />
        <CanvasView />
        <aside className="side">
          <Inspector />
          <Scope />
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}
