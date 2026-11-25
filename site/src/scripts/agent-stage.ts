/**
 * Agent 舞台的编排。
 *
 * 全部由滚动进度 p 决定，没有时间轴：同一 p 必须得到同一帧（截图和回看都靠这条）。
 * 黑洞的着色器自己跑时间，那只影响纹理，不影响构图。
 */

type Hole = { setActive: (on: boolean) => void; setProgress: (p: number) => void };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function cubic(a: number, b: number, c: number, d: number, t: number) {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

export function initAgentStage(section: HTMLElement, stage: HTMLElement, hole: Hole) {
  const dialog = stage.querySelector<HTMLElement>('.ag-dialog');
  const holeEl = stage.querySelector<HTMLCanvasElement>('[data-agent-hole]');
  const chips = [...stage.querySelectorAll<HTMLElement>('[data-chip]')];
  const tips = [...stage.querySelectorAll<HTMLElement>('[data-tip]')];

  const svg = stage.querySelector<SVGSVGElement>('[data-agent-threads]');
  const ns = 'http://www.w3.org/2000/svg';

  const threads = chips.map(() => {
    const g = document.createElementNS(ns, 'g');
    const glow = document.createElementNS(ns, 'path');
    glow.setAttribute('class', 'ag-thread-glow');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('class', 'ag-thread');
    const dots = [0, 1].map(() => {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('class', 'ag-dot');
      c.setAttribute('r', '1.9');
      return c;
    });
    g.append(glow, path, ...dots);
    svg?.appendChild(g);
    return { g, glow, path, dots };
  });

  let lastP = -2;

  const apply = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;

    const rect = section.getBoundingClientRect();
    const total = section.offsetHeight - h;
    const p = total > 0 ? clamp01(-rect.top / total) : 0;
    if (Math.abs(p - lastP) < 0.0004) return;
    lastP = p;

    const near = rect.top < h && rect.bottom > 0;
    hole.setActive(near && p > 0.02);
    hole.setProgress(p);

    if (holeEl) {
      const on = smooth(0.04, 0.22, p) * (1 - smooth(0.9, 1, p));
      holeEl.style.opacity = on.toFixed(3);
      holeEl.style.transform = `translate(-50%, -50%) scale(${(0.8 + 0.2 * smooth(0.04, 0.32, p)).toFixed(3)})`;
    }

    // 对话框：从屏幕正中落到下方
    const e = smooth(0.16, 0.47, p);
    const dy = e * h * 0.25;
    if (dialog) {
      dialog.style.transform = `translate(-50%, -50%) translateY(${dy.toFixed(1)}px) scale(${(1 - e * 0.05).toFixed(3)})`;
    }

    const sx = w / 2;
    const sy = h / 2 + dy - 78;

    chips.forEach((el, i) => {
      const angle = (Number(el.dataset.angle) || 0) * (Math.PI / 180);
      const radius = Number(el.dataset.radius) || 1;
      const start = Number(el.dataset.start) || 0;
      const len = Number(el.dataset.len) || 0.26;
      const t = clamp01((p - start) / len);
      const alive = p > start - 0.04 && p < start + len + 0.04;

      const link = threads[i];
      const tip = tips[i];

      if (!alive) {
        el.style.opacity = '0';
        if (link) link.g.style.opacity = '0';
        if (tip) tip.style.opacity = '0';
        return;
      }

      const k = smooth(0.48, 1, t);
      const ox = Math.cos(angle) * w * 0.47 * radius;
      const oy = Math.sin(angle) * h * 0.33 * radius;
      const ix = Math.cos(angle) * w * 0.1 * radius;
      const iy = Math.sin(angle) * h * 0.06 * radius;
      const arc = Math.sin(t * Math.PI) * 16;
      const limit = w / 2 - el.offsetWidth / 2 - 16;
      const x = Math.max(-limit, Math.min(limit, lerp(ox, ix, k)));
      const y = lerp(oy, iy, k) + arc;
      const cx = sx + x;
      const cy = h / 2 + y;

      const fade = smooth(0, 0.14, t) * (1 - smooth(0.66, 0.9, t));
      el.style.opacity = fade.toFixed(3);
      el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${(1 - 0.48 * k).toFixed(3)}) rotate(${((i % 2 ? 1 : -1) * k * 5).toFixed(2)}deg)`;

      // 丝线：从输入框顶端出发，先在两侧绕出去再收进片段
      const dir = x < 0 ? -1 : 1;
      // 起点沿输入框上沿铺开，不然五根线会在同一点交汇成一个 V
      const startX = sx + (i - 2) * Math.min(66, w * 0.05);
      const c1x = startX + dir * w * 0.04;
      const c1y = sy - h * 0.15;
      const c2x = cx - dir * w * 0.08;
      const c2y = cy + h * 0.13;
      const d = `M${startX.toFixed(1)},${sy.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${cx.toFixed(1)},${cy.toFixed(1)}`;

      const lineAlpha = fade * 0.9;
      if (link) {
        link.g.style.opacity = lineAlpha.toFixed(3);
        link.path.setAttribute('d', d);
        link.glow.setAttribute('d', d);
        link.dots.forEach((dot, j) => {
          const u = (t * 1.9 + j * 0.5) % 1;
          dot.setAttribute('cx', cubic(startX, c1x, c2x, cx, u).toFixed(1));
          dot.setAttribute('cy', cubic(sy, c1y, c2y, cy, u).toFixed(1));
          dot.setAttribute('opacity', u > 0.08 ? '0.9' : '0');
        });
      }

      if (tip) {
        const px = Math.max(90, Math.min(w - 90, cubic(startX, c1x, c2x, cx, 0.68)));
        const py = cubic(sy, c1y, c2y, cy, 0.68);
        const tipFade = smooth(0.3, 0.44, t) * (1 - smooth(0.62, 0.82, t));
        tip.style.opacity = tipFade.toFixed(3);
        tip.style.textAlign = dir < 0 ? 'right' : 'left';
        tip.style.transform = `translate(-50%, -50%) translate(${(px - sx + dir * 34).toFixed(1)}px, ${(py - h / 2 - 8).toFixed(1)}px)`;
      }
    });
  };

  const tick = () => {
    requestAnimationFrame(tick);
    apply();
  };
  requestAnimationFrame(tick);

  // 首帧在图片/字体落位后可能尺寸不对，再补一次
  addEventListener('resize', () => {
    lastP = -2;
  });
  new ResizeObserver(() => {
    lastP = -2;
  }).observe(stage);

  apply();
}
