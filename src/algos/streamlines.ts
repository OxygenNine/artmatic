/**
 * streamlines.ts — 流线，realtime 型。
 *
 * ## 在画什么
 *
 * 发射点不断甩出线条，线条可以收束到「接受点」（像磁感线回到磁极），也可以
 * 在没有接受点时四散飞走。每一条线是一支**从发射点向远处生长的笔画**：
 * 位置沿一条三次贝塞尔推进，画完一段后停一会儿，再从头来一次。
 *
 * ## 一次发射的周期
 *
 * `周期 = 生长时间 + 等待间隔`，其中
 * `生长时间 = min(life, 反解(线段长度))`。三段特例：
 *
 * - `线段长度 = 0`（出厂）＝ 不限制，生长时间就是 `life`，与没有这两个参数时
 *   **逐像素相同**。
 * - `线段长度` 超过整条路径 ＝ 画完整条，剩下时间在等待。
 * - 加速度为负时头会停下（走得最远 `v0²/(2|a|)`），够不着线段长度就停在
 *   停下的那一刻，等完照样重发。
 *
 * ## 七条不这么写就会坏掉的地方
 *
 * 1. **路径完全闭式，没有任何逐帧状态。** 整条线由 `u_time` 直接算出
 *    （相位 = `fract(t/周期 + 错相)`），所以 seek 与顺序播放逐像素相同、
 *    不需要快照，也不会因为「预览与导出走两条路」而漂。
 * 2. **首尾切向分别由「发射角」与「接受角」给，曲线的两个控制点反推**。
 *    只按起止点连线的话所有线会挤成一条 —— 一组线的扇形来自发射角范围，
 *    「收束进接受点」来自接受角范围：那是同一件事的两端。
 * 3. **扭曲在两端归零**（`4·s·(1−s)` 的窗）。否则每条线的起点会被随机挪开
 *    （发射点变成一坨）、终点也被挪开（接受点不再是一个点，收束感消失）。
 * 4. **扭曲量在「最近点」上一次算完，不参与逐段采样。** 采样 28 段时
 *    `warpFreq=4` 会被画成一串直角折线 —— 摆动的频率与段数无关，加段永远
 *    不够。现在的做法是：先在**脊线**（不含摆动）上求最近点，拿折线的真实
 *    距离 `bestAbs` 与它的侧别，再把摆动当成有符号横向位移叠上去：
 *    `距离 = |bestAbs·side − 摆动量|`。于是任意频率都光滑、每段只剩一次
 *    bezier 求值，而且远处像素不会被点亮（换成只用最近点的法向投影，会在
 *    发射点后面长出悬空的线头）。代价是**幅度与频率互相牵制**：摆动比路径
 *    还陡时等距曲线会自交（见 `main` 里的 `freq` 收口）。
 * 5. **一段线是「软管里的一滴墨」：可见区间是 `[尾巴, 头]`，两段都由同一个
 *    行程 `dist(τ)` 给出（尾 = 头 − 线段长度）。** 于是：先从头往外挤（尾贴
 *    着发射点）→ 走出线段长度后尾巴脱离、整段等长往前滑 → 头到接受点停住、
 *    尾巴继续追上、整段被吸收。`线段长度 = 0` 时尾永远贴着发射点（老行为：
 *    一整束一直在被画出来的线）。
 *    ⚠️ 想成「从头长到固定长度后停住」是错的：那样线段永远到不了接受点。
 *    长度沿**曲线**量，所以同样长度在不同弯曲的线上落在不同的参数位置。
 *    ⚠️ 4 条线时总有一条的错相落在周期末尾（相位回绕），它正好处于「刚挤出」
 *    的一小段里 —— 所以不同 t 的画面**不会**逐像素相同，这不是漂移。
 * 6. **渐变长度是世界距离，不是笔画的百分比。** 按百分比算时每条笔画只剩
 *    中间一小段亮着（越短越像虚线），整屏都是断的 —— 这一条实测踩过。
 *    线宽则相反：它按**路径位置**给，否则各条线粗细过渡落在不同地方。
 * 7. **线宽/里程都是「帧高的千分之一」口径**，不是像素——`intRes` 是纯性能档位，
 *    跟着它变的画面等于「调低内部分辨率顺带改了线宽」。
 *
 * ## 成本
 *
 * 每像素最多 `密度 × 28 段`，上限 32 条。**每线一次包围圆剔除**（贝塞尔落在
 * 控制点凸包内，半径再加上扭曲幅度与线宽就是安全的）：扇形之外的像素每条线
 * 只花十几个指令，所以真正付钱的是「落在扇形里」的那些像素。实测 1280×720
 * 默认参数约 5 ms/帧（含一次读回）。
 *
 * ## 为什么带 `bgMode`
 *
 * 线条是「墨」、底色是「纸」，压在别的轨道上是这个生成器的主要用法之一。
 * 透明时吐**直通 alpha**（墨色 + 覆盖度），协议见 `shader-lib.ts` 的
 * `bgModeParam()`。
 */

import { HASH_FAST_GLSL } from '../effects/shader-def';
import { colorVec3 } from '../core/color';
import { bgColorVisible, bgModeParam, intResParam } from './shader-lib';
import type { MessageKey } from '../i18n/locales';
import type { ParamDef } from '../effects/types';
import type { GeneratorDef } from './types';

/** 同时在场的线条上限。`density` 参数的 max 必须与它一致（循环上界也是它）。 */
const MAX_LINES = 512;

/**
 * 每条曲线的采样段数。段长了会在弯处看出折角（细线尤其明显）。
 *
 * ⚠️ 它只服务**脊线**。曾经把摆动也算进采样，`warpFreq=4` 时 24 段直接画出
 * 一串直角折线 —— 摆动的频率与段数无关，怎么加都不够（见文件头第 4 条）。
 */
const SEGS = 28;

const STREAM_FRAG = `
#define SL_MAX ${MAX_LINES}
#define SL_SEGS ${SEGS}
#define SL_TAU 6.28318530718

/* ---- 发射点 / 接受点：每个点 (x, y, weight)，坐标是画面 UV ---- */
uniform int   u_emitCount;
uniform vec3  u_e0;
uniform vec3  u_e1;
uniform vec3  u_e2;
uniform vec3  u_e3;
uniform vec2  u_emitShift;    // 整组发射点的平移（UV）
uniform float u_emitAngle;    // 发射角（弧度）
uniform float u_emitSpread;   // 发射角范围（弧度，正负各一半）
uniform vec2  u_offset;       // XY 固定偏移（UV）
uniform vec2  u_jitter;       // XY 随机偏移（UV，每条线各自一份）

uniform int   u_recvOn;
uniform int   u_recvCount;
uniform vec3  u_r0;
uniform vec3  u_r1;
uniform vec3  u_r2;
uniform vec3  u_r3;
uniform float u_recvAngle;    // 接受角（弧度，= 抵达时的行进方向）
uniform float u_recvSpread;   // 接受角范围（弧度）

uniform float u_count;        // 线条数（= 发射密度）
uniform float u_speed;        // 初速度（帧高/秒）
uniform float u_accel;        // 加速度（帧高/秒²）
uniform float u_life;         // 一条线段最长画多久（秒；= 生长上限）
uniform float u_segLen;       // 线段长度（世界单位；0 = 不限制）
uniform float u_segWait;      // 画完后到下一条之间的等待（秒）
uniform float u_segJitter;    // 线段长度的随机偏移（占长度的比例，±）

uniform vec3  u_color;
uniform float u_widthHead;    // 前端全宽（帧高的千分之一）
uniform float u_widthTail;    // 后端全宽
uniform int   u_dash;
uniform float u_dashLen;      // 单个虚线的长度（世界单位，帧高 = 1）
uniform float u_fadeHead;
uniform float u_fadeTail;
uniform float u_warpAmp;
uniform float u_warpFreq;

uniform vec3  u_bg;
uniform int   u_bgMode;       // 0 = 纯色 · 1 = 透明（全家族统一口径）

vec3 emitPoint(int k) {
  if (k == 1) return u_e1;
  if (k == 2) return u_e2;
  if (k == 3) return u_e3;
  return u_e0;
}

vec3 recvPoint(int k) {
  if (k == 1) return u_r1;
  if (k == 2) return u_r2;
  if (k == 3) return u_r3;
  return u_r0;
}

/* 按权重抽一个点。权重全 0 时退回第 0 个 —— 让「把权重拖到 0」= 关掉那个点，
   而不是让整束线消失。 */
int pickWeighted(int n, vec4 w, float r) {
  float wx = max(w.x, 0.0);
  float wy = max(w.y, 0.0);
  float wz = max(w.z, 0.0);
  float ww = max(w.w, 0.0);
  float tot = 0.0;
  if (n > 0) tot += wx;
  if (n > 1) tot += wy;
  if (n > 2) tot += wz;
  if (n > 3) tot += ww;
  if (tot <= 1e-5) return 0;
  float acc = 0.0;
  float rw = r * tot;
  if (n > 0) { acc += wx; if (rw <= acc) return 0; }
  if (n > 1) { acc += wy; if (rw <= acc) return 1; }
  if (n > 2) { acc += wz; if (rw <= acc) return 2; }
  return n > 3 ? 3 : max(n - 1, 0);
}

vec2 bezPoint(vec2 a, vec2 c1, vec2 c2, vec2 b, float s) {
  float m = 1.0 - s;
  return m * m * m * a + 3.0 * m * m * s * c1 + 3.0 * m * s * s * c2 + s * s * s * b;
}

vec2 bezTangent(vec2 a, vec2 c1, vec2 c2, vec2 b, float s) {
  float m = 1.0 - s;
  return 3.0 * m * m * (c1 - a) + 6.0 * m * s * (c2 - c1) + 3.0 * s * s * (b - c2);
}

/* 点到线段的**无符号**距离 + 投影参数。
   距离必须用 length(q) 而不是法向投影：投影落在端点外时法向投影算出来的是
   「无限长直线」的距离，线会被沿切向拉长（实测点亮面积 6% → 41%）。 */
float segDist(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 ab = b - a;
  float l2 = dot(ab, ab);
  t = l2 > 1e-12 ? clamp(dot(p - a, ab) / l2, 0.0, 1.0) : 0.0;
  return length(p - (a + ab * t));
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(u_aspect, 1.0);
  float px = 1.0 / max(u_resolution.y, 1.0);

  float T = max(u_life, 0.05);
  float v0 = max(u_speed, 0.001);
  float D = max(v0 * T + 0.5 * u_accel * T * T, 0.02);
  float maxHalfW = max(u_widthHead, u_widthTail) * 0.0005;
  float nList = max(u_count, 1.0);

  float sum = 0.0;

  for (int i = 0; i < SL_MAX; i++) {
    if (float(i) >= u_count) break;
    float fi = float(i);

    /* 每条线一份固定的随机量。**不掺「第几次发射」**：几何一变，整束扇形
       就会随发射节奏抖，而扇形本身才是这条生成器的内容。 */
    float h0 = hash11(fi * 1.37 + u_seed * 5.11);
    float h1 = hash11(fi * 2.71 + u_seed * 3.07 + 11.0);
    float h2 = hash11(fi * 4.13 + u_seed * 7.93 + 23.0);
    float h3 = hash11(fi * 6.19 + u_seed * 2.29 + 37.0);
    float h4 = hash11(fi * 9.11 + u_seed * 4.41 + 53.0);
    float h5 = hash11(fi * 3.71 + u_seed * 8.17 + 71.0);

    vec3 ep = emitPoint(pickWeighted(u_emitCount, vec4(u_e0.z, u_e1.z, u_e2.z, u_e3.z), h0));
    vec2 auv = ep.xy + u_emitShift + u_offset + (vec2(h2, h3) * 2.0 - 1.0) * u_jitter;
    vec2 A = (auv - 0.5) * vec2(u_aspect, 1.0);

    float angA = u_emitAngle + (h2 * 2.0 - 1.0) * u_emitSpread;
    vec2 dirA = vec2(cos(angA), sin(angA));

    vec2 B;
    vec2 dirB;
    if (u_recvOn == 1) {
      vec3 rp = recvPoint(pickWeighted(u_recvCount, vec4(u_r0.z, u_r1.z, u_r2.z, u_r3.z), h1));
      B = (rp.xy - 0.5) * vec2(u_aspect, 1.0);
      float angB = u_recvAngle + (h3 * 2.0 - 1.0) * u_recvSpread;
      dirB = vec2(cos(angB), sin(angB));
    } else {
      /* 没有接受点：行程用尽的地方就是终点（发散）。 */
      B = A + dirA * clamp(D, 0.02, 8.0);
      dirB = dirA;
    }

    float chord = max(distance(A, B), 0.02);
    vec2 C1 = A + dirA * (chord * (0.28 + 0.16 * h4));
    vec2 C2 = B - dirB * (chord * (0.28 + 0.16 * h5));

    /* 路径长度（折线近似）。它决定「这一次发射能不能走到接受点」：
       D < L 时笔画中途就重来，于是初速度/生存时间短下来 = 线变短。 */
    float L = max(distance(A, C1) + distance(C1, C2) + distance(C2, B), 1e-3);

    /* 保守剔除球：贝塞尔落在控制点凸包里，半径再加扭曲幅度与线宽。 */
    vec2 ctr = (A + C1 + C2 + B) * 0.25;
    float rad = max(max(distance(A, ctr), distance(C1, ctr)), max(distance(C2, ctr), distance(B, ctr)))
      + u_warpAmp + maxHalfW + px * 2.0;
    if (distance(p, ctr) > rad) continue;

    /* ---- 一次「从发射点挤出去 → 在管里走完 → 等待」的周期 ----
       有限长度的线段不是「从头长出来停在那儿」，而是**一滴墨水在细软管里**
       走：头从发射点出发，走出 segLen 之后尾巴才离开发射点，随后整段等长
       一起往前滑；头到接受点就停住，尾巴继续往前赶上、整段被吸收。

       行程 dist(τ) = v0·τ + a·τ²/2 同时给头和尾，尾巴恒等于 dist − segLen：
        · segLen = 0（无限）→ 尾巴永远贴在发射点（dist − 1e9 → 0），老行为；
        · 尾巴走到路径尽头的时间就是这一段的寿终时间 tDie（够不着 / 无限长
          时是 INF，由 life 收口）。
       周期 = min(tDie, life) + 等待，所以 life 在两种模式下都还有意义
       （走得比 life 慢的线段在寿命用完时消失）。 */
    float h6 = hash11(fi * 7.07 + u_seed * 6.13 + 97.0);
    float lenCap = 1e9;
    if (u_segLen > 1e-4) {
      float jit = max(1.0 + (h6 * 2.0 - 1.0) * u_segJitter, 0.05);
      lenCap = max(u_segLen * jit, 0.005);
    }
    /* 这一滴墨有多长（沿曲线量；上限超过整条路径 = 整条都是墨）。 */
    float segTotal = min(lenCap, L);
    /* 减速时头会停下：走过 v0/|a| 秒之后 dist 不再增长。 */
    float stallT = u_accel < -1e-4 ? v0 / (-u_accel) : 1e6;

    float tDie = 1e6;
    if (lenCap < 1e8) {
      /* 尾巴离开发射点 L+segLen 时整段刚好被接受点吸收。 */
      float tailDist = L + segTotal;
      if (u_accel > 1e-4) {
        tDie = (-v0 + sqrt(max(v0 * v0 + 2.0 * u_accel * tailDist, 0.0))) / u_accel;
      } else if (u_accel < -1e-4) {
        float dec = -u_accel;
        float reach = v0 * v0 / (2.0 * dec);
        tDie = tailDist < reach
          ? (v0 - sqrt(max(v0 * v0 - 2.0 * dec * tailDist, 0.0))) / dec
          : 1e6;
      } else {
        tDie = tailDist / v0;
      }
    }
    float period = min(tDie, T) + max(u_segWait, 0.0);

    /* 错相：第 i 条线在周期的第 (i + 抖动)/N 处发射，于是任意时刻的头部
       在整条路径上均匀铺开 —— 画面是一整束线，而不是一束同进同出的线。 */
    float phase = fract(u_time / period + (fi + 0.5 * h0) / nList);
    float tau = min(phase * period, stallT);
    float dist = v0 * tau + 0.5 * u_accel * tau * tau;
    /* 头 / 尾各自的位置（弧长，夹在 [0, L]）。detach 是「尾巴会不会走」。 */
    float detach = lenCap < 1e8 ? 1.0 : 0.0;
    float headArc = clamp(dist, 0.0, L);
    float tailArc = detach * clamp(dist - segTotal, 0.0, L);
    float hn = headArc / L;
    float ts = tailArc / L;
    if (hn - ts < 1e-3) continue;

    /* 先在**脊线**（不含摆动）上找最近点。摆动不参与这个搜索，理由见文件头
       第 3 条：逐段采样摆动会把高频摆动画成一串折线。
       只扫与 [ts, hn] 相交的段 —— 滑动的线段大部分时候两头都不在原点。 */
    float bestAbs = 1e9;
    float bestS = 0.0;
    vec2 prev = bezPoint(A, C1, C2, B, ts);
    for (int k = 1; k <= SL_SEGS; k++) {
      float s0 = float(k - 1) / float(SL_SEGS);
      if (s0 >= hn) break;
      float s1 = float(k) / float(SL_SEGS);
      if (s1 <= ts) {
        prev = bezPoint(A, C1, C2, B, s1);
        continue;
      }
      float sa = max(s0, ts);
      float sb = min(s1, hn);
      vec2 cur = bezPoint(A, C1, C2, B, sb);
      float tt = 0.0;
      float d = segDist(p, prev, cur, tt);
      if (d < bestAbs) {
        bestAbs = d;
        bestS = mix(sa, sb, tt);
      }
      if (s1 >= hn) break;
      prev = cur;
    }
    /* 到**可以画到的这一段**（[0, hn]）的最短距离。它是最可靠的剔除判据：
       离脊线比「摆动幅度 + 线宽」还远的像素不可能被覆盖，可以整条线跳过。
       缺了这一步，靠后的 |sd − wob| 会把远处像素点亮 —— 那是「沿切线无限
       延长」的老毛病，实测会在发射点后面留下一小段悬空的线头。 */
    if (bestAbs > u_warpAmp + maxHalfW * 3.0 + px * 3.0) continue;

    /* 距离用**折线真实距离**（bestAbs），摆动只当作有符号的横向位移叠上去：
       |bestAbs·side − wob|。这一条是这套 shader 里最容易走错的地方 —— 换过
       三种写法：
       1) 逐段 |距离 − wob|：高频摆动被画成折线；
       2) 只用最近点的法向投影 |sd − wob|：远处像素被当成「沿切线无限延长」
          点亮（发射点后面长出一小段悬空的线头），亚像素细线还会被打成一串段；
       3) 现在这个：bestAbs 保证远处不亮、两端自带帽，side 只取符号。
       窗 4·s·(1−s) 让起点与终点各自钉在发射点与接受点上。

       ⚠️ **频率要按斜率收口**：摆动比路径本身还陡时（|wob′| > 1）等距曲线会
       自交，距离场在那里没有定义 —— 表现是线被截成一段段。所以频率的上限是
       (0.75·L/幅度 − 4) / 2π：**幅度越大，能给的波数越少**。默认值
       （幅度 0.025 / 频率 1.5）离这条线还远，只有把幅度推大之后频率才会饱和。 */
    float wob = 0.0;
    if (u_warpAmp > 1e-4 && u_warpFreq > 1e-4) {
      float freq = min(u_warpFreq, max(0.75 * L / u_warpAmp - 4.0, 0.0) / SL_TAU);
      float win = 4.0 * bestS * (1.0 - bestS);
      float ang = bestS * freq * SL_TAU + h4 * SL_TAU;
      wob = u_warpAmp * win * sin(ang);
    }
    /* 侧别：取最近点处那条光滑法线的符号（不在逐段的左右判断上翻号）。 */
    vec2 sp = bezPoint(A, C1, C2, B, bestS);
    vec2 tg = bezTangent(A, C1, C2, B, bestS);
    vec2 nrm = vec2(-tg.y, tg.x) / max(length(tg), 1e-5);
    float side = dot(p - sp, nrm) >= 0.0 ? 1.0 : -1.0;
    float dPx = abs(bestAbs * side - wob) / px;

    /* 线宽/渐变/虚线都按**这一滴墨自己**的坐标算（从尾巴量起的弧长）：
       墨滴整体往前滑时，粗细过渡、两头渐变、虚线花纹都跟着它一起走 ——
       钉在路径上会让花纹从墨滴身上「流过去」。 */
    float arc = bestS * L - tailArc;
    float span = max(headArc - tailArc, 1e-4);
    float u = clamp(arc / max(segTotal, 1e-4), 0.0, 1.0);
    float hwPx = mix(u_widthTail, u_widthHead, u) * 0.0005 / px;
    /* 芯 + 一圈很淡的辉光：细线单靠 AA 会读成「脏点」，加上光晕才像光。 */
    float cov = clamp(hwPx + 0.5 - dPx, 0.0, 1.0)
      + 0.18 * clamp(1.0 - dPx / (hwPx * 3.0 + 1.0), 0.0, 1.0);

    /* 渐变长度是**世界距离**，不是笔画的百分比 —— 后者会把每条笔画掐成
       中间亮、两头空的一小段（笔画越短越像虚线；实测整屏都是断的）。
       两端各留不超过线段长度的 45%：不然一段 0.05 长的线段整段都在渐变里，
       直接看不见（实测 lit = 0）。 */
    float fadeT = min(u_fadeTail, segTotal * 0.45);
    float fadeH = min(u_fadeHead, segTotal * 0.45);
    float fade = 1.0;
    if (fadeT > 1e-4) fade *= smoothstep(0.0, fadeT, arc);
    if (fadeH > 1e-4) fade *= smoothstep(0.0, fadeH, span - arc);
    /* 虚线跟着墨滴走：同一滴墨的花纹是固定的，滑动时不会从身上流过。 */
    if (u_dash == 1) {
      float ph = fract(arc / max(u_dashLen * 2.0, 1e-3));
      fade *= 1.0 - smoothstep(0.5 - 0.03, 0.5, ph);
    }

    sum += cov * fade;
  }

  /* 软饱和：接受点上几十条线会重叠，硬加会整片死白。 */
  float ink = 1.0 - exp(-sum * 1.15);
  if (u_bgMode == 1) outColor = vec4(u_color, ink);
  else outColor = vec4(mix(u_bg, u_color, ink), 1.0);
}`;

/* -------------------------------------------------------------------- 参数 */

const isDashed = (v: Record<string, number | string>): boolean => Number(v.dash ?? 0) === 1;
const hasRecv = (v: Record<string, number | string>): boolean => Number(v.recvOn ?? 1) === 1;
const emitAtLeast = (n: number) => (v: Record<string, number | string>): boolean =>
  Number(v.emitCount ?? 1) >= n;
const recvAtLeast = (n: number) => (v: Record<string, number | string>): boolean =>
  Number(v.recvOn ?? 1) === 1 && Number(v.recvCount ?? 1) >= n;
/** 线段长度 > 0 才有「长度」可随机偏移。 */
const segLenOn = (v: Record<string, number | string>): boolean => Number(v.segLen ?? 0) > 0.005;

/** 一个发射 / 接受点的三件套文案键：X、Y、权重。 */
type PointLabels = readonly [MessageKey, MessageKey, MessageKey];

/** 一个发射 / 接受点的三件套（X、Y、权重）。坐标是画面 UV（0..1）。 */
function pointParams(
  prefix: 'e' | 'r',
  n: number,
  labels: PointLabels,
  pos: readonly [number, number],
  weight: number,
  visibleWhen: (v: Record<string, number | string>) => boolean,
): ParamDef[] {
  return [
    {
      key: `${prefix}${n}x`,
      labelKey: labels[0],
      type: 'range',
      min: 0,
      max: 1,
      step: 0.002,
      defaultValue: pos[0],
      visibleWhen,
    },
    {
      key: `${prefix}${n}y`,
      labelKey: labels[1],
      type: 'range',
      min: 0,
      max: 1,
      step: 0.002,
      defaultValue: pos[1],
      visibleWhen,
    },
    {
      key: `${prefix}${n}w`,
      labelKey: labels[2],
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: weight,
      visibleWhen,
    },
  ];
}

const EMIT_LABELS: readonly PointLabels[] = [
  ['algo.streamlines.e1x', 'algo.streamlines.e1y', 'algo.streamlines.e1w'],
  ['algo.streamlines.e2x', 'algo.streamlines.e2y', 'algo.streamlines.e2w'],
  ['algo.streamlines.e3x', 'algo.streamlines.e3y', 'algo.streamlines.e3w'],
  ['algo.streamlines.e4x', 'algo.streamlines.e4y', 'algo.streamlines.e4w'],
];

const RECV_LABELS: readonly PointLabels[] = [
  ['algo.streamlines.r1x', 'algo.streamlines.r1y', 'algo.streamlines.r1w'],
  ['algo.streamlines.r2x', 'algo.streamlines.r2y', 'algo.streamlines.r2w'],
  ['algo.streamlines.r3x', 'algo.streamlines.r3y', 'algo.streamlines.r3w'],
  ['algo.streamlines.r4x', 'algo.streamlines.r4y', 'algo.streamlines.r4w'],
];

export const streamlinesDef: GeneratorDef = {
  id: 'streamlines',
  nameKey: 'algo.streamlines',
  kind: 'realtime',
  fragment: HASH_FAST_GLSL + STREAM_FRAG,
  params: [
    { key: 'emitCount', labelKey: 'algo.streamlines.emitCount', type: 'range', min: 1, max: 4, step: 1, defaultValue: 1 },
    /* 四个发射点。第 0 个是出厂那一个（左侧），其余默认摆在它的上下与右边 ——
       **不能与任何接受点的默认位置重合**：那样「把数量拖到 2」会立刻得到一条
       零长度的线（实测整束只剩发射点上的一个小团）。 */
    ...pointParams('e', 0, EMIT_LABELS[0]!, [0.12, 0.5], 1, emitAtLeast(1)),
    ...pointParams('e', 1, EMIT_LABELS[1]!, [0.12, 0.28], 0.8, emitAtLeast(2)),
    ...pointParams('e', 2, EMIT_LABELS[2]!, [0.12, 0.72], 0.8, emitAtLeast(3)),
    ...pointParams('e', 3, EMIT_LABELS[3]!, [0.32, 0.5], 0.6, emitAtLeast(4)),

    { key: 'emitX', labelKey: 'algo.streamlines.emitX', type: 'range', min: -0.5, max: 0.5, step: 0.002, defaultValue: 0 },
    { key: 'emitY', labelKey: 'algo.streamlines.emitY', type: 'range', min: -0.5, max: 0.5, step: 0.002, defaultValue: 0 },
    { key: 'emitAngle', labelKey: 'algo.streamlines.emitAngle', type: 'range', min: -180, max: 180, step: 1, defaultValue: 0 },
    { key: 'emitSpread', labelKey: 'algo.streamlines.emitSpread', type: 'range', min: 0, max: 180, step: 1, defaultValue: 70 },
    { key: 'offX', labelKey: 'algo.streamlines.offX', type: 'range', min: -0.5, max: 0.5, step: 0.002, defaultValue: 0 },
    { key: 'offY', labelKey: 'algo.streamlines.offY', type: 'range', min: -0.5, max: 0.5, step: 0.002, defaultValue: 0 },
    { key: 'randX', labelKey: 'algo.streamlines.randX', type: 'range', min: 0, max: 0.3, step: 0.002, defaultValue: 0.012 },
    { key: 'randY', labelKey: 'algo.streamlines.randY', type: 'range', min: 0, max: 0.3, step: 0.002, defaultValue: 0.012 },

    { key: 'recvOn', labelKey: 'algo.streamlines.recvOn', type: 'checkbox', defaultValue: 1 },
    { key: 'recvCount', labelKey: 'algo.streamlines.recvCount', type: 'range', min: 1, max: 4, step: 1, defaultValue: 1, visibleWhen: hasRecv },
    ...pointParams('r', 0, RECV_LABELS[0]!, [0.88, 0.5], 1, recvAtLeast(1)),
    ...pointParams('r', 1, RECV_LABELS[1]!, [0.88, 0.28], 0.8, recvAtLeast(2)),
    ...pointParams('r', 2, RECV_LABELS[2]!, [0.88, 0.72], 0.8, recvAtLeast(3)),
    ...pointParams('r', 3, RECV_LABELS[3]!, [0.68, 0.5], 0.6, recvAtLeast(4)),
    { key: 'recvAngle', labelKey: 'algo.streamlines.recvAngle', type: 'range', min: -180, max: 180, step: 1, defaultValue: 0, visibleWhen: hasRecv },
    { key: 'recvSpread', labelKey: 'algo.streamlines.recvSpread', type: 'range', min: 0, max: 180, step: 1, defaultValue: 40, visibleWhen: hasRecv },

    { key: 'density', labelKey: 'algo.streamlines.density', type: 'range', min: 4, max: MAX_LINES, step: 1, defaultValue: 18 },
    { key: 'speed', labelKey: 'algo.streamlines.speed', type: 'range', min: 0.05, max: 3, step: 0.01, defaultValue: 0.7 },
    { key: 'accel', labelKey: 'algo.streamlines.accel', type: 'range', min: -1, max: 3, step: 0.01, defaultValue: 0.25 },
    { key: 'life', labelKey: 'algo.streamlines.life', type: 'range', min: 0.5, max: 10, step: 0.05, defaultValue: 3 },
    /* 线段长度 0 = 不限制（画到路径尽头或 life 用完）—— 出厂的「无限」形态。
       长度随机偏移只在有限长度时存在，否则它拨了没有任何东西可偏移。 */
    { key: 'segLen', labelKey: 'algo.streamlines.segLen', type: 'range', min: 0, max: 2.5, step: 0.01, defaultValue: 0 },
    { key: 'segWait', labelKey: 'algo.streamlines.segWait', type: 'range', min: 0, max: 5, step: 0.05, defaultValue: 0 },
    { key: 'segJitter', labelKey: 'algo.streamlines.segJitter', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.3, visibleWhen: segLenOn },

    { key: 'color', labelKey: 'algo.streamlines.color', type: 'color', defaultValue: '#7fe4ff' },
    { key: 'widthHead', labelKey: 'algo.streamlines.widthHead', type: 'range', min: 0.3, max: 10, step: 0.05, defaultValue: 3.4 },
    { key: 'widthTail', labelKey: 'algo.streamlines.widthTail', type: 'range', min: 0.3, max: 10, step: 0.05, defaultValue: 1.1 },
    { key: 'dash', labelKey: 'algo.streamlines.dash', type: 'checkbox', defaultValue: 0 },
    { key: 'dashLen', labelKey: 'algo.streamlines.dashLen', type: 'range', min: 0.01, max: 0.3, step: 0.002, defaultValue: 0.05, visibleWhen: isDashed },
    { key: 'fadeHead', labelKey: 'algo.streamlines.fadeHead', type: 'range', min: 0, max: 0.3, step: 0.002, defaultValue: 0.08 },
    { key: 'fadeTail', labelKey: 'algo.streamlines.fadeTail', type: 'range', min: 0, max: 0.3, step: 0.002, defaultValue: 0.05 },
    { key: 'warpAmp', labelKey: 'algo.streamlines.warpAmp', type: 'range', min: 0, max: 0.3, step: 0.002, defaultValue: 0.025 },
    { key: 'warpFreq', labelKey: 'algo.streamlines.warpFreq', type: 'range', min: 0, max: 6, step: 0.05, defaultValue: 1.5 },

    bgModeParam(),
    { key: 'bg', labelKey: 'algo.streamlines.bg', type: 'color', defaultValue: '#060810', visibleWhen: bgColorVisible },
    intResParam(),
  ],
  setUniforms: (gl, l, v) => {
    /* `Number(undefined)` 是 NaN，而 `uniform2f(NaN)` 会把整幅画变成 NaN 而不是
       报错 —— 手改过的工程少一个键就走这条路，所以统一收口。 */
    const num = (k: string): number => {
      const x = Number(v[k]);
      return Number.isFinite(x) ? x : 0;
    };
    const deg = (k: string): number => (num(k) * Math.PI) / 180;
    const u1 = (name: string, x: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, x);
    };
    const u2 = (name: string, x: number, y: number): void => {
      const loc = l[name];
      if (loc) gl.uniform2f(loc, x, y);
    };
    const u3 = (name: string, x: number, y: number, z: number): void => {
      const loc = l[name];
      if (loc) gl.uniform3f(loc, x, y, z);
    };
    /** int uniform 必须走 uniform1i —— 用 uniform1f 写它是 INVALID_OPERATION 且静默不写。 */
    const i1 = (name: string, x: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1i(loc, Math.round(x));
    };
    const point = (name: string, k: string): void =>
      u3(name, num(`${k}x`), num(`${k}y`), Math.max(num(`${k}w`), 0));

    i1('u_emitCount', Math.min(Math.max(num('emitCount'), 1), 4));
    point('u_e0', 'e0');
    point('u_e1', 'e1');
    point('u_e2', 'e2');
    point('u_e3', 'e3');
    u2('u_emitShift', num('emitX'), num('emitY'));
    u1('u_emitAngle', deg('emitAngle'));
    u1('u_emitSpread', deg('emitSpread'));
    u2('u_offset', num('offX'), num('offY'));
    u2('u_jitter', Math.max(num('randX'), 0), Math.max(num('randY'), 0));

    i1('u_recvOn', num('recvOn') >= 0.5 ? 1 : 0);
    i1('u_recvCount', Math.min(Math.max(num('recvCount'), 1), 4));
    point('u_r0', 'r0');
    point('u_r1', 'r1');
    point('u_r2', 'r2');
    point('u_r3', 'r3');
    u1('u_recvAngle', deg('recvAngle'));
    u1('u_recvSpread', deg('recvSpread'));

    u1('u_count', Math.min(Math.max(Math.round(num('density')) || 1, 1), MAX_LINES));
    u1('u_speed', Math.max(num('speed'), 0.001));
    u1('u_accel', num('accel'));
    u1('u_life', Math.max(num('life'), 0.05));
    u1('u_segLen', Math.max(num('segLen'), 0));
    u1('u_segWait', Math.max(num('segWait'), 0));
    u1('u_segJitter', Math.min(Math.max(num('segJitter'), 0), 1));

    const [cr, cg, cb] = colorVec3(String(v.color ?? '#7fe4ff'));
    u3('u_color', cr!, cg!, cb!);
    u1('u_widthHead', Math.max(num('widthHead'), 0.05));
    u1('u_widthTail', Math.max(num('widthTail'), 0.05));
    i1('u_dash', num('dash') >= 0.5 ? 1 : 0);
    u1('u_dashLen', Math.max(num('dashLen'), 0.002));
    u1('u_fadeHead', Math.min(Math.max(num('fadeHead'), 0), 1));
    u1('u_fadeTail', Math.min(Math.max(num('fadeTail'), 0), 1));
    u1('u_warpAmp', Math.max(num('warpAmp'), 0));
    u1('u_warpFreq', Math.max(num('warpFreq'), 0));

    /* `u_bgMode` 由 AlgoRuntime 统一派发（全家族一套口径），这里不重复写。 */
    const [br, bgc, bb] = colorVec3(String(v.bg ?? '#060810'));
    u3('u_bg', br!, bgc!, bb!);
  },
};
