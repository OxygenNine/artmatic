/*
 * 3D 格式化（three 版，`extrude-material-three`）。
 *
 * 一张图 → 轮廓（marching squares）→ 真的挤出几何体（ExtrudeGeometry + 倒角）
 * → 影棚环境贴图下的物理材质。上一版（`extrude-material.ts`）走的是 SDF
 * 光线步进，形体是着色算出来的；这一版交给 three：
 *
 * | 上一版 | 这一版 |
 * |---|---|
 * | SDF 求交，倒角是距离场的等值面 | 真三角形，倒角是几何 |
 * | 自带一套金属度着色，环境是解析函数 | 真 PBR（metalness / clearcoat / iridescence / sheen） |
 * | 没有阴影 | 有投影灯与接影地面 |
 * | 玻璃靠 alpha 假装 | 真透明混合 + 强环境反射 |
 *
 * ## 轮廓为什么要追踪
 *
 * 挤出的前提是「形状」，而素材是一张位图。`drawImage` 到一个 ≤384 px 的画布上
 * 取 alpha（没有 alpha 就按亮度反推墨色），二值化之后走一遍 marching squares，
 * 得到一串闭合折线（边界是像素中心场的 0.5 等值线，整体内缩半个像素）。
 * 再按面积分层：偶数层是实体，奇数层是洞 —— 于是「O」「8」「回」这类图形
 * 挤出之后真的是镂空的。
 *
 * ## 为什么在 update 里重建几何
 *
 * 素材是**异步解码**的：`create` 那一刻 `ctx.texture()` 常常还是 null。这一版
 * 不把「占位轮廓」写死到场景里，而是每帧比较一次纹理身份（缓存命中时是个
 * 常数，没有成本），换了就重新追踪。于是「选图 → 几百毫秒后图自己长出来」
 * 这条路径不需要任何额外接线。
 *
 * 这个文件是 raw 文本（`?raw` 导入），不参与 TS 编译：它会被 `new Function`
 * 执行，与片段里手写的内容同一形态（契约见 src/three/code.ts）。
 */

function params() {
  return [
    { key: 'logoAsset', type: 'asset', label: '轮廓素材', defaultValue: '' },
    {
      key: 'material',
      type: 'select',
      label: '材质',
      defaultValue: 'polished',
      options: [
        { value: 'polished', label: '镜面金属' },
        { value: 'brushed', label: '磨砂金属' },
        { value: 'holo', label: '虹彩' },
        { value: 'glass', label: '磨砂玻璃' },
        { value: 'ceramic', label: '陶瓷' },
        { value: 'velvet', label: '丝绒' },
      ],
    },
    { key: 'color', type: 'color', label: '面色', defaultValue: '#dfe6f2' },
    { key: 'depth', type: 'range', label: '厚度', min: 0.04, max: 0.7, step: 0.01, defaultValue: 0.22 },
    { key: 'bevel', type: 'range', label: '倒角', min: 0, max: 0.12, step: 0.005, defaultValue: 0.03 },
    { key: 'detail', type: 'range', label: '轮廓精度', min: 64, max: 384, step: 32, defaultValue: 224, rebuild: true },
    { key: 'gloss', type: 'range', label: '光泽', min: 0, max: 1, step: 0.01, defaultValue: 0.72 },
    { key: 'env', type: 'range', label: '环境反射', min: 0, max: 2.5, step: 0.01, defaultValue: 1 },
    { key: 'rim', type: 'range', label: '边缘光', min: 0, max: 2, step: 0.01, defaultValue: 0.75 },
    { key: 'rimCol', type: 'color', label: '边缘光颜色', defaultValue: '#7fd8ff' },
    { key: 'spin', type: 'range', label: '自转（圈/秒）', min: -0.5, max: 0.5, step: 0.01, defaultValue: 0.05 },
    { key: 'bob', type: 'range', label: '浮动', min: 0, max: 1, step: 0.01, defaultValue: 0.3 },
    { key: 'yaw', type: 'range', label: '初始方位角', min: -180, max: 180, step: 1, defaultValue: -26 },
    { key: 'pitch', type: 'range', label: '俯角', min: -8, max: 60, step: 1, defaultValue: 14 },
    { key: 'dist', type: 'range', label: '机位距离', min: 2.2, max: 9, step: 0.05, defaultValue: 5.4 },
    { key: 'fov', type: 'range', label: '视角', min: 18, max: 70, step: 1, defaultValue: 32 },
    { key: 'shadow', type: 'range', label: '接触阴影', min: 0, max: 1, step: 0.01, defaultValue: 0.55 },
    {
      key: 'bgMode',
      type: 'select',
      label: '背景',
      defaultValue: 'solid',
      options: [
        { value: 'solid', label: '纯色' },
        { value: 'transparent', label: '透明' },
      ],
    },
    { key: 'bg', type: 'color', label: '背景底色', defaultValue: '#070a10' },
    { key: 'bgTop', type: 'color', label: '背景顶色', defaultValue: '#2b3a55' },
  ];
}

/* ------------------------------------------------------------- 小工具 */

function num(p, k, d) {
  const v = p[k];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/* --------------------------------------------------------- 轮廓追踪 */

/**
 * 位图 → 闭合折线（像素坐标，第 0 行是图像顶部）。
 *
 * `detail` 是长边像素数。它决定**台阶的尺寸**：二值化的边界天生是 1 px 的
 * 锯齿，追踪分辨率越低，台阶在归一化之后（内容固定 2 世界单位）就越大。
 * 实测 160 时 A 的斜画面上能看出一排缺口，224 加两轮平滑之后基本消失。
 * 再往上收益递减（384 只是把同一段斜线切成更多段）。
 */
function traceImage(img, detail) {
  const iw = Number(img.width) || 1;
  const ih = Number(img.height) || 1;
  const long = Math.max(24, Math.round(detail));
  const ar = iw / ih;
  const w = Math.max(8, Math.round(ar >= 1 ? long : long * ar));
  const h = Math.max(8, Math.round(ar >= 1 ? long / ar : long));

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  if (!c) return [];
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.clearRect(0, 0, w, h);
  c.drawImage(img, 0, 0, w, h);
  const rgba = c.getImageData(0, 0, w, h).data;

  /*
   * 与 `algos/logo-sdf.ts::alphaFromRgba` 同一套启发：有透明像素就用 alpha
   * （图标 / 贴纸），否则按亮度反推墨色（白底黑字的海报 / 扫描件）。
   * 两边各写一份是不得已 —— 这段代码是 `new Function` 执行的 raw 文本，
   * 没有 import 可用。
   */
  const n = w * h;
  let translucent = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) translucent += 1;

  const mask = new Uint8Array(n);
  if (translucent > n * 0.01) {
    for (let i = 0; i < n; i += 1) mask[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  } else {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const l = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
      mask[i] = l;
      sum += l;
    }
    const inkDark = sum / n > 128;
    for (let i = 0; i < n; i += 1) mask[i] = (mask[i] < 128) === inkDark ? 1 : 0;
  }

  const loops = traceMask(mask, w, h);
  const out = [];
  for (let i = 0; i < loops.length; i += 1) {
    /*
     * 先平滑再简化。二值掩码的边界是像素格点，斜边天生是台阶（A 的斜画面上
     * 是一排锯齿）；RDP 会把每个台阶当拐点保留下来，倒角高光把它们逐个点亮。
     * 两轮 [1,2,1] 之后台阶被抹成斜线，直线仍是直线。
     */
    const simp = rdpClosed(smoothLoop(loops[i], 2), 0.55);
    if (simp.length < 3) continue;
    if (Math.abs(polyArea(simp)) < 1.6) continue; // 1~2 像素的噪点
    out.push(simp);
  }
  return out;
}

/**
 * 二值掩码 → 闭合折线。
 *
 * 边界走的是「像素中心场」的 0.5 等值线：跨过一条边时取它的中点。所以整条
 * 轮廓比填色区域**内缩半个像素**，90° 直角还会被切掉一个 0.5×0.5 的角
 * （四个角合计 0.5 px²）。224 px 的追踪分辨率下这是 0.2% 的偏差，倒角与
 * 平滑之后不可见；但别拿它当「像素级精确」的轮廓 —— 单像素宽的笔画会被它
 * 吃掉。
 *
 * 16 个 case 按「哪两条边的中点相连」逐个写死，不做查表：查表错一位的表现是
 * 轮廓在某个拐角处镜像，肉眼极难发现。
 */
function traceMask(mask, w, h) {
  const pw = w + 2;
  const ph = h + 2;
  const m = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y += 1) {
    const src = y * w;
    const dst = (y + 1) * pw + 1;
    for (let x = 0; x < w; x += 1) m[dst + x] = mask[src + x];
  }
  const at = (x, y) => m[x + y * pw];

  const hBase = ph * pw;
  const H = (x, y) => y * pw + x;
  const V = (x, y) => hBase + x * ph + y;
  const segs = [];

  for (let y = 0; y < ph - 1; y += 1) {
    for (let x = 0; x < pw - 1; x += 1) {
      const a = at(x, y);
      const b = at(x + 1, y);
      const c = at(x + 1, y + 1);
      const d = at(x, y + 1);
      if (a === b && b === c && c === d) continue;
      const code = a | (b << 1) | (c << 2) | (d << 3);
      const top = H(x, y);
      const right = V(x + 1, y);
      const bottom = H(x, y + 1);
      const left = V(x, y);
      switch (code) {
        case 1:
        case 14:
          segs.push([top, left]);
          break;
        case 2:
        case 13:
          segs.push([top, right]);
          break;
        case 3:
        case 12:
          segs.push([left, right]);
          break;
        case 4:
        case 11:
          segs.push([right, bottom]);
          break;
        case 6:
        case 9:
          segs.push([top, bottom]);
          break;
        case 7:
        case 8:
          segs.push([left, bottom]);
          break;
        /* 鞍点：两个对角各成一个小岛。合成一条会得到自交的折线（earcut 会
           在这条线上打洞），所以在中心处分成两段。 */
        case 5:
        case 10:
          segs.push([top, right]);
          segs.push([bottom, left]);
          break;
        default:
          break;
      }
    }
  }

  const byEdge = new Map();
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    for (let k = 0; k < 2; k += 1) {
      const e = s[k];
      let list = byEdge.get(e);
      if (!list) {
        list = [];
        byEdge.set(e, list);
      }
      list.push(i);
    }
  }

  const used = new Uint8Array(segs.length);
  const loops = [];
  const pointOf = (id) => {
    if (id < hBase) {
      const y = (id / pw) | 0;
      return [id - y * pw + 0.5, y];
    }
    const j = id - hBase;
    const x = (j / ph) | 0;
    return [x, j - x * ph + 0.5];
  };

  for (let i = 0; i < segs.length; i += 1) {
    if (used[i]) continue;
    used[i] = 1;
    const start = segs[i][0];
    let cur = segs[i][1];
    const chain = [start, cur];
    let closed = false;
    let guard = 0;
    while (guard < 200000) {
      guard += 1;
      if (cur === start) {
        closed = true;
        break;
      }
      const list = byEdge.get(cur);
      if (!list) break;
      let next = -1;
      for (let k = 0; k < list.length; k += 1) {
        if (!used[list[k]]) {
          next = list[k];
          break;
        }
      }
      if (next < 0) break;
      used[next] = 1;
      const s = segs[next];
      cur = s[0] === cur ? s[1] : s[0];
      chain.push(cur);
    }
    if (!closed) continue;
    chain.pop();
    if (chain.length < 3) continue;
    const pts = new Array(chain.length);
    for (let k = 0; k < chain.length; k += 1) {
      const p = pointOf(chain[k]);
      pts[k] = [p[0] - 1, p[1] - 1];
    }
    loops.push(pts);
  }
  return loops;
}

function smoothLoop(pts, iterations) {
  let cur = pts;
  const n0 = pts.length;
  for (let it = 0; it < iterations; it += 1) {
    const next = new Array(n0);
    for (let i = 0; i < n0; i += 1) {
      const a = cur[(i + n0 - 1) % n0];
      const b = cur[i];
      const c = cur[(i + 1) % n0];
      next[i] = [(a[0] + 2 * b[0] + c[0]) * 0.25, (a[1] + 2 * b[1] + c[1]) * 0.25];
    }
    cur = next;
  }
  return cur;
}

function rdpOpen(pts, eps) {
  const n = pts.length;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const seg = stack.pop();
    const a = seg[0];
    const b = seg[1];
    if (b - a < 2) continue;
    const ax = pts[a][0];
    const ay = pts[a][1];
    const dx = pts[b][0] - ax;
    const dy = pts[b][1] - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let best = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i += 1) {
      const px = pts[i][0] - ax;
      const py = pts[i][1] - ay;
      let t = (px * dx + py * dy) / len2;
      t = clamp(t, 0, 1);
      const ex = px - dx * t;
      const ey = py - dy * t;
      const d = ex * ex + ey * ey;
      if (d > best) {
        best = d;
        idx = i;
      }
    }
    if (idx >= 0 && best > eps2) {
      keep[idx] = 1;
      stack.push([a, idx]);
      stack.push([idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(pts[i]);
  return out;
}

/** 闭合折线的 RDP：从最远点对折成两条开放折线，分别简化再拼回去。 */
function rdpClosed(pts, eps) {
  const n = pts.length;
  if (n < 6) return pts;
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i += 1) {
    const dx = pts[i][0] - pts[0][0];
    const dy = pts[i][1] - pts[0][1];
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  if (far < 1) return pts;
  const a = rdpOpen(pts.slice(0, far + 1), eps);
  const b = rdpOpen(pts.slice(far).concat([pts[0]]), eps);
  return a.concat(b.slice(1, -1));
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    s += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  }
  return s * 0.5;
}

function pointInPoly(pt, poly) {
  let inside = false;
  const x = pt[0];
  const y = pt[1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 折线（像素坐标，y 向下）→ `THREE.Shape[]`（世界坐标，y 向上，最长边 2）。
 *
 * 按**面积降序 + 包含关系**分深度：偶数深度是实体，奇数深度是洞。朝向必须
 * 归一化（实体逆时针、洞顺时针）—— earcut 不在乎，但侧壁的三角形是照着点序
 * 生成的，朝向反了就是「从外面看不见侧壁」，倒角上会出现一圈空洞。
 */
function shapesFromLoops(THREE, loops) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < loops.length; i += 1) {
    const pts = loops[i];
    for (let k = 0; k < pts.length; k += 1) {
      const p = pts[k];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  if (!Number.isFinite(minX)) return [];
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const s = 2 / span;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;

  const items = [];
  for (let i = 0; i < loops.length; i += 1) {
    const src = loops[i];
    const pts = new Array(src.length);
    for (let k = 0; k < src.length; k += 1) {
      pts[k] = [(src[k][0] - cx) * s, (cy - src[k][1]) * s];
    }
    const area = Math.abs(polyArea(pts));
    if (area > 1e-6) items.push({ pts: pts, area: area, depth: 0, parent: -1 });
  }
  items.sort((a, b) => b.area - a.area);

  for (let i = 1; i < items.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (pointInPoly(items[i].pts[0], items[j].pts)) {
        items[i].parent = j;
        items[i].depth = items[j].depth + 1;
      }
    }
  }

  const shapes = [];
  const shapeOf = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.depth % 2 === 1) continue;
    const pts = polyArea(it.pts) > 0 ? it.pts : it.pts.slice().reverse();
    const vecs = new Array(pts.length);
    for (let k = 0; k < pts.length; k += 1) vecs[k] = new THREE.Vector2(pts[k][0], pts[k][1]);
    const shape = new THREE.Shape(vecs);
    shapes.push(shape);
    shapeOf.set(i, shape);
  }
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.depth % 2 === 0) continue;
    const host = shapeOf.get(it.parent);
    if (!host) continue;
    const pts = polyArea(it.pts) < 0 ? it.pts : it.pts.slice().reverse();
    const vecs = new Array(pts.length);
    for (let k = 0; k < pts.length; k += 1) vecs[k] = new THREE.Vector2(pts[k][0], pts[k][1]);
    host.holes.push(new THREE.Path(vecs));
  }
  return shapes;
}

/* --------------------------------------------------------- 占位图形 */

/**
 * 没绑素材时的轮廓：圆角方牌 + 镂空圆环 + 四角星。
 *
 * 三层深度（实体 / 洞 / 实体）是刻意的：它一眼就把「这一版有真的几何」说清楚
 * —— 洞的边缘有厚度、星形能看见倒角，缩略图里也认得出这是个立体件。
 */
function emblemLoops() {
  const out = [];

  const hw = 0.94;
  const r = 0.26;
  const seg = 6;
  const corners = [
    [hw - r, hw - r, 0],
    [-(hw - r), hw - r, Math.PI * 0.5],
    [-(hw - r), -(hw - r), Math.PI],
    [hw - r, -(hw - r), Math.PI * 1.5],
  ];
  const frame = [];
  for (let i = 0; i < corners.length; i += 1) {
    const c = corners[i];
    for (let k = 0; k <= seg; k += 1) {
      const a = c[2] + (k / seg) * Math.PI * 0.5;
      frame.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
    }
  }
  out.push(frame);

  const ring = [];
  const ringR = 0.62;
  for (let i = 0; i < 64; i += 1) {
    const a = (i / 64) * Math.PI * 2;
    ring.push([Math.cos(a) * ringR, Math.sin(a) * ringR]);
  }
  out.push(ring);

  const star = [];
  for (let i = 0; i < 8; i += 1) {
    const a = Math.PI * 0.5 + (i / 8) * Math.PI * 2;
    const rad = i % 2 === 0 ? 0.47 : 0.155;
    star.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  out.push(star);

  return out;
}

/* --------------------------------------------------------------- 材质 */

/**
 * 材质预设：**面向同一块几何体的六种表面**，不是六种颜色（面色是参数）。
 *
 * `tune` 里只有两个量会随后续滑杆变化：粗糙度区间与环境倍率。其余（金属度、
 * 清漆、虹彩、绒毛）是预设的常数 —— 它们决定「这是什么材料」，动它们等于
 * 换了一种材质。
 */
function makeMaterial(THREE, kind, envTex) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
  /*
   * 环境贴图必须**同时**挂在材质上，不能只靠 `scene.environment`：
   * three 的 `refreshUniformsStandard` 只在 `material.envMap` 非空时才刷新
   * `envMapIntensity`（`WebGLMaterials.js`）。只设 scene.environment 的话，
   * 强度停在材质创建时那个 1 —— 滑杆拖到 20 画面一点变化都没有（实测）。
   */
  if (envTex) m.envMap = envTex;
  m.userData.tune = { lo: 0.05, hi: 0.4, env: 1.1 };

  if (kind === 'brushed') {
    m.metalness = 1;
    m.userData.tune = { lo: 0.26, hi: 0.62, env: 0.95 };
  } else if (kind === 'holo') {
    /*
     * 虹彩（薄膜干涉）只作用在**反射**上，底色一白就把它冲没了（实测：
     * metalness 0.9 + 白底时看不出任何颜色）。所以这一档把面色压到 35%，
     * 让干涉色成为画面的主体。
     */
    m.metalness = 0.75;
    m.roughness = 0.09;
    m.iridescence = 1;
    m.iridescenceIOR = 2.1;
    // r187 起 `iridescenceThicknessRange` 已废弃（写了会被忽略并打 warning）
    m.iridescenceThicknessMinimum = 260;
    m.iridescenceThicknessMaximum = 1100;
    m.clearcoat = 1;
    m.clearcoatRoughness = 0.04;
    m.userData.tune = { lo: 0.04, hi: 0.26, env: 1.35 };
  } else if (kind === 'glass') {
    /*
     * 磨砂玻璃。**不用 `transmission`**：深色背景上它只会把背景折进来，画面
     * 读作「一块深蓝色的塑料」（实测两版都是）—— 没有亮东西可透的时候，
     * 玻璃的形体只能靠反射与体积感给。所以走「半透明白 + 强环境反射 +
     * 双面渲染（背壁透出来）」，代价是它更像磨砂水晶而不是光学玻璃。
     */
    m.metalness = 0;
    m.roughness = 0.12;
    m.ior = 1.52;
    m.clearcoat = 1;
    m.clearcoatRoughness = 0.04;
    m.transparent = true;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    m.userData.tune = { lo: 0.08, hi: 0.3, env: 2.4 };
  } else if (kind === 'ceramic') {
    m.metalness = 0;
    m.clearcoat = 1;
    m.clearcoatRoughness = 0.06;
    m.userData.tune = { lo: 0.16, hi: 0.62, env: 0.9 };
  } else if (kind === 'velvet') {
    m.metalness = 0;
    m.sheen = 1;
    m.sheenRoughness = 0.4;
    m.sheenColor = new THREE.Color(0xffffff);
    m.userData.tune = { lo: 0.72, hi: 0.98, env: 0.55 };
  } else {
    m.metalness = 1;
    m.clearcoat = 1;
    m.clearcoatRoughness = 0.03;
    m.userData.tune = { lo: 0.02, hi: 0.3, env: 1.5 };
  }
  return m;
}

/* ------------------------------------------------------------- 环境贴图 */

/** 等距柱状的环境球：竖直渐变 + 三块柔光箱。金属的形体全靠它。 */
function makeEnvTexture(THREE) {
  const W = 512;
  const H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  if (!c) return null;

  const sky = c.createLinearGradient(0, 0, 0, H);
  /*
   * 竖渐变是**唯一能过 PMREM** 的结构：默认粗糙度约 0.1，卷积核有十几度，
   * 三像素的白线会被直接抹平（实测：写了一条地平线，画面上什么都没有）。
   * 所以反差全部做在「带宽足够」的渐变段上 —— 正面就是一块被上明下暗照着的
   * 金属板，倒角再各自去接顶光。
   */
  sky.addColorStop(0, '#0e1116');
  sky.addColorStop(0.3, '#2a3446');
  sky.addColorStop(0.4, '#f6faff');
  sky.addColorStop(0.47, '#cfdbec');
  sky.addColorStop(0.54, '#97a6bb');
  sky.addColorStop(0.62, '#68768b');
  sky.addColorStop(0.72, '#39414f');
  sky.addColorStop(0.86, '#1b2029');
  sky.addColorStop(1, '#0b0e13');
  c.fillStyle = sky;
  c.fillRect(0, 0, W, H);

  const box = (cx, cy, rw, rh, tint, strength) => {
    const r = Math.max(rw, rh);
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.translate(cx, cy);
    c.scale(rw / r, rh / r);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, tint.replace('{a}', String(strength)));
    g.addColorStop(0.45, tint.replace('{a}', String(strength * 0.45)));
    g.addColorStop(1, tint.replace('{a}', '0'));
    c.fillStyle = g;
    c.fillRect(-r * 2, -r * 2, r * 4, r * 4);
    c.restore();
  };

  /*
   * 顶部两块柔光箱 + 地面一块反光池。它们照的是**倒角与侧壁**（法线转过 90°，
   * 采样的纬度远离地平线）；正面那块大平面的明暗由上面的竖渐变负责。
   */
  box(W * 0.16, H * 0.16, W * 0.18, H * 0.1, 'rgba(255,246,232,{a})', 1);
  box(W * 0.62, H * 0.2, W * 0.16, H * 0.09, 'rgba(160,200,255,{a})', 0.7);
  box(W * 0.72, H * 0.64, W * 0.26, H * 0.14, 'rgba(196,212,238,{a})', 0.35);

  const tex = new THREE.Texture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
varying vec3 vDir;
uniform vec3 uTop;
uniform vec3 uLow;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uLow, uTop, smoothstep(0.04, 0.82, h));
  /* 物体背后的一团柔光：让深色背景不是一块死板，也给轮廓一圈分离度 */
  float glow = pow(clamp(dot(d, normalize(vec3(0.0, 0.04, -1.0))), 0.0, 1.0), 4.0);
  col += vec3(0.085, 0.105, 0.155) * glow;
  /* 按方向的暗角（不是按屏幕）：换焦距时不会跟着变形 */
  col *= 1.0 - 0.32 * pow(clamp(1.0 - abs(d.z), 0.0, 1.0), 3.0);
  gl_FragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------- create */

function create(THREE, ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, ctx.width / ctx.height, 0.05, 220);

  const root = new THREE.Group();
  scene.add(root);

  const envTex = makeEnvTexture(THREE);
  if (envTex) scene.environment = envTex;

  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, makeMaterial(THREE, 'polished', envTex));
  mesh.castShadow = true;
  root.add(mesh);

  /* 灯：环境贴图给材质提供形体，这三盏只负责高光位置、边缘与投影。 */
  const key = new THREE.DirectionalLight(0xfff3e2, 4.6);
  key.position.set(3.4, 5.6, 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3.2;
  key.shadow.camera.right = 3.2;
  key.shadow.camera.top = 3.2;
  key.shadow.camera.bottom = -3.2;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 22;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.02;
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9dc0ff, 1.1);
  fill.position.set(-4.2, 1.4, 2.6);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0x7fd8ff, 1.4);
  rim.position.set(-2.6, 2.2, -4.2);
  scene.add(rim);

  const renderer = ctx.renderer;
  if (renderer && renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    // r187 起 `PCFSoftShadowMap` 已被移除（会打一条 warning 并退回 PCF）。
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  key.shadow.radius = 4;

  /* 接影地面：只有纯色背景才有意义 —— 透明底上的影子会读成一块脏污。 */
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.ShadowMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }),
  );
  floor.rotation.x = -Math.PI * 0.5;
  floor.position.y = -1.12;
  floor.receiveShadow = true;
  scene.add(floor);

  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uTop: { value: new THREE.Color(0x2b3a55) }, uLow: { value: new THREE.Color(0x070a10) } },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(80, 32, 16), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  const white = new THREE.Color(0xffffff);
  const colors = {
    face: new THREE.Color('#dfe6f2'),
    rim: new THREE.Color('#7fd8ff'),
    top: new THREE.Color('#2b3a55'),
    low: new THREE.Color('#080a10'),
  };
  const mats = new Map();
  let lastTex = null;
  let lastId = '';

  const p = () => ctx.params;

  function materialFor(kind) {
    let m = mats.get(kind);
    if (!m) {
      m = makeMaterial(THREE, kind, envTex);
      mats.set(kind, m);
    }
    return m;
  }

  function rebuild(tex) {
    let loops = [];
    if (tex && tex.image) {
      try {
        loops = traceImage(tex.image, num(p(), 'detail', 224));
      } catch (err) {
        // 画布被污染 / 解码格式不认识：退回占位轮廓，别让整段黑掉。
        loops = [];
      }
    }
    const shapes = shapesFromLoops(THREE, loops.length ? loops : emblemLoops());
    if (!shapes.length) return;
    const depth = Math.max(0.02, num(p(), 'depth', 0.22));
    const bevel = clamp(num(p(), 'bevel', 0.03), 0, Math.min(0.12, depth * 0.45));
    const geo = new THREE.ExtrudeGeometry(shapes, {
      depth: depth,
      bevelEnabled: bevel > 0.0005,
      bevelThickness: bevel,
      bevelSize: bevel * 0.85,
      bevelSegments: 3,
      curveSegments: 1,
      steps: 1,
    });
    geo.center();
    const old = mesh.geometry;
    mesh.geometry = geo;
    if (old) old.dispose();
  }

  function syncMaterial() {
    const kind = String(p().material || 'polished');
    const m = materialFor(kind);
    if (mesh.material !== m) {
      mesh.material = m;
      // 玻璃投一张实心影子会把它读成一块不透明的塑料。
      mesh.castShadow = kind !== 'glass';
    }
    const gloss = clamp(num(p(), 'gloss', 0.72), 0, 1);
    const tune = m.userData.tune;
    colors.face.set(String(p().color || '#dfe6f2'));
    m.color.copy(colors.face);
    m.roughness = tune.lo + (tune.hi - tune.lo) * (1 - gloss);
    m.envMapIntensity = tune.env * Math.max(0, num(p(), 'env', 1));
    if (kind === 'holo') m.color.multiplyScalar(0.35);
    if (kind === 'glass') m.opacity = 0.42 + 0.24 * gloss;
    else m.opacity = 1;
    // 丝绒的绒毛色是面色提亮后的版本：纯面色的 sheen 读不出「绒」。
    if (kind === 'velvet') m.sheenColor.copy(colors.face).lerp(white, 0.6);
  }

  function syncCamera() {
    camera.fov = clamp(num(p(), 'fov', 32), 10, 90);
    camera.aspect = Math.max(0.1, ctx.width / Math.max(1, ctx.height));
    camera.updateProjectionMatrix();
    const dist = Math.max(1.2, num(p(), 'dist', 4.6));
    const pitch = (clamp(num(p(), 'pitch', 14), -8, 60) * Math.PI) / 180;
    camera.position.set(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist);
    camera.lookAt(0, 0, 0);
  }

  function syncBackdrop() {
    const solid = String(p().bgMode || 'solid') !== 'transparent';
    sky.visible = solid;
    floor.visible = solid && num(p(), 'shadow', 0.55) > 0.001;
    colors.top.set(String(p().bgTop || '#2b3a55'));
    colors.low.set(String(p().bg || '#070a10'));
    skyMat.uniforms.uTop.value.copy(colors.top);
    skyMat.uniforms.uLow.value.copy(colors.low);
    floor.material.opacity = 0.62 * clamp(num(p(), 'shadow', 0.55), 0, 1);
  }

  function update(t) {
    const id = String(p().logoAsset || '');
    if (id !== lastId) {
      lastId = id;
      lastTex = null;
      lastTex = id ? ctx.texture(id) : null;
      rebuild(lastTex);
    } else {
      const tex = id ? ctx.texture(id) : null;
      if (tex !== lastTex) {
        lastTex = tex;
        rebuild(tex);
      }
    }

    syncMaterial();
    syncCamera();
    syncBackdrop();

    colors.rim.set(String(p().rimCol || '#7fd8ff'));
    rim.color.copy(colors.rim);
    rim.intensity = 2.4 * clamp(num(p(), 'rim', 0.75), 0, 2);

    const bob = clamp(num(p(), 'bob', 0.3), 0, 1);
    root.rotation.y = (num(p(), 'yaw', -26) * Math.PI) / 180 + num(p(), 'spin', 0.05) * Math.PI * 2 * t;
    root.rotation.x = 0.045 * bob * Math.sin(t * 0.7 + 0.6);
    root.position.y = 0.075 * bob * Math.sin(t * 0.9);

    // 厚度/倒角是几何量：改了要重建（它们不在 rebuild 参数里，只在 update 里比）。
    if (Math.abs(mesh.userData.depth - num(p(), 'depth', 0.22)) > 1e-4 ||
        Math.abs(mesh.userData.bevel - num(p(), 'bevel', 0.03)) > 1e-4) {
      mesh.userData.depth = num(p(), 'depth', 0.22);
      mesh.userData.bevel = num(p(), 'bevel', 0.03);
      rebuild(lastTex);
    }
  }

  syncCamera();
  syncMaterial();
  syncBackdrop();
  rebuild(lastTex);
  mesh.userData.depth = num(p(), 'depth', 0.22);
  mesh.userData.bevel = num(p(), 'bevel', 0.03);

  return {
    scene: scene,
    camera: camera,
    update: update,
    resize: function resize(w, h) {
      ctx.width = w;
      ctx.height = h;
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
    dispose: function dispose() {
      for (const m of mats.values()) m.dispose();
      mats.clear();
      if (envTex) envTex.dispose();
      skyMat.dispose();
      floor.material.dispose();
    },
  };
}
