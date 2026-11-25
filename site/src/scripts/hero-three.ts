/**
 * 磁带。线框是主体，外壳只留一层几乎看不见的实体 —— 透明材质负责「描边之间
 * 有东西」，实心外壳会把内部线框全盖掉。
 *
 * 两个盘心的屏幕坐标每帧投影出去给 Canvas 流线用：流线是从盘心长出来的，
 * 不能在 2D 里猜位置。
 */
import * as THREE from 'three';

type Options = {
  onOrigins: (origins: [number, number][]) => void;
  animate: boolean;
};

const W = 108;
const H = 66;
const D = 8;

function roundRect(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function ringPoints(r: number, segs = 128) {
  const out: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    out.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
  }
  return out;
}

function rectPoints(w: number, h: number, r = 0) {
  const out: number[] = [];
  const x = -w / 2;
  const y = -h / 2;
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    out.push(ax, ay, 0, bx, by, 0);
  }
  return out;
}

export function initCassette(canvas: HTMLCanvasElement, host: HTMLElement, opts: Options) {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
  } catch {
    return;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 1200);
  camera.position.set(0, 0, 300);

  const css = (name: string, fallback: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const ink = () => new THREE.Color(css('--mk-fg', '#0d0b12'));
  const accent = () => new THREE.Color(css('--brand-2', '#6c4bec'));

  const root = new THREE.Group();
  root.rotation.set(-0.66, 0.19, -0.15);
  root.position.y = 3;
  scene.add(root);

  const thin: THREE.LineBasicMaterial[] = [];
  const fills: (THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial)[] = [];
  const textMats: THREE.MeshBasicMaterial[] = [];

  const lineMats: { m: THREE.LineBasicMaterial; base: number }[] = [];
  const lineMat = (opacity: number, color?: THREE.Color) => {
    const m = new THREE.LineBasicMaterial({
      color: color ?? ink(),
      transparent: true,
      opacity,
      depthWrite: false,
    });
    thin.push(m);
    lineMats.push({ m, base: opacity });
    return m;
  };

  const lines = (positions: number[], opacity: number, color?: THREE.Color, z = 0) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const obj = new THREE.LineSegments(geo, lineMat(opacity, color));
    obj.position.z = z;
    return obj;
  };

  /* --------------------------------------------------------------- 外壳 */
  const shellGeo = new THREE.ExtrudeGeometry(roundRect(W, H, 4), {
    depth: D,
    bevelEnabled: true,
    bevelThickness: 0.6,
    bevelSize: 0.6,
    bevelSegments: 2,
    curveSegments: 5,
  });
  shellGeo.translate(0, 0, -D / 2);

  const shellMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.06,
    roughness: 0.28,
    metalness: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  fills.push(shellMat);
  root.add(new THREE.Mesh(shellGeo, shellMat));

  root.add(new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo, 24), lineMat(0.8)));

  /* --------------------------------------------------------- 盘芯线框 */
  const zf = D / 2 + 0.9;
  const zb = -D / 2 - 0.9;

  const REEL_X = 23.5;

  function reel(cx: number, z: number, back: boolean) {
    const group = new THREE.Group();
    group.position.set(cx, -1, z);

    const pts: number[] = [];
    for (const r of [20.2, 18.4, 12.6, 6.3, 4.5]) pts.push(...ringPoints(r));
    // 辐条：内侧 6.3，外侧 18.4；每四根一根到外圈，密度错开才有转速感
    const n = 96;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (back ? 0.02 : 0);
      const r1 = i % 4 === 0 ? 19.4 : 17.6;
      pts.push(Math.cos(a) * 6.3, Math.sin(a) * 6.3, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0);
    }
    // 中心的六齿
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      pts.push(
        Math.cos(a) * 4.5,
        Math.sin(a) * 4.5,
        0,
        Math.cos(a + 0.14) * 6.6,
        Math.sin(a + 0.14) * 6.6,
        0,
      );
    }
    group.add(lines(pts, back ? 0.3 : 0.56));

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(19.6, 64),
      new THREE.MeshBasicMaterial({
        color: ink(),
        transparent: true,
        opacity: back ? 0.025 : 0.045,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    fills.push(disc.material as THREE.MeshBasicMaterial);
    group.add(disc);

    return group;
  }

  root.add(reel(-REEL_X, zf, false), reel(REEL_X, zf, false));
  root.add(reel(-REEL_X, zb, true), reel(REEL_X, zb, true));

  /* ------------------------------------------------------------ 走带 */
  const tape: number[] = [];
  const path: [number, number][] = [
    [-REEL_X - 18.6, -9],
    [-34.5, -18],
    [-33.5, -26],
    [-14, -27.5],
    [0, -29.5],
    [14, -27.5],
    [33.5, -26],
    [34.5, -18],
    [REEL_X + 18.6, -9],
  ];
  for (let i = 0; i < path.length - 1; i++) {
    tape.push(path[i][0], path[i][1], 0, path[i + 1][0], path[i + 1][1], 0);
  }
  root.add(lines(tape, 0.52, undefined, zf));

  for (const x of [-34, 34]) {
    root.add(lines(ringPoints(3.4, 40), 0.4, undefined, zf).translateX(x).translateY(-26));
  }

  /* ----------------------------------------------------------- 面板细节 */
  // 大窗
  const win = rectPoints(91, 43);
  const winObj = lines(win, 0.3, undefined, zf);
  winObj.position.y = 1;
  root.add(winObj);

  // 标签卡：三条横线 + 一条紫线
  const label = lines(rectPoints(52, 13), 0.36, undefined, zf);
  label.position.set(0, 25, 0);
  root.add(label);
  const labelLines: number[] = [];
  for (let i = 0; i < 3; i++) {
    const y = 28.4 - i * 2.4;
    labelLines.push(-22, y, 0, 22 - i * 5, y, 0);
  }
  root.add(lines(labelLines, 0.2, undefined, zf));
  const accentLine = lines([-19, 23.4, 0, 6, 23.4, 0], 0.55, accent(), zf);
  root.add(accentLine);

  // 底部三个开口
  for (const [x, w] of [
    [-24, 15],
    [0, 11],
    [24, 15],
  ] as [number, number][]) {
    const cut = lines(rectPoints(w, 5), 0.3, undefined, zf);
    cut.position.set(x, -28.4, 0);
    root.add(cut);
  }

  // 螺丝
  const screws = [
    [-48, 27],
    [48, 27],
    [-48, -27],
    [48, -27],
    [0, 28.5],
  ];
  for (const [x, y] of screws) {
    const screw = lines(ringPoints(1.7, 20), 0.42, undefined, zf);
    screw.position.set(x, y, 0);
    root.add(screw);
    const cross = lines([x - 1.2, y, 0, x + 1.2, y, 0, x, y - 1.2, 0, x, y + 1.2, 0], 0.38, undefined, zf);
    root.add(cross);
  }

  // 丝印：白字 + 材质色，主题切换只改材质，不重画
  const texCanvas = document.createElement('canvas');
  texCanvas.width = 512;
  texCanvas.height = 128;
  const tctx = texCanvas.getContext('2d');
  if (tctx) {
    tctx.clearRect(0, 0, 512, 128);
    tctx.fillStyle = '#ffffff';
    tctx.textBaseline = 'middle';
    tctx.font = '700 54px Outfit, Arial, sans-serif';
    tctx.fillText('ARTMATIC', 18, 52);
    tctx.font = '400 22px "JetBrains Mono", monospace';
    tctx.globalAlpha = 0.7;
    tctx.fillText('HIGH BIAS  ·  TYPE II', 20, 98);
  }
  const tex = new THREE.CanvasTexture(texCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const labelMat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.5,
    color: ink(),
    depthWrite: false,
  });
  textMats.push(labelMat);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(44, 11), labelMat);
  sign.position.set(0, 25, zf + 0.02);
  root.add(sign);

  /* --------------------------------------------------------- 盘心投影 */
  const markers = [-REEL_X, REEL_X].map((x) => {
    const o = new THREE.Object3D();
    o.position.set(x, -1, zf);
    root.add(o);
    return o;
  });
  const projected = new THREE.Vector3();

  /* --------------------------------------------------------------- 主题 */
  const paintTheme = () => {
    const c = ink();
    const dark = document.documentElement.dataset.theme === 'dark';
    for (const m of thin) m.color.copy(c);
    for (const m of fills) m.color.copy(c);
    for (const m of textMats) m.color.copy(c);
    // 亮色底上 1px 线不加不透明度就只是一层灰
    for (const { m, base } of lineMats) m.opacity = Math.min(1, base * (dark ? 1 : 1.4));
    accentLine.material.color.copy(accent());
  };
  paintTheme();
  new MutationObserver(paintTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  /* --------------------------------------------------------------- 尺寸 */
  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 竖屏时可见宽度只有 58 个单位，磁带要按宽高比退远，否则两边全被切掉
    root.scale.setScalar(Math.min(1, (w / h) * 1.2));
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  /* --------------------------------------------------------------- 渲染 */
  let visible = true;
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
    },
    { rootMargin: '120px' },
  ).observe(host);

  const pointer = { x: 0, y: 0 };
  host.addEventListener('pointermove', (event) => {
    const rect = host.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    pointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  });
  host.addEventListener('pointerleave', () => {
    pointer.x = 0;
    pointer.y = 0;
  });

  const start = performance.now();
  let eased = { x: 0, y: 0 };

  const frame = () => {
    requestAnimationFrame(frame);
    if (!visible) return;
    const t = opts.animate ? (performance.now() - start) / 1000 : 0;

    eased.x += (pointer.x - eased.x) * 0.06;
    eased.y += (pointer.y - eased.y) * 0.06;

    root.rotation.x = -0.66 + Math.sin(t * 0.17) * 0.016 + eased.y * 0.05;
    root.rotation.y = 0.2 + Math.sin(t * 0.11) * 0.03 + eased.x * 0.08;
    root.rotation.z = -0.15 + Math.sin(t * 0.22) * 0.012;
    root.position.y = 3 + Math.sin(t * 0.4) * 1.1;

    renderer.render(scene, camera);

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const origins: [number, number][] = markers.map((m) => {
      m.getWorldPosition(projected);
      projected.project(camera);
      return [(projected.x * 0.5 + 0.5) * w, (-projected.y * 0.5 + 0.5) * h];
    });
    opts.onOrigins(origins);
  };
  requestAnimationFrame(frame);
}
