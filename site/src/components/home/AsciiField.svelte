<script>
  /**
   * ASCII 场：按字符格渲染的分层 fBm，附带每行的横向错位。
   *
   * 为什么用 2D canvas 而不是着色器：这一块只有几千个格子，fillText 足够，
   * 而省掉一次 WebGL 上下文；也刻意**不 import 主应用任何模块**（那条链会经 i18n
   * 拉到 `$state`，在 Astro 下编译不过）。
   *
   * 性能护栏（缺一条都会在后台标签页里烧电池）：
   *   - 30fps 限流；
   *   - IntersectionObserver 判定离开视口即停；
   *   - `prefers-reduced-motion` 只画一帧。
   */
  import { onMount } from 'svelte';

  let { hollow = false, cell = 10 } = $props();

  let canvas;

  onMount(() => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    /* 字符阶梯：只用中段，最淡和最重的几档要么看不见、要么糊成墨块 */
    const GLYPHS = ['.', ':', '-', '=', '+', '*', '#', '%'];
    const BUCKETS = GLYPHS.length;
    const FRAME_MS = 1000 / 30;

    const reduced = matchMedia('(prefers-reduced-motion: reduce)');

    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let cellW = 10;
    let cellH = 17;
    let fontPx = 14;
    let bucketOf = new Uint8Array(0);
    let palette = ['#787d84', '#787d84', '#787d84', '#787d84'];
    let raf = 0;
    let lastDraw = 0;
    let visible = true;

    /* ---------------------------------------------------------- 颜色 */

    const parseHex = (value, fallback) => {
      const m = /^#?([0-9a-f]{6})$/i.exec((value || '').trim());
      if (!m) return fallback;
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };

    const mix = (a, b, t) =>
      `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

    function readPalette() {
      const style = getComputedStyle(document.documentElement);
      const muted = parseHex(style.getPropertyValue('--text-muted'), [120, 125, 132]);
      const accent = parseHex(style.getPropertyValue('--accent'), [110, 98, 239]);
      /* 前四档几乎全灰，只有最后两档带品牌紫 —— 全紫会像链接残留 */
      palette = Array.from({ length: BUCKETS }, (_, i) =>
        mix(muted, accent, i <= 4 ? i * 0.05 : 0.2 + (i - 4) * 0.15),
      );
    }

    /* ---------------------------------------------------------- 噪声场 */

    const fract = (x) => x - Math.floor(x);

    /** 值噪声的哈希：够散就够用，不需要更贵的实现。 */
    const hash2 = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

    function valueNoise(x, y) {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xf = x - xi;
      const yf = y - yi;
      const u = xf * xf * (3 - 2 * xf);
      const v = yf * yf * (3 - 2 * yf);
      const a = hash2(xi, yi);
      const b = hash2(xi + 1, yi);
      const c = hash2(xi, yi + 1);
      const d = hash2(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }

    /**
     * 三个倍频的 fBm。倍频数是敏感性最高的一项：四个倍频时最细的一层只有一个
     * 字符格宽，整片会退化成噪点；三层时最细层约八个格，才看得出「地形」。
     */
    function fbm(x, y, t) {
      let sum = 0;
      let amp = 0.55;
      let freq = 1;
      for (let octave = 0; octave < 3; octave++) {
        sum += amp * valueNoise(x * freq, y * freq + t * (0.16 + octave * 0.06));
        amp *= 0.5;
        freq *= 2;
      }
      return sum;
    }

    /**
     * 返回 0..1 的强度；0 表示这格不画。
     *
     * 三层结构，刻意都不用域扭曲 —— 扭曲会把等值线拉成 45° 的长条，在宽画框里
     * 看起来就是「横纹」，比没有纹理更糟：
     *   1. 低频 fBm 决定大块的明暗（读者看到的是形状）
     *   2. 中频 fBm 补细节（凑近才看到）
     *   3. 每 1/14 行的一次横向错位（「故障」的那一下，每秒换一次）
     */
    function shade(ux, uy, t) {
      /* 首屏要给文字挖一块留白；单独当色块用的时候整片都要有字 */
      const radius = Math.hypot(ux / 0.95, uy / 0.5);
      const breathe = 1 + 0.1 * Math.sin(t * 0.07);

      let x = ux * breathe;
      const y = uy * breathe;

      const band = Math.floor((uy + 1) * 14);
      x += Math.sin(band * 12.9898 + Math.floor(t * 2) * 0.7) * 0.045;

      /* 倍频的「基准频率」按画框里能放几个噪声格来定：3.6 ≈ 横向七八个格，
         每个格再被三个倍频细分到四个字符左右 —— 这是能看出形状又不像噪点的区间 */
      const big = fbm(x * 3.6 + 3.1, y * 3.6 + 7.4, t * 0.4);
      const fine = fbm(x * 8.2 + 11.7, y * 8.2 + 2.9, t * 0.9);
      const field = big * 0.76 + fine * 0.24;

      const v = (field - 0.36) / 0.3;
      if (v <= 0) return 0;

      const falloff = hollow ? 0.05 + 0.95 * Math.min(1, Math.max(0, (radius - 0.72) / 0.62)) : 1;
      return Math.min(1, v) ** 1.1 * falloff;
    }

    /* ---------------------------------------------------------- 布局 */

    function layout() {
      // 量自己，别量父元素：Astro 的 client island 会在组件外面包一层
      // `<astro-island style="display:contents">`，父元素的 rect 恒为 0×0。
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = width;
      canvas.height = height;

      // 目标字宽 8~12px：窗再大也不加格子数，否则 fillText 的量会线性涨
      cellW = Math.min(12, Math.max(8, cell));
      cellH = cellW * 1.7;
      cols = Math.ceil(width / cellW);
      rows = Math.ceil(height / cellH);
      fontPx = Math.round(cellW / 0.6);

      bucketOf = new Uint8Array(cols * rows);
      ctx.font = `400 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textBaseline = 'top';
    }

    /* ---------------------------------------------------------- 绘制 */

    function draw(now) {
      raf = 0;
      if (!visible || document.hidden) return;

      const t = now / 1000;
      const aspect = height / width;
      const reachX = 1.35;
      const reachY = reachX * aspect;

      for (let row = 0; row < rows; row++) {
        const uy = ((row + 0.5) / rows) * 2 * reachY - reachY;
        for (let col = 0; col < cols; col++) {
          const ux = ((col + 0.5) / cols) * 2 * reachX - reachX;
          const v = shade(ux, uy, t);
          bucketOf[row * cols + col] = v === 0 ? 255 : Math.min(BUCKETS - 1, (v * BUCKETS) | 0);
        }
      }

      ctx.clearRect(0, 0, width, height);
      for (let b = 0; b < BUCKETS; b++) {
        ctx.fillStyle = palette[b];
        const ch = GLYPHS[b];
        for (let row = 0; row < rows; row++) {
          const y = row * cellH;
          for (let col = 0; col < cols; col++) {
            if (bucketOf[row * cols + col] !== b) continue;
            ctx.fillText(ch, col * cellW, y);
          }
        }
      }

      if (!reduced.matches) schedule(now);
    }

    function schedule(now) {
      if (reduced.matches) return;
      // 首帧立即画，之后按 30fps 节流
      const wait = Math.max(0, FRAME_MS - (now - lastDraw));
      lastDraw = now + wait;
      raf = requestAnimationFrame((next) => {
        if (next - now < wait) {
          raf = requestAnimationFrame(draw);
          return;
        }
        draw(next);
      });
    }

    function start() {
      if (raf || reduced.matches || !visible) return;
      raf = requestAnimationFrame(draw);
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    /* ---------------------------------------------------------- 生命周期 */

    readPalette();
    requestAnimationFrame(() => {
      layout();
      draw(performance.now());
      lastDraw = performance.now();
      start();
    });

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        visible ? start() : stop();
      },
      { rootMargin: '80px' },
    );
    io.observe(canvas);

    const ro = new ResizeObserver(() => {
      layout();
      if (reduced.matches) draw(performance.now());
      else start();
    });
    ro.observe(canvas);

    // 主题切换后调色板要重取（--accent 在暗色下是另一个明度）
    const mo = new MutationObserver(() => {
      readPalette();
      if (reduced.matches) draw(performance.now());
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
</script>

<div class="field">
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
</div>

<style>
  /*
   * 画布必须**脱离布局**，不能靠 `height: 100%` 被动撑开自己。
   *
   * `canvas` 是替换元素，它的 width/height 属性同时是它的固有宽高比；而 `layout()`
   * 会按当前盒子的尺寸回写这两个属性。一旦祖先的高度是「不定」的（百分比高度退化成
   * auto，例如没有定高的 flex 列），盒子高度就会变成 `宽度 × 上一次的宽高比` ——
   * 于是这块面板的尺寸成了自己的函数：父级宽度一变，它就按上一轮的比值成倍长高，
   * 从宽屏切到窄屏时见过 1.4 倍宽度的空白面板，把整页顶高近千像素。
   * 绝对定位把它从布局里摘出去，回路就断了。
   *
   * 代价是一条契约：**父元素必须给它一个确定的高度**（定高、`flex` 拉伸、
   * 或带 `min-height` 的弹性列都可以），否则这里是 0。
   */
  .field {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: clip;
  }
  canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
