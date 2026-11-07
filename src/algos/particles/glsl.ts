/**
 * glsl.ts — 粒子内核的四段着色器。
 *
 * 状态布局（两张 RGBA32F ping-pong，**2D / 3D 同一份**）：
 *   pos = vec4(x, y, z, life)   life 是剩余寿命，归一到 0..1
 *   vel = vec4(vx, vy, vz, seed)  seed 每槽恒定，出生/渲染都读它
 *
 * 四段：
 *   INIT      一次性把两张状态纹理填成「已经跑了一会儿」的相位（否则第 0 帧全体齐生齐灭）
 *   STEP_POS  读 src → 写 dstPos：积分位置、扣寿命、耗尽则重生
 *   STEP_VEL  读 src → 写 dstVel：重力 / 阻力 / 湍流 / 涡旋 / 向心力
 *   RENDER    点精灵：vertex 从状态纹理取位置，fragment 画圆或采精灵图
 *
 * 确定性（硬约束 1.1 / 1.2 / 1.3）：
 *   - 每一步只读**同一份** src，两个 step pass 之间不换纹理 ⇒ 与执行顺序无关；
 *   - 所有随机都是 `(槽坐标, 步号, 种子)` 的闭式 hash，**没有跨帧累加相位**；
 *   - hash 走 `HASH_FAST_GLSL`（无 sin），大步号下低位不抖；
 *   - `u_step` 是步号而不是墙钟，`seek(f)` 重放时逐位相同。
 */

import { HASH_FAST_GLSL } from '../../effects/shader-def';

/**
 * `gpu-sim` 四段 program 的名字。**唯一真源**：`ParticleEngine` 与
 * `effects/compile-all.ts` 的预编译守卫都读它，名字不同就会各编一份。
 */
export type ParticleProgramPart = 'init' | 'step-pos' | 'step-vel' | 'points';
export function particleProgramName(id: string, part: ParticleProgramPart): string {
  return `particles-${id}-${part}`;
}

/** 内核的四段 GLSL。复用者可以按段覆盖，缺省走内置实现。 */
export interface ParticleShaders {
  init: string;
  stepPos: string;
  stepVel: string;
  pointFrag: string;
  pointVert: string;
}

/** 状态纹理的公共头（step / init 共用）。 */
const STATE_HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform int u_texW;
uniform int u_texH;
uniform float u_seed;
uniform float u_step;
uniform float u_dt;
uniform int u_shape;
uniform float u_emitterSize;
uniform float u_lifeSteps;
uniform float u_lifeVar;
uniform float u_speed;
uniform float u_speedVar;
uniform float u_spread;
uniform float u_direction;
uniform sampler2D u_emitMask;
uniform int u_emitOn;
uniform int u_emitChannel;
uniform float u_emitThreshold;
/** 1 = 状态纹理退回 RGBA8，坐标编码进 [0,1]；0 = 原生 RGBA32F。 */
uniform float u_encode;
${HASH_FAST_GLSL}

/**
 * 32F 下这对函数是恒等；8 位下把 [-2,2] 线性压到 [0,1]。
 * **所有格式走同一套算术**是刻意的：降级只掉精度，不掉行为，
 * 于是「同一工程在这台机器上少了一位精度」不会变成「画面完全不同」。
 */
vec3 stateDec(vec3 v) { return u_encode > 0.5 ? (v - 0.5) * 4.0 : v; }
vec3 stateEnc(vec3 v) { return u_encode > 0.5 ? v * 0.25 + 0.5 : v; }
`;

/** 发射器形状 → 初始位置。随机全部来自槽坐标 + 步号 + 种子。 */
const EMIT_GLSL = `
float rnd(float slot, float salt) {
  return hash31(vec3(slot, u_step + salt, u_seed * 97.0 + salt));
}
vec3 emitterPos(float slot) {
  float a = rnd(slot, 1.0) * 6.2831853;
  float r = sqrt(rnd(slot, 2.0));
  float z = rnd(slot, 3.0) * 2.0 - 1.0;
  float s = u_emitterSize;
  if (u_shape == 0) return vec3(0.0);                       // point
  if (u_shape == 1) return vec3((rnd(slot, 4.0) * 2.0 - 1.0) * s, 0.0, 0.0); // line
  if (u_shape == 3) return vec3(cos(a) * s, sin(a) * s, 0.0); // ring
  if (u_shape == 4) {                                       // sphere
    float u = rnd(slot, 5.0) * 2.0 - 1.0;
    float rr = pow(rnd(slot, 6.0), 0.3333) * s;
    float k = sqrt(max(0.0, 1.0 - u * u));
    return vec3(cos(a) * k, sin(a) * k, u) * rr;
  }
  if (u_shape == 5) return vec3(                            // box
    rnd(slot, 7.0) * 2.0 - 1.0,
    rnd(slot, 8.0) * 2.0 - 1.0,
    rnd(slot, 9.0) * 2.0 - 1.0) * s;
  return vec3(cos(a) * r * s, sin(a) * r * s, 0.0);        // disc（默认）
}
/** 发射方向：以 u_direction 为轴，按 u_spread 散开。 */
vec3 emitDir(float slot) {
  float a = u_direction + (rnd(slot, 11.0) - 0.5) * 6.2831853 * u_spread;
  float el = (rnd(slot, 12.0) - 0.5) * 3.14159 * u_spread * 0.5;
  return vec3(cos(a) * cos(el), sin(a) * cos(el), sin(el));
}
/** 发射密度图：按 luma / alpha 采样，值低于阈值或掷骰不过 ⇒ 这一帧不重生。 */
float emitDensity(vec3 p) {
  if (u_emitOn == 0) return 1.0;
  vec2 uv = clamp(p.xy / max(u_emitterSize * 2.0, 0.001) * 0.5 + 0.5, 0.0, 1.0);
  vec4 c = texture(u_emitMask, uv);
  float d = u_emitChannel == 0 ? dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) : c.a;
  return smoothstep(u_emitThreshold, min(1.0, u_emitThreshold + 0.08), d);
}
`;

/**
 * INIT：把 pos / vel 各填一次。`u_initVel = 1` 时写速度纹理。
 *
 * life 初值按 `rnd` 铺在 (0,1]，等价于「已经跑了一会儿」的稳态 ——
 * 否则第 0 帧要么全体空白、要么全体同相位闪，缩略图与预览都对不上。
 */
export const INIT_FRAG = STATE_HEAD + EMIT_GLSL + `
uniform int u_initVel;
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  float slot = float(tc.y * u_texW + tc.x);
  float phase = rnd(slot, 21.0);
  if (u_initVel == 1) {
    float sp = u_speed * (1.0 - u_speedVar + u_speedVar * rnd(slot, 22.0) * 2.0);
    outColor = vec4(stateEnc(emitDir(slot) * sp), rnd(slot, 23.0));
  } else {
    outColor = vec4(stateEnc(emitterPos(slot)), max(0.02, phase));
  }
}`;

/** 力场：闭式的空间函数 + 步号相位，没有跨帧累加。 */
const FORCE_GLSL = `
uniform vec3 u_gravity;
uniform float u_drag;
uniform float u_turbulence;
uniform float u_turbScale;
uniform float u_vortex;
uniform float u_attract;
vec3 forceAt(vec3 p) {
  vec3 f = u_gravity;
  // 绕 Y 轴的切向涡旋；半径越小越弱，避免在原点附近数值发散。
  f += vec3(-p.z, 0.0, p.x) * u_vortex;
  float r = length(p) + 0.05;
  f += -p / r * u_attract;
  // 三轴错相 hash 场当湍流：便宜、无 sin、同 t 逐位相同。
  vec3 q = p * u_turbScale + vec3(u_step * u_dt * 0.7);
  vec3 n = vec3(
    hash31(q) - 0.5,
    hash31(q + 17.31) - 0.5,
    hash31(q + 41.77) - 0.5) * 2.0;
  f += n * u_turbulence;
  return f;
}
`;

/**
 * STEP_POS：位置积分 + 寿命 + 重生。
 *
 * 重生的随机**只依赖 (槽, 步号, 种子)**，所以从快照重放与顺序播放逐位相同。
 * 密度图拒绝时保持 life = 0（下一步再试），不消耗随机数序列 —— 这一步
 * 很要紧：让「拒绝」改变后续随机会破坏 seek 等价性。
 */
export const STEP_POS_FRAG = STATE_HEAD + EMIT_GLSL + `
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(u_pos, tc, 0);
  vec4 V = texelFetch(u_vel, tc, 0);
  vec3 p0 = stateDec(P.xyz);
  vec3 v0 = stateDec(V.xyz);
  float slot = float(tc.y * u_texW + tc.x);
  float life = P.w - 1.0 / max(1.0, u_lifeSteps * (1.0 - u_lifeVar + u_lifeVar * V.w));
  vec3 p = p0 + v0 * u_dt;
  if (life <= 0.0) {
    vec3 np = emitterPos(slot);
    float dens = emitDensity(np);
    if (dens > rnd(slot, 31.0)) {
      // 出生相位错开：不要用固定 1.0，否则整群粒子同步闪。
      float jitter = 1.0 - u_lifeVar * rnd(slot, 32.0);
      outColor = vec4(stateEnc(np), jitter);
      return;
    }
    outColor = vec4(P.xyz, 0.0);   // 这一步没被接受，留在原地等下一步
    return;
  }
  outColor = vec4(stateEnc(p), life);
}`;

/** STEP_VEL：速度演化。与 STEP_POS 读同一份 src，两者之间不 swap。 */
export const STEP_VEL_FRAG = STATE_HEAD + EMIT_GLSL + FORCE_GLSL + `
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(u_pos, tc, 0);
  vec4 V = texelFetch(u_vel, tc, 0);
  vec3 p0 = stateDec(P.xyz);
  vec3 v0 = stateDec(V.xyz);
  float slot = float(tc.y * u_texW + tc.x);
  vec3 v = v0 + forceAt(p0) * u_dt;
  v *= max(0.0, 1.0 - u_drag * u_dt);
  // 寿终重生时重掷速度；判定与 STEP_POS 用同一个 life 式子，不引入第二套口径。
  float life = P.w - 1.0 / max(1.0, u_lifeSteps * (1.0 - u_lifeVar + u_lifeVar * V.w));
  if (life <= 0.0) {
    vec3 np = emitterPos(slot);
    float dens = emitDensity(np);
    if (dens > rnd(slot, 31.0)) {
      float sp = u_speed * (1.0 - u_speedVar + u_speedVar * rnd(slot, 22.0) * 2.0);
      outColor = vec4(stateEnc(emitDir(slot) * sp), V.w);
      return;
    }
  }
  outColor = vec4(stateEnc(v), V.w);
}`;

/**
 * 点精灵 vertex shader：`gl_VertexID` → 状态纹理 texel。
 *
 * `gl_PointSize` 按**画面高度**归一（以 480 为基准），于是 `intRes` 这个
 * 纯性能档位不会顺手改掉粒子大小（与 `kinetic-shapes` 同一条纪律）。
 * 3D 只差这里的投影：状态本身完全相同。
 */
export const POINT_VERT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform int u_texW;
uniform vec2 u_resolution;
uniform float u_pointSize;
uniform float u_sizeVar;
uniform int u_dimension;
uniform float u_perspective;
uniform float u_camYaw;
uniform float u_camPitch;
uniform float u_camDist;
uniform float u_depthSize;
/** 与 STATE_HEAD 同一个开关（8 位降级时解码）。 */
uniform float u_encode;
vec3 stateDec(vec3 v) { return u_encode > 0.5 ? (v - 0.5) * 4.0 : v; }
out float vLife;
out float vSeed;
out float vAngle;
void main() {
  int id = gl_VertexID;
  ivec2 tc = ivec2(id % u_texW, id / u_texW);
  vec4 P = texelFetch(u_pos, tc, 0);
  vec4 V = texelFetch(u_vel, tc, 0);
  vLife = clamp(P.w, 0.0, 1.0);
  vSeed = V.w;
  vec3 vel = stateDec(V.xyz);
  vAngle = atan(vel.y, vel.x);

  vec3 p = stateDec(P.xyz);
  float depth = 1.0;
  if (u_dimension == 1) {
    float cy = cos(u_camYaw), sy = sin(u_camYaw);
    float cp = cos(u_camPitch), sp = sin(u_camPitch);
    vec3 q = vec3(p.x * cy - p.z * sy, p.y, p.x * sy + p.z * cy);
    q = vec3(q.x, q.y * cp - q.z * sp, q.y * sp + q.z * cp);
    float persp = u_camDist / max(0.2, u_camDist + q.z);
    depth = mix(1.0, persp, u_perspective * 0.5);
    p = vec3(q.xy * depth, q.z);
  }
  gl_Position = vec4(p.xy / vec2(u_resolution.x / u_resolution.y, 1.0), 0.0, 1.0);

  float sv = 1.0 - u_sizeVar + u_sizeVar * vSeed * 2.0;
  float ds = u_dimension == 1 ? mix(1.0, depth, u_depthSize) : 1.0;
  // 480 是参数标定基准；乘 u_resolution.y / 480 让内部分辨率改动画面不变。
  gl_PointSize = max(1.0, u_pointSize * sv * ds * u_resolution.y / 480.0);
  // 寿命两端收小：出生/消失不会硬切。
  gl_PointSize *= smoothstep(0.0, 0.12, vLife) * smoothstep(0.0, 0.18, 1.0 - vLife);
}`;

/** 点精灵 fragment：圆形衰减或素材贴图；颜色随寿命从 start 插值到 end。 */
export const POINT_FRAG = `#version 300 es
precision highp float;
in float vLife;
in float vSeed;
in float vAngle;
out vec4 outColor;
uniform sampler2D u_sprite;
uniform int u_spriteOn;
uniform int u_spriteChannel;
uniform float u_spriteRotate;
uniform vec3 u_colorStart;
uniform vec3 u_colorEnd;
uniform float u_opacity;
void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float ang = vAngle * u_spriteRotate;
  vec2 q = vec2(pc.x * cos(ang) - pc.y * sin(ang), pc.x * sin(ang) + pc.y * cos(ang)) * 0.5 + 0.5;
  float cover;
  if (u_spriteOn == 1) {
    vec4 c = texture(u_sprite, clamp(q, 0.0, 1.0));
    cover = u_spriteChannel == 0 ? dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a : c.a;
  } else {
    cover = 1.0 - smoothstep(0.55, 1.0, length(pc));
  }
  float a = cover * u_opacity * smoothstep(0.0, 0.12, vLife) * smoothstep(0.0, 0.18, 1.0 - vLife);
  if (a <= 0.0) discard;
  vec3 col = mix(u_colorEnd, u_colorStart, clamp(vLife, 0.0, 1.0));
  // 一律吐「墨色 + 覆盖度」（直通 alpha，见 algos/AGENTS.md 的「透明背景」）。
  // 底色由引擎在画点之前清屏给出：纯色底清成 colorBg，透明底清成全 0。
  // 把底色混进这里会与清屏叠两次，得到一圈脏边。
  outColor = vec4(col, a);
}`;

/** 出厂的四段。compile-all 的预编译守卫与引擎共用这一份，不各写一份清单。 */
export const DEFAULT_PARTICLE_SHADERS: ParticleShaders = {
  init: INIT_FRAG,
  stepPos: STEP_POS_FRAG,
  stepVel: STEP_VEL_FRAG,
  pointFrag: POINT_FRAG,
  pointVert: POINT_VERT,
};
