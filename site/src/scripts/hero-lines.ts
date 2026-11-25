/**
 * 从两个盘心射向屏幕两侧的紫色流线。
 *
 * 起点不是常量：three 每帧把盘心投影到屏幕坐标传进来，所以磁带轻轻转的时候
 * 线的根部跟着动。三条控制点各带一个相位，整束线像被风吹着。
 */

type Options = { animate: boolean };
type Hub = [number, number];

type Strand = {
  hub: 0 | 1;
  side: -1 | 1;
  dx: number;
  dy: number;
  endY: number;
  lift: number;
  bow: number;
  bow2: number;
  width: number;
  alpha: number;
  phase: number;
  speed: number;
  glow: boolean;
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function initLines(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  getOrigins: () => Hub[],
  opts: Options,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let w = 0;
  let h = 0;
  let strands: Strand[] = [];

  const make = () => {
    const rng = mulberry32(0x7a3f91c5);
    strands = [];
    for (let side of [-1, 1] as const) {
      const count = 36;
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        strands.push({
          hub: (side < 0 ? 0 : 1) as 0 | 1,
          side,
          dx: (rng() - 0.5) * 34,
          dy: (rng() - 0.5) * 26,
          // 出口高度：中间密、两头疏，避免整屏均匀铺开
          endY: 0.24 + Math.pow(rng(), 0.9) * 0.54,
          lift: (rng() - 0.5) * 0.38 + (t - 0.5) * 0.12,
          bow: (rng() - 0.5) * 0.46 + (t - 0.5) * 0.14,
          bow2: (rng() - 0.5) * 0.26,
          width: 0.6 + rng() * 1.05,
          alpha: 0.3 + rng() * 0.42,
          phase: rng() * Math.PI * 2,
          speed: 0.16 + rng() * 0.22,
          glow: i % 7 === 0,
        });
      }
    }
  };

  const resize = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    make();
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  let visible = true;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  }).observe(host);

  const hubs: Hub[] = [
    [w * 0.42, h * 0.47],
    [w * 0.58, h * 0.47],
  ];

  const stroke = (s: Strand, t: number, origin: Hub) => {
    const sx = origin[0] + s.dx;
    const sy = origin[1] + s.dy;
    const ex = s.side < 0 ? -60 : w + 60;
    const ey = s.endY * h + Math.sin(t * s.speed + s.phase) * h * 0.022;
    const c1x = sx + s.side * w * (0.14 + 0.04 * Math.sin(t * 0.2 + s.phase));
    const c1y = sy + s.lift * h * 0.06 + Math.cos(t * s.speed * 0.8 + s.phase) * 6;
    const c2x = ex - s.side * w * (0.26 + 0.05 * Math.cos(t * 0.14 + s.phase));
    const c2y = ey - s.lift * h * 0.55 + s.bow2 * h * 0.32 + Math.sin(t * s.speed * 1.1 + s.phase) * 12;

    const grad = ctx.createLinearGradient(sx, sy, ex, ey);
    grad.addColorStop(0, `rgba(74, 39, 202, ${s.alpha})`);
    grad.addColorStop(0.45, `rgba(122, 86, 238, ${s.alpha * 0.82})`);
    grad.addColorStop(1, 'rgba(186, 166, 250, 0)');

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey);
    ctx.strokeStyle = grad;
    ctx.lineWidth = s.width;
    if (s.glow) {
      ctx.shadowColor = 'rgba(108, 75, 236, 0.5)';
      ctx.shadowBlur = 8;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  };

  let frameId = 0;
  const start = performance.now();

  const frame = () => {
    frameId = requestAnimationFrame(frame);
    if (!visible) return;
    const t = opts.animate ? (performance.now() - start) / 1000 : 0;

    ctx.clearRect(0, 0, w, h);

    // 盘心的一团紫雾
    for (const [x, y] of hubs) {
      const halo = ctx.createRadialGradient(x, y, 0, x, y, Math.min(w, h) * 0.1);
      halo.addColorStop(0, 'rgba(104, 66, 232, 0.28)');
      halo.addColorStop(1, 'rgba(112, 76, 234, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(x - w * 0.15, y - h * 0.15, w * 0.3, h * 0.3);
    }

    // 先从 three 拿一次，避免 38 次回调
    const live = getOrigins();
    const a = live[0] ?? hubs[0];
    const b = live[1] ?? hubs[1];
    hubs[0] = [a[0], a[1]];
    hubs[1] = [b[0], b[1]];

    for (const s of strands) stroke(s, t, hubs[s.hub]);

    if (!opts.animate) cancelAnimationFrame(frameId);
  };

  if (opts.animate) {
    requestAnimationFrame(frame);
  } else {
    // 静态一帧也要等盘心第一次投影
    requestAnimationFrame(() => {
      const live = getOrigins();
      if (live[0]) hubs[0] = live[0];
      if (live[1]) hubs[1] = live[1];
      frame();
    });
  }
}
