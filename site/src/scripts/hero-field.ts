/**
 * 首屏的平面构图。
 *
 * 两条规则不是装饰偏好，是构图本身：
 *   1. 方块只允许对角接触 —— 判定时只看四邻，斜邻不管；所以永远不会连成一片。
 *   2. 密度按「离中轴的距离」和「竖向位置」给，中心让给磁带，符号越靠下越密。
 * 全部走固定种子，刷新不重排。
 */

type Options = { animate: boolean };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = '01<>/\\[]{}()=+*#%&$@:;';

function asciiTile(ink: string): string {
  const rnd = mulberry32(0x2f6e1a3b);
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = ink;
  ctx.font = '14px "JetBrains Mono", Consolas, monospace';
  ctx.textBaseline = 'top';
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 8; col++) {
      const ch = CHARS[Math.floor(rnd() * CHARS.length)];
      ctx.fillText(ch, 2 + col * 16, 1 + row * 14);
    }
  }
  return c.toDataURL();
}

function makeSquare(kind: string, x: number, y: number, size: number, opacity: number) {
  const el = document.createElement('div');
  el.className = `sq sq--${kind}`;
  el.style.left = `${x.toFixed(1)}px`;
  el.style.top = `${y.toFixed(1)}px`;
  el.style.width = `${size.toFixed(1)}px`;
  el.style.height = `${size.toFixed(1)}px`;
  el.style.opacity = opacity.toFixed(2);
  return el;
}

function makeGlyph(
  kind: 'plus' | 'tri',
  x: number,
  y: number,
  size: number,
  opacity: number,
  rot: number,
) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const w = kind === 'plus' ? 10 : 20;
  const h = kind === 'plus' ? 10 : 12;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'glyph');
  svg.style.left = `${x.toFixed(0)}px`;
  svg.style.top = `${y.toFixed(0)}px`;
  svg.style.width = `${size.toFixed(0)}px`;
  svg.style.height = `${((size * h) / w).toFixed(0)}px`;
  svg.style.opacity = opacity.toFixed(2);
  svg.style.transform = `rotate(${rot.toFixed(1)}deg)`;

  const path = document.createElementNS(ns, 'path');
  if (kind === 'plus') {
    path.setAttribute('d', 'M5 0v10M0 5h10');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1');
    path.setAttribute('fill', 'none');
  } else {
    path.setAttribute('d', 'M0 0 10 6 0 12ZM20 0 10 6 20 12Z');
    path.setAttribute('fill', 'currentColor');
  }
  svg.appendChild(path);
  return svg;
}

export function buildField(field: HTMLElement, glyphBox: HTMLElement, opts: Options) {
  const rng = mulberry32(0x51ed270b);
  const tiles = document.createElement('div');
  tiles.className = 'hero-tiles';
  field.appendChild(tiles);

  const paintAscii = () => {
    const ink = getComputedStyle(document.documentElement)
      .getPropertyValue('--mk-fg-3')
      .trim();
    field.style.setProperty('--ascii', `url(${asciiTile(ink || '#9a94a4')})`);
  };
  paintAscii();

  const build = () => {
    const w = field.clientWidth;
    const h = field.clientHeight;
    if (!w || !h) return;

    tiles.replaceChildren();
    glyphBox.replaceChildren();

    const cols = Math.min(13, Math.max(7, Math.round(w / 148)));
    const rows = Math.min(9, Math.max(5, Math.round(h / 148)));
    const cw = w / cols;
    const ch = h / rows;
    const occ = new Uint8Array(cols * rows);

    const inside = (x: number, y: number, c: number, r: number, k: number) =>
      x >= c && x < c + k && y >= r && y < r + k;

    const free = (c: number, r: number, k: number) => {
      if (c < 0 || r < 0 || c + k > cols || r + k > rows) return false;
      for (let y = r; y < r + k; y++) {
        for (let x = c; x < c + k; x++) if (occ[y * cols + x]) return false;
      }
      // 只查四邻：斜着碰角是允许的
      for (let y = r; y < r + k; y++) {
        for (let x = c; x < c + k; x++) {
          const neighbours: [number, number][] = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
          ];
          for (const [nx, ny] of neighbours) {
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (inside(nx, ny, c, r, k)) continue;
            if (occ[ny * cols + nx]) return false;
          }
        }
      }
      return true;
    };

    const take = (c: number, r: number, k: number) => {
      for (let y = r; y < r + k; y++) {
        for (let x = c; x < c + k; x++) occ[y * cols + x] = 1;
      }
    };

    const density = (c: number, r: number) => {
      const nx = (c + 0.5) / cols;
      const ny = (r + 0.5) / rows;
      const edge = Math.abs(nx - 0.5) * 2;
      let p = 0.1 + 0.72 * Math.pow(edge, 1.3);
      // 磁带那一块留白
      if (nx > 0.23 && nx < 0.77 && ny > 0.17 && ny < 0.73) p *= 0.06;
      // 字标正上方也不摆，别切字
      if (ny > 0.79 && Math.abs(nx - 0.5) < 0.3) p *= 0.12;
      return p;
    };

    // 三块定海神针：随机布局单独跑容易把四个角抽空，角空了构图就散
    const anchors: [number, number, number, number][] = [];
    for (const [kind, x, y, size, opacity] of [
      ['ascii', 0.045, 0.08, 0.2, 0.85],
      ['ghost', 0.775, 0.045, 0.19, 0.9],
      ['plain', 0.03, 0.46, 0.15, 0.7],
    ] as [string, number, number, number, number][]) {
      const px = x * w;
      const py = y * h;
      const side = size * Math.min(w, h);
      anchors.push([px, py, side, side]);
      tiles.appendChild(makeSquare(kind, px, py, side, opacity));
    }
    const hitsAnchor = (left: number, top: number, side: number) =>
      anchors.some(
        ([ax, ay, aw2, ah2]) =>
          left < ax + aw2 + 10 && left + side > ax - 10 && top < ay + ah2 + 10 && top + side > ay - 10,
      );

    // 大块先放（2×2），只落在两侧
    const bigSpots: [number, number][] = [];
    for (let attempt = 0; attempt < 200 && bigSpots.length < 8; attempt++) {
      const c = Math.floor(rng() * (cols - 1));
      const r = Math.floor(rng() * (rows - 1));
      const nx = (c + 1) / cols;
      const edge = Math.abs(nx - 0.5) * 2;
      if (edge < 0.44) continue;
      if (rng() > 0.4 + edge * 0.35) continue;
      if (!free(c, r, 2)) continue;
      const bigSize = Math.min(cw, ch) * 2 * 0.92;
      if (hitsAnchor(c * cw + cw - bigSize / 2, r * ch + ch - bigSize / 2, bigSize)) continue;
      bigSpots.push([c, r]);
      take(c, r, 2);
      const size = Math.min(cw, ch) * 2 * (0.86 + rng() * 0.12);
      const kind = rng() < 0.55 ? 'ghost' : rng() < 0.75 ? 'ascii' : 'plain';
      tiles.appendChild(
        makeSquare(
          kind,
          c * cw + cw + (rng() - 0.5) * 8 - size / 2,
          r * ch + ch + (rng() - 0.5) * 8 - size / 2,
          size,
          0.55 + rng() * 0.45,
        ),
      );
    }

    // 小方块：所有格子随机顺序过一遍
    const order = [...Array(cols * rows).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    for (const idx of order) {
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      if (rng() > density(c, r)) continue;
      if (!free(c, r, 1)) continue;
      take(c, r, 1);

      const roll = rng();
      const kind = roll < 0.28 ? 'grad' : roll < 0.66 ? 'ascii' : 'ghost';
      const size = Math.min(cw, ch) * (0.34 + rng() * 0.52);
      if (
        hitsAnchor(
          c * cw + cw / 2 - size / 2,
          r * ch + ch / 2 - size / 2,
          size,
        )
      )
        continue;
      tiles.appendChild(
        makeSquare(
          kind,
          c * cw + cw / 2 + (rng() - 0.5) * cw * 0.2 - size / 2,
          r * ch + ch / 2 + (rng() - 0.5) * ch * 0.2 - size / 2,
          size,
          0.45 + rng() * 0.55,
        ),
      );
    }

    // 符号：越靠下越密
    const count = Math.round(Math.min(54, Math.max(18, w / 38)));
    for (let i = 0; i < count; i++) {
      const y = h * (0.4 + 0.6 * Math.pow(rng(), 0.62));
      const x = rng() * (w - 24);
      const size = 10 + rng() * 14;
      const depth = (y / h - 0.4) / 0.6;
      const opacity = 0.2 + depth * 0.5 + rng() * 0.12;
      glyphBox.appendChild(
        makeGlyph(rng() < 0.64 ? 'plus' : 'tri', x, y, size, opacity, rng() * 8 - 4),
      );
    }
  };

  build();

  // 只对尺寸变化重建：移动端地址栏的 1px 抖动不值得重排
  let timer = 0;
  let lastW = field.clientWidth;
  let lastH = field.clientHeight;
  new ResizeObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const w = field.clientWidth;
      const h = field.clientHeight;
      if (Math.abs(w - lastW) < 24 && Math.abs(h - lastH) < 48) return;
      lastW = w;
      lastH = h;
      build();
    }, 180);
  }).observe(field);

  new MutationObserver(paintAscii).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  if (!opts.animate) field.classList.add('no-anim');
}
