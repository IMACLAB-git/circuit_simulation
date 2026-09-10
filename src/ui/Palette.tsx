import { useEffect, useRef } from 'react';
import { COMPONENTS, PALETTE_GROUPS, defaultParams, type CompType } from '../model/components';
import { drawSymbol } from '../render/symbols';
import { actions, useStore } from '../store';
import { THEMES, type ThemeName } from '../theme';

const ICON = 30;

/** Draws one component symbol on a transparent square, scaled to fit. */
function Icon({ type, active, theme }: { type: CompType; active: boolean; theme: ThemeName }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = ICON * dpr;
    canvas.height = ICON * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ICON, ICON);
    const def = COMPONENTS[type];
    const span = Math.max(
      def.box[2] - def.box[0], def.box[3] - def.box[1],
      ...def.pins.map(([x, y]) => 2 * Math.max(Math.abs(x), Math.abs(y))),
    );
    const g = (ICON - 3) / Math.max(span, 2);
    const t = THEMES[theme];
    const colour = active ? t.iconOnAccent : t.iconBody;
    ctx.save();
    ctx.translate(ICON / 2, ICON / 2);
    drawSymbol(ctx, type, {
      g,
      body: colour,
      lead: def.pins.map(() => (active ? t.iconOnAccent : t.iconLead)),
      bg: 'transparent',
      params: defaultParams(type),
      glow: 0,
      ledOff: t.ledOff,
    });
    ctx.restore();
  }, [type, active, theme]);
  return <canvas ref={ref} style={{ width: ICON, height: ICON }} />;
}

export default function Palette() {
  const st = useStore();
  return (
    <aside className="palette">
      {PALETTE_GROUPS.map((group) => (
        <div key={group.title}>
          <h3>{group.title}</h3>
          {group.items.map((type) => (
            <button
              key={type}
              className={`pal-item${st.placing === type ? ' on' : ''}`}
              onClick={() => actions.startPlacing(st.placing === type ? null : type)}
              title={`${COMPONENTS[type].name} — 클릭한 뒤 회로판을 클릭해 배치`}
            >
              <Icon type={type} active={st.placing === type} theme={st.theme} />
              {COMPONENTS[type].name}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
