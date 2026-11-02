/**
 * lut-cube.ts — Adobe `.cube` 的解析（纯函数）。
 *
 * 两种形态：`LUT_3D_SIZE`（三维查找表）与 `LUT_1D_SIZE`（三条独立的曲线）。
 * 1D 在这里就**展开成 3D**（`out.r = t1d[r]` 等）—— 之后引擎只认一种纹理格式，
 * 着色器里也只有一条采样路径。展开是精确的：可分离的 1D LUT 在 3D 网格上
 * 采样得到的结果与逐通道查表完全相同。
 *
 * ## 数据顺序
 *
 * `.cube` 的行序是 **R 变化最快**，然后 G，最后 B —— 与 OpenGL 的
 * `TEXTURE_3D` 上传顺序一致，所以可以直接按行读进纹理，不需要重排。
 * 写反时的症状是「红色通道变成了蓝色」，而且不报错。
 *
 * ## DOMAIN_MIN / DOMAIN_MAX
 *
 * 有些 LUT（尤其是 Log 编码素材的）定义域不是 0..1。解析后一律归一化到
 * `0..1`，因为着色器里的输入是 0..1 的线性值。**归一化只做一次、在这里做** ——
 * 在着色器里做会让「同一个 LUT 在两个模块里结果不同」。
 */

/** 解析结果的纹理数据：`size³` 个 RGBA 节点，值域 0..1。 */
export interface ParsedLut {
  /** 每边的节点数（2..64）。 */
  size: number;
  /** 是否由 1D 展开而来（只用于展示「1D 已展开」）。 */
  from1D: boolean;
  /** `size³ × 4`，RGBA（a 恒为 1）。 */
  data: Float32Array;
}

export type LutParseError = 'no-size' | 'bad-size' | 'bad-number' | 'short-data' | 'bad-domain';

export type LutParseResult = { ok: true; lut: ParsedLut } | { ok: false; reason: LutParseError };

const MAX_SIZE = 64;

/**
 * 解析 `.cube` 文本。
 *
 * **永不抛**：LUT 文件是用户从网上抓的，格式五花八门（Tab 分隔、行尾 CRLF、
 * 带 BOM、注释在任意行）。坏文件的表现必须是「面板上说这条 LUT 读不了」，
 * 而不是整个渲染循环停摆。
 */
export function parseCubeLut(text: string): LutParseResult {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim());

  let size3d = 0;
  let size1d = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const rows: number[][] = [];

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('TITLE')) continue;
    if (upper.startsWith('LUT_3D_SIZE')) {
      size3d = Number.parseInt(line.split(/\s+/)[1] ?? '', 10);
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      size1d = Number.parseInt(line.split(/\s+/)[1] ?? '', 10);
      continue;
    }
    if (upper.startsWith('DOMAIN_MIN')) {
      // 关键字自己也占一个 token —— 不跳过它就永远解析成 NaN（bad-domain）。
      const n = readTriple(line, 1);
      if (!n) return { ok: false, reason: 'bad-domain' };
      domainMin = n;
      continue;
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      const n = readTriple(line, 1);
      if (!n) return { ok: false, reason: 'bad-domain' };
      domainMax = n;
      continue;
    }
    // 其余的应当是数据行（三个浮点）。认不出的行直接跳过 —— TITLE 之外的
    // 第三方扩展键（`LUT_3D_INPUT_RANGE` 之类）不该让整份 LUT 作废。
    const n = readTriple(line);
    if (n) rows.push([...n, 1]);
  }

  const size = size3d || size1d;
  if (!size) return { ok: false, reason: 'no-size' };
  if (!Number.isFinite(size) || size < 2 || size > MAX_SIZE) return { ok: false, reason: 'bad-size' };

  const span: [number, number, number] = [
    domainMax[0] - domainMin[0] || 1,
    domainMax[1] - domainMin[1] || 1,
    domainMax[2] - domainMin[2] || 1,
  ];
  const norm = (v: number[]): number[] => [
    clamp01((v[0]! - domainMin[0]) / span[0]),
    clamp01((v[1]! - domainMin[1]) / span[1]),
    clamp01((v[2]! - domainMin[2]) / span[2]),
  ];

  if (size3d) {
    const need = size3d * size3d * size3d;
    if (rows.length < need) return { ok: false, reason: 'short-data' };
    const data = new Float32Array(need * 4);
    for (let i = 0; i < need; i += 1) {
      const [r, g, b] = norm(rows[i]!);
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 1;
    }
    return { ok: true, lut: { size: size3d, from1D: false, data } };
  }

  // 1D：N 行分别是 R 输入、G 输入、B 输入对应的输出色。展开成 N³ 网格。
  if (rows.length < size1d) return { ok: false, reason: 'short-data' };
  const table = rows.slice(0, size1d).map(norm);
  const data = new Float32Array(size1d * size1d * size1d * 4);
  let w = 0;
  for (let b = 0; b < size1d; b += 1) {
    for (let g = 0; g < size1d; g += 1) {
      for (let r = 0; r < size1d; r += 1) {
        data[w] = table[r]![0];
        data[w + 1] = table[g]![1];
        data[w + 2] = table[b]![2];
        data[w + 3] = 1;
        w += 4;
      }
    }
  }
  return { ok: true, lut: { size: size1d, from1D: true, data } };
}

/** 读行尾的三个浮点。`skip` 用于关键字开头的行（`DOMAIN_MIN 0 0 0`）。 */
function readTriple(line: string, skip = 0): [number, number, number] | null {
  const parts = line.split(/[\s,]+/).filter(Boolean);
  if (parts.length < skip + 3) return null;
  const a = Number(parts[skip]);
  const b = Number(parts[skip + 1]);
  const c = Number(parts[skip + 2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  return [a, b, c];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
