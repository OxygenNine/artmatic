import { describe, expect, it } from 'vitest';
import {
  PRICE_BOOKS,
  beijingClock,
  costOf,
  isPeak,
  parseBalance,
  priceEntryOf,
  tokensOf,
} from '../../src/agent/llm/billing';

/**
 * 计费的守卫。三条判据都不难写错、也都不会报错：
 *   1. **时区**：本机时区不是北京时，价格整整差一倍；
 *   2. **时段边界**：12:00 / 18:00 是左闭右开，写错就多算一格；
 *   3. **最长前缀**：`deepseek-flash` 与 `deepseek-flash-vision` 同价，但
 *      `deepseek-v4-pro` 与 `deepseek-v4-flash` 差四倍 —— 取错条目就是四倍的错账。
 */

describe('峰谷判定（北京时间）', () => {
  it('峰段左闭右开：9:00 与 11:59 是峰，12:00 是谷，14:00 又是峰', () => {
    // 2026-11-12 是周四。UTC+8 ⇒ BJ = UTC + 8h。
    expect(isPeak(Date.parse('2026-11-12T01:00:00Z'))).toBe(true); // BJ 09:00
    expect(isPeak(Date.parse('2026-11-12T03:59:00Z'))).toBe(true); // BJ 11:59
    expect(isPeak(Date.parse('2026-11-12T04:00:00Z'))).toBe(false); // BJ 12:00
    expect(isPeak(Date.parse('2026-11-12T06:00:00Z'))).toBe(true); // BJ 14:00
    expect(isPeak(Date.parse('2026-11-12T10:00:00Z'))).toBe(false); // BJ 18:00
  });

  it('按北京时间而不是本机时区：UTC 23:00 已经是北京的次日 07:00（谷）', () => {
    expect(beijingClock(Date.parse('2026-11-12T23:00:00Z'))).toEqual({
      key: '2026-11-13',
      weekday: 5,
      hour: 7,
    });
    expect(isPeak(Date.parse('2026-11-12T23:00:00Z'))).toBe(false);
    // 同一时刻在北京是凌晨，在 UTC 是夜里 —— 读本机时区会把它算成峰段。
    expect(isPeak(Date.parse('2026-11-12T01:30:00Z'))).toBe(true);
  });

  it('周末整天是谷价', () => {
    // 2026-11-14 周六、11-15 周日；两周后的周一是 11-16。
    expect(isPeak(Date.parse('2026-11-14T02:00:00Z'))).toBe(false); // 周六 BJ 10:00
    expect(isPeak(Date.parse('2026-11-15T06:00:00Z'))).toBe(false); // 周日 BJ 14:00
    expect(isPeak(Date.parse('2026-11-16T02:00:00Z'))).toBe(true); // 周一 BJ 10:00
  });

  it('节假日表命中就是谷价（表本身是空的，见源码注释）', () => {
    const at = Date.parse('2026-11-12T02:00:00Z');
    expect(isPeak(at)).toBe(true);
    expect(isPeak(at, new Set(['2026-11-12']))).toBe(false);
  });
});

describe('价目表', () => {
  it('flash 与 pro 相差数倍，不能靠「前缀都匹配」随便取一个', () => {
    const flash = priceEntryOf('deepseek', 'deepseek-flash');
    const pro = priceEntryOf('deepseek', 'deepseek-v4-pro');
    expect(flash?.entry.idle.miss).toBe(1);
    expect(pro?.entry.idle.miss).toBe(4.5);
    expect(flash?.entry.idle.miss).not.toBe(pro?.entry.idle.miss);
  });

  it('旧模型名按当前在售模型同价计', () => {
    expect(priceEntryOf('deepseek', 'deepseek-v4-flash-vision-exp')?.entry.idle).toEqual(
      priceEntryOf('deepseek', 'deepseek-flash')?.entry.idle,
    );
  });

  it('没有价目数据的提供商 / 模型返回 null（面板据此不显示，而不是显示 0）', () => {
    expect(priceEntryOf('deepseek', 'gpt-6.1-terra')).toBeNull();
    expect(priceEntryOf('openai', 'gpt-6.1-terra')).toBeNull();
  });

  it('峰价是谷价的两倍（官方口径，改价时两半都要改）', () => {
    for (const entry of PRICE_BOOKS.deepseek!.models) {
      expect(entry.peak.miss).toBeCloseTo(entry.idle.miss * 2, 6);
      expect(entry.peak.out).toBeCloseTo(entry.idle.out * 2, 6);
      expect(entry.peak.hit).toBeCloseTo(entry.idle.hit * 2, 6);
    }
  });
});

describe('costOf', () => {
  const idle = Date.parse('2026-11-12T12:00:00Z'); // BJ 20:00
  const peak = Date.parse('2026-11-12T02:00:00Z'); // BJ 10:00

  it('一百万未命中输入 = 1 元（谷）/ 2 元（峰）', () => {
    const tokens = { hit: 0, miss: 1_000_000, out: 0 };
    expect(costOf('deepseek', 'deepseek-flash', tokens, idle)?.total).toBe(1);
    expect(costOf('deepseek', 'deepseek-flash', tokens, peak)?.total).toBe(2);
  });

  it('命中价（0.02）与输出价（4）都真的参与计算，不是只看 miss', () => {
    const c = costOf('deepseek', 'deepseek-flash', { hit: 1_000_000, miss: 0, out: 1_000_000 }, idle)!;
    expect(c.input).toBeCloseTo(0.02, 6);
    expect(c.output).toBeCloseTo(4, 6);
    expect(c.total).toBeCloseTo(4.02, 6);
  });

  it('返回里带上时段与三档 token（面板 tooltip 用），币种跟着价目表', () => {
    const c = costOf('deepseek', 'deepseek-flash', { hit: 10, miss: 20, out: 30 }, peak)!;
    expect(c).toMatchObject({ currency: 'CNY', peak: true, hit: 10, miss: 20, out: 30 });
  });
});

describe('tokensOf（两种计费口径）', () => {
  it('DeepSeek：prompt_tokens = 命中 + 未命中', () => {
    expect(tokensOf({ prompt_tokens: 1000, prompt_cache_hit_tokens: 800, completion_tokens: 120 })).toEqual({
      hit: 800,
      miss: 200,
      out: 120,
    });
  });

  it('没上报命中数时整段输入按未命中计（宁可多算，不能少算）', () => {
    expect(tokensOf({ prompt_tokens: 500, completion_tokens: 10 })).toEqual({ hit: 0, miss: 500, out: 10 });
  });

  it('Anthropic 是减法口径：input_tokens 不含缓存读写', () => {
    expect(
      tokensOf({
        input_tokens: 300,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 50,
        output_tokens: 20,
      }),
    ).toEqual({ hit: 700, miss: 350, out: 20 });
  });

  it('null 不炸', () => {
    expect(tokensOf(null)).toEqual({ hit: 0, miss: 0, out: 0 });
  });
});

describe('parseBalance', () => {
  it('金额是字符串，要转成数字；赠金与充值分列', () => {
    expect(
      parseBalance({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.34', topped_up_balance: '10.00' }],
      }),
    ).toEqual({ available: true, infos: [{ currency: 'CNY', total: 12.34, granted: 2.34, toppedUp: 10 }] });
  });

  it('不认识的响应返回 null，而不是「余额 0」（那是在说账户空了）', () => {
    expect(parseBalance({})).toBeNull();
    expect(parseBalance({ balance_infos: [] })).toBeNull();
    expect(parseBalance(null)).toBeNull();
  });

  it('is_available:false 要透传（余额不够时调用会被拒）', () => {
    expect(
      parseBalance({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] })?.available,
    ).toBe(false);
  });
});
