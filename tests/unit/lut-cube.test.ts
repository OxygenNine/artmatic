import { describe, expect, it } from 'vitest';
import { parseCubeLut } from '../../src/core/lut-cube';

/**
 * `.cube` 解析的守卫。
 *
 * 判据取「写错会静默偏色」的那一面：
 *  - 行序是 **R 变化最快**（与 `TEXTURE_3D` 上传一致），写反 → 红蓝互换；
 *  - `DOMAIN_MIN/MAX` 归一化只做一次 → 不做的话整幅压死或发灰；
 *  - 坏文件必须**返回失败**而不是抛异常（LUT 来自互联网，格式五花八门）。
 */

/** 2×2×2 的恒等 LUT，按 R 最快的行序。 */
const IDENTITY_2 = `# identity
TITLE "id"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('3D LUT', () => {
  it('读出尺寸与节点数，值是恒等', () => {
    const r = parseCubeLut(IDENTITY_2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lut.size).toBe(2);
    expect(r.lut.from1D).toBe(false);
    // 第 i 个节点 = (r,g,b) 按 R 最快展开
    for (let i = 0; i < 8; i += 1) {
      const r0 = i & 1;
      const g0 = (i >> 1) & 1;
      const b0 = (i >> 2) & 1;
      expect([r.lut.data[i * 4], r.lut.data[i * 4 + 1], r.lut.data[i * 4 + 2]]).toEqual([r0, g0, b0]);
      expect(r.lut.data[i * 4 + 3]).toBe(1);
    }
  });

  it('注释、空行、CRLF、BOM 都不影响解析', () => {
    const messy = `\uFEFF# c\r\n\r\nTITLE "x"\r\nLUT_3D_SIZE 2\r\n` + IDENTITY_2.split('\n').slice(3).join('\r\n');
    expect(parseCubeLut(messy).ok).toBe(true);
  });

  it('DOMAIN_MIN / DOMAIN_MAX 归一化到 0..1', () => {
    const r = parseCubeLut(`LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 2 2 2
0 0 0
2 0 0
0 2 0
2 2 0
0 0 2
2 0 2
0 2 2
2 2 2
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 每个节点除以 2：末节点 (2,2,2) → 1；节点 3 是 (2,2,0) → (1,1,0)
    const last = (8 - 1) * 4;
    expect([r.lut.data[last], r.lut.data[last + 1], r.lut.data[last + 2]]).toEqual([1, 1, 1]);
    const third = 3 * 4;
    expect([r.lut.data[third], r.lut.data[third + 1], r.lut.data[third + 2]]).toEqual([1, 1, 0]);
  });

  it('数据不足 → short-data（不抛）', () => {
    const r = parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n');
    expect(r).toEqual({ ok: false, reason: 'short-data' });
  });
});

describe('1D LUT', () => {
  it('展开成 3D：通道各自查自己那张表', () => {
    // 2 点：R 恒等、G 反相、B 恒 0.5
    const r = parseCubeLut(`LUT_1D_SIZE 2
0 1 0.5
1 0 0.5
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lut.from1D).toBe(true);
    expect(r.lut.size).toBe(2);
    // 节点 (r=1, g=0, b=0)：R 取表[1].r=1、G 取表[0].g=1、B 取表[0].b=0.5
    const idx = 1; // r=1,g=0,b=0 → i = r + 2g + 4b
    expect([r.lut.data[idx * 4], r.lut.data[idx * 4 + 1], r.lut.data[idx * 4 + 2]]).toEqual([1, 1, 0.5]);
  });
});

describe('坏输入', () => {
  it('没有尺寸 → no-size', () => {
    expect(parseCubeLut('0 0 0\n1 1 1\n')).toEqual({ ok: false, reason: 'no-size' });
  });

  it('尺寸非法 → bad-size', () => {
    expect(parseCubeLut('LUT_3D_SIZE 1\n0 0 0\n')).toEqual({ ok: false, reason: 'bad-size' });
    expect(parseCubeLut('LUT_3D_SIZE 999\n0 0 0\n')).toEqual({ ok: false, reason: 'bad-size' });
  });

  it('空串 / 纯注释 → 失败而不是抛', () => {
    expect(parseCubeLut('').ok).toBe(false);
    expect(parseCubeLut('# nothing here').ok).toBe(false);
  });

  it('未知扩展键被跳过，不影响后面的数据行', () => {
    const r = parseCubeLut(`LUT_3D_SIZE 2
LUT_3D_INPUT_RANGE 0 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`);
    expect(r.ok).toBe(true);
  });

  it('Tab / 逗号分隔都认', () => {
    const r = parseCubeLut('LUT_3D_SIZE 2\n' + '0\t0\t0\n1,0,0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    expect(r.ok).toBe(true);
  });
});
