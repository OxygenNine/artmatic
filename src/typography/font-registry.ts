/**
 * font-registry.ts — 运行期字体表。
 *
 * 工程文件里只存**引用**（FontRef），字节由这里持有（AGENTS §1.7 的
 * 「素材用引用而非拷贝」）。字节由运行期持有，对外接口不变。
 *
 * ## 为什么按 **face** 组织而不是按族
 *
 * Inter 的 400 与 700 是**两个文件**。如果一族只存一份字节，粗体就只能在
 * 光栅化时被浏览器合成出来，而舞台用的是真正的 700 字面 —— 于是「预览是
 * 真粗体、导出是合成粗体」，字宽和笔画都不同。这类差异肉眼很难描述，
 * 但逐像素一比就是几万个像素。
 *
 * 所以这里的最小单位是 face：`family + weight + style` 一条。
 * `localFonts()` 把用到的族展开成多条，每条带上 weight/style，snapDOM 才会
 * 按与浏览器同一套规则选面。
 *
 * ## 三个阶段的划分（刻意的）
 *
 *   register*   —— 注册（内存里放一条记录）
 *   ensure()    —— 异步准备：等 document.fonts.ready、load face、
 *                  把字节编码成 data URL（P7 会把「子集化」插在这一步）
 *   localFonts()—— 同步取用，在光栅化的热路径上调用
 *
 * 编码放 ensure() 是因为 base64 一个 9 MB 的字体要几十毫秒 —— 放进每帧的
 * 光栅化路径等于每帧都付一次。
 */

import type { FontRef, TypographyDocument } from './document';
import { collectGlyphs, usedFontFamilies } from './document';
import type { FontAsset, FontProvider } from './font-provider';
import { subsetFont } from './font/subset-hb';
import { pickCssWeight } from './font/css-weight';
import { fnv1a } from './cache-key';

export interface FontFaceSource {
  /** `${family}/${weight}/${style}`，进程内唯一。 */
  id: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** 原始字节。内置字体首次 ensure 时经 fetch 载入后缓存于此。 */
  bytes: ArrayBuffer | null;
  /** 内置字体的 URL；用户字体为 null（字节已在内存里）。 */
  url: string | null;
  mime: string;
  /** ensure() 阶段备好的 data URL（P7 的子集化产物也放这里）。 */
  dataUrl: string | null;
  /**
   * `dataUrl` 对应的**字形集键**。
   *
   * 没有它的时候，`prepareDataUrl` 每次 ensure 都会重新 base64 一遍：子集化
   * 命中缓存了，但 `dataUrlFor()` 仍然 O(字节数)。woff2（不可子集化）或整量
   * 回退时这是每帧几十到上百毫秒 —— 而 ensure 是**每次光栅化**都调的。
   */
  dataUrlKey?: string;
  loaded: boolean;
  /**
   * 随软件分发的内置字体。它们**保证**在包内（打包产物里的资源），所以
   * `missing()` 不对「尚未 loaded」的内置字体报警 —— 否则每次新建文本框都会
   * 在首次 fetch 完成前闪一条「字体「Inter」还没准备好，暂时用回落字体渲染」，
   * 而 Inter 明明就在包里。真正加载失败（`failed`）才报。
   */
  bundled?: boolean;
  /** 加载抛错（URL 404 / 字节损坏）。`missing()` 用它区分「在途」与「真的没有」。 */
  failed?: boolean;
}

/**
 * 随软件分发的内置字体（OFL，见 public/fonts/OFL.txt）。
 *
 * **用 TTF 而不是 woff2**：`FontFace` 两者都吃，但文本转路径要交给 HarfBuzz ——
 * 它只认 SFNT，woff2 取不到任何字形（`nominalGlyph` 全 undefined）。TTF 是由
 * 同名 woff2 **无损解压**出来的（`scripts/fonts-woff2-to-sfnt.mjs`），字形与
 * 度量逐字节相同，所以渲染不会变；顺带让内置字体也能走子集化（woff2 不行）。
 * woff2 文件仍留在 public/fonts 里：E2E 用它模拟「用户导入的 woff2 字体」。
 */
export const BUILTIN_FONTS: { family: string; file: string; weight: number; style: 'normal' | 'italic' }[] = [
  // 无衬线（默认）。`document.DEFAULT_FONT_FAMILY` 指向它。
  { family: 'Inter', file: 'inter-latin-400.ttf', weight: 400, style: 'normal' },
  { family: 'Inter', file: 'inter-latin-700.ttf', weight: 700, style: 'normal' },
  // 等宽：算法艺术里贴代码 / 参数 / 数字阵列时的默认手。
  { family: 'JetBrains Mono', file: 'jetbrains-mono-latin-400.ttf', weight: 400, style: 'normal' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono-latin-700.ttf', weight: 700, style: 'normal' },
  // 衬线：高对比度标题。
  { family: 'Lora', file: 'lora-latin-400.ttf', weight: 400, style: 'normal' },
  { family: 'Lora', file: 'lora-latin-700.ttf', weight: 700, style: 'normal' },
  // 装饰：几何圆体，算法艺术海报的常见选择。
  { family: 'Outfit', file: 'outfit-latin-400.ttf', weight: 400, style: 'normal' },
  { family: 'Outfit', file: 'outfit-latin-700.ttf', weight: 700, style: 'normal' },
];

/** btoa 一次吃不下大字体，分块编码。 */
export function bytesToBase64(bytes: Uint8Array, chunk = 0x8000): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

export function dataUrlFor(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/**
 * 一个 URL 包成 CSS 的 `src` 值：`/fonts/x.woff2` → `url("/fonts/x.woff2")`。
 *
 * `FontFace(family, source)` 的字符串形式走的是 **CSS src 值列表**的解析器，
 * 裸 URL 会被判成语法错误（`The source provided ('/fonts/…') could not be
 * parsed as a value list`）—— 而浏览器分不清「语法错」与「文件坏了」，
 * 于是内置字体的**预加载**那条路（此时只有 URL、字节要等 ensure 才 fetch）
 * 每次启动都报一次失败，`missing()` 还会据此闪一条「字体未就绪」。
 * 反斜杠先逃，否则会把后面那次转义再吃一层。
 */
export function cssUrl(url: string): string {
  return `url("${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

/** 是否可以被 HarfBuzz 子集化。**只有 SFNT（TTF/OTF）可以**，woff/woff2 不行。 */
export function isSubsettable(mime: string): boolean {
  return mime === 'font/ttf' || mime === 'font/otf';
}

/** 从文件名猜 MIME。猜到什么只影响 data URL 的类型标注，不影响渲染。 */
export function mimeForFilename(name: string): string {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  if (ext === '.otf') return 'font/otf';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.woff') return 'font/woff';
  return 'font/ttf';
}

/** 从文件名猜字体族名（去扩展名与分隔符）。 */
export function familyFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Imported';
}

/** `familyRenders` 的缓存。字体不会中途消失，命中率接近 100%。 */
const rendersCache = new Map<string, boolean>();

/**
 * 这个族名**能不能渲染** —— 系统字体也算。
 *
 * 用**双基线宽差**法：同一串字分别在三个差异很大的 fallback 下量宽。
 *  - 指定的族真的存在 ⇒ 三次都用它，宽度**相同**；
 *  - 族不存在 ⇒ 各自回落到不同的 fallback，宽度**不同**。
 *
 * 为什么不用 `document.fonts.check()`：它在这件事上完全没有判断力 ——
 * 本机实测 `check('16px "DefinitelyNotARealFont12345"')` 照样返回 `true`
 * （它问的是「这个规格有没有可用字体」，而 fallback 永远算「有」）。
 *
 * Node（没有 document）里返回 `true`：无从判断时**不要误报**。
 */
export function familyRenders(family: string): boolean {
  const name = family.trim();
  if (!name) return false;
  const cached = rendersCache.get(name);
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined') return true;

  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return true;

  /*
   * 探测串必须**纯 ASCII**：`src/` 下（语言文件除外）不许出现中日韩字面量，
   * 这条有 `i18n.test.ts` 的守卫钉着。而对「宽度是否有差异」来说，一组宽窄
   * 悬殊的 ASCII 字符已经够了 —— 用中文字符并不会让它更准。
   */
  const probe = 'mmmmmmmmmmlliWQXYZ0123456789@#%&';
  const widths = ['monospace', 'serif', 'sans-serif'].map((fallback) => {
    ctx.font = `72px "${name}", ${fallback}`;
    return ctx.measureText(probe).width;
  });
  // 三次测量都一样 ⇒ 用的一直是那个族本身（存在）；有差异 ⇒ 发生了回落（不存在）。
  const ok = Math.max(...widths) - Math.min(...widths) < 0.01;
  rendersCache.set(name, ok);
  return ok;
}

/**
 * CSS Fonts 4 §5.2.2 的 weight 匹配。
 *
 * 定义搬到了 `font/css-weight.ts`（本机字体匹配也要用同一套，且不该为此
 * 把字体注册表与 HarfBuzz 拉进单测）；这里只做转出，保持既有 import 路径可用。
 */
export { pickCssWeight } from './font/css-weight';

export class FontRegistry implements FontProvider {
  /** face id → face */
  private readonly faces = new Map<string, FontFaceSource>();
  /** family → face ids（保持注册顺序，localFonts 的输出才稳定）。 */
  private readonly byFamily = new Map<string, string[]>();
  /** 正在进行的 ensure，避免同一族被并发加载两次。 */
  private readonly inflight = new Map<string, Promise<void>>();
  /** 每次注册 +1。UI 用它触发重算（字体下拉的内容会变）。 */
  revision = 0;

  /**
   * 子集缓存：`faceId|glyphHash` → 子集字节。
   *
   * 字形集只在用户打字时变化，所以命中率极高 —— 这正是 ADR-003 规则 ①
   * 「按字形集哈希缓存」的全部意义：把 14 ms 的冷路径摊销到打字那次，
   * 之后每帧都只剩内联成本。
   */
  private readonly subsetCache = new Map<string, Uint8Array>();
  /** 冷路径/热路径计数与耗时，供测试与 ADR 取数。 */
  readonly subsetStats = { computed: 0, cacheHits: 0, lastMs: 0, lastFullBytes: 0, lastSubsetBytes: 0 };

  /**
   * 关掉子集化（退回整体内联）。
   *
   * 存在的唯一理由是**验证**：ADR-003 的「子集 vs 全量逐像素零差异」这条断言
   * 需要一个对照组。光栅化慢 100 倍，但结果必须一模一样 —— 一旦不一样，
   * 就说明子集改动过字形或度量。
   */
  subsetting = true;

  /** 清掉所有已备好的 data URL 与子集缓存（切开关后必须调，否则读到旧值）。 */
  invalidatePrepared(): void {
    this.subsetCache.clear();
    for (const face of this.faces.values()) {
      face.dataUrl = null;
      face.dataUrlKey = undefined;
    }
    this.inflight.clear();
  }

  /** 面孔快照（测试与 ADR 取数用）。 */
  faceReports(): { id: string; mime: string; fullBytes: number; dataUrlLen: number }[] {
    return [...this.faces.values()].map((f) => ({
      id: f.id,
      mime: f.mime,
      fullBytes: f.bytes?.byteLength ?? 0,
      dataUrlLen: f.dataUrl?.length ?? 0,
    }));
  }

  /** 内置字体：只登记 URL，第一次 ensure 时才 fetch。 */
  registerBuiltin(family: string, url: string, weight = 400, style: 'normal' | 'italic' = 'normal', mime = 'font/woff2'): void {
    const face = this.put({ family, url, weight, style, mime, bytes: null });
    face.bundled = true;
  }

  /** 把随软件分发的内置字体全部登记一遍（幂等），并**主动预加载**。 */
  registerBundled(): void {
    const base = import.meta.env?.BASE_URL ?? '/';
    for (const f of BUILTIN_FONTS) {
      // MIME 必须按文件名推断：写死 woff2 会让 TTF 走「不可子集化」那条路。
      this.registerBuiltin(f.family, `${base}fonts/${f.file}`, f.weight, f.style, mimeForFilename(f.file));
    }
    // 预加载：内置字体是本地资源，随用随 fetch 会让首帧用回落字体量度，
    // 也可能在 `document.fonts.ready` 之前被光栅化。失败只置 `failed`，
    // 不打断启动（`missing()` 会据此提示，但不会因为「在途」而误报）。
    if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
    for (const f of BUILTIN_FONTS) {
      const face = this.faces.get(`${f.family}/${f.weight}/${f.style}`);
      if (face) void this.loadFace(face);
    }
  }

  /** 用户导入的字体。字节立刻可用，但仍要 await face.load() 才算真正可用。 */
  async registerFile(name: string, bytes: ArrayBuffer, family?: string): Promise<FontFaceSource> {
    const face = this.put({
      family: family ?? familyFromFilename(name),
      bytes,
      url: null,
      weight: 400,
      style: 'normal',
      mime: mimeForFilename(name),
    });
    await this.loadFace(face);
    return face;
  }

  private put(spec: {
    family: string;
    bytes: ArrayBuffer | null;
    url: string | null;
    weight: number;
    style: 'normal' | 'italic';
    mime: string;
  }): FontFaceSource {
    const id = `${spec.family}/${spec.weight}/${spec.style}`;
    const existing = this.faces.get(id);
    if (existing) {
      // 同 id 重复注册：更新字节来源，不产生第二条。
      const bytesChanged = spec.bytes !== null && existing.bytes !== spec.bytes;
      const urlChanged = spec.url !== null && existing.url !== spec.url;
      if (spec.bytes) existing.bytes = spec.bytes;
      if (spec.url) existing.url = spec.url;
      if (bytesChanged || urlChanged) {
        /*
         * 换了字节就必须把「已备好的表现」全部作废：data URL / 子集缓存 /
         * loaded 标志。漏掉任何一项的表现都是「换了字体文件，画面还是旧的」，
         * 而且刷新也未必恢复（子集缓存按 face id 命中）。
         */
        existing.dataUrl = null;
        existing.dataUrlKey = undefined;
        existing.loaded = false;
        existing.failed = false;
        const prefix = `${existing.id}|`;
        for (const key of this.subsetCache.keys()) {
          if (key.startsWith(prefix)) this.subsetCache.delete(key);
        }
      }
      return existing;
    }
    const face: FontFaceSource = {
      id,
      family: spec.family,
      weight: spec.weight,
      style: spec.style,
      bytes: spec.bytes,
      url: spec.url,
      mime: spec.mime,
      dataUrl: null,
      loaded: false,
    };
    this.faces.set(id, face);
    const list = this.byFamily.get(spec.family) ?? [];
    list.push(id);
    this.byFamily.set(spec.family, list);
    this.revision += 1;
    return face;
  }

  has(family: string): boolean {
    return this.byFamily.has(family);
  }

  families(): string[] {
    return [...this.byFamily.keys()];
  }

  facesOf(family: string): FontFaceSource[] {
    return (this.byFamily.get(family) ?? []).map((id) => this.faces.get(id)!);
  }

  /**
   * 按 **CSS Fonts 4 的字体匹配**挑一个 face（文本转路径用）。
   *
   * 为什么不能只找完全相同的 weight / style：`font-weight: 500` 在一族只有
   * 400 与 700 时浏览器用的是 400 —— 只认精确匹配的话，滑杆停在 500 的标题
   * 会莫名其妙「找不到字体」。而匹配到的面与请求的 weight 差得远时，浏览器
   * 会用**合成粗体**，那是轮廓数据里没有的东西：这时 `syntheticBold` 为 true，
   * 调用方必须拒绝转换（否则转出来的是不粗的字）——除非字体文件本身带
   * `wght` 变量轴，那就不是合成，按轴取值即可（调用方自己判断）。
   *
   * 两个合成标志**分开报**：斜体是倾斜变换，变量轴救不了；粗体可能被轴救。
   */
  pickFace(
    family: string,
    weight: number,
    style: 'normal' | 'italic',
  ): { face: FontFaceSource; syntheticBold: boolean; syntheticItalic: boolean } | null {
    const faces = this.facesOf(family);
    if (!faces.length) return null;

    const sameStyle = faces.filter((f) => f.style === style);
    const pool = sameStyle.length ? sameStyle : faces;
    const syntheticItalic = style === 'italic' && pool[0]!.style !== 'italic';

    const weights = [...new Set(pool.map((f) => f.weight))].sort((a, b) => a - b);
    const wanted = pickCssWeight(weight, weights);
    const chosen = pool.find((f) => f.weight === wanted) ?? pool[0]!;
    // 只有「要粗体、拿到的是常规字面」才需要合成粗体；500 → 400 浏览器不合成。
    const syntheticBold = weight >= 600 && chosen.weight < 600;
    return { face: chosen, syntheticBold, syntheticItalic };
  }

  /**
   * 取一个 face 的 **SFNT 字节**（内置字体按需 fetch）。
   *
   * 返回 null 表示「拿不到可用轮廓」：woff2 / woff（HarfBuzz 解不了）、
   * fetch 失败、或本来就没有字节（系统字体）。
   */
  async sfntBytes(face: FontFaceSource): Promise<ArrayBuffer | null> {
    if (!isSubsettable(face.mime)) return null;
    if (!face.bytes && face.url) {
      try {
        const res = await fetch(face.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        face.bytes = await res.arrayBuffer();
      } catch (err) {
        console.warn(`[typo] font ${face.url} failed to load`, err);
        return null;
      }
    }
    return face.bytes ?? null;
  }

  /** 文档用到但未注册的族。UI 的「字体未就绪」横幅读这个。 */
  /**
   * 文档用到的字体里，**注册表承诺要提供、但还没备好**的族名。
   *
   * 判据不能写成「不在注册表里就报缺失」—— 那会把**系统字体**一律报成缺失：
   * 用户在「本机字体」里选一个（或打开一份从别的机器带来的工程），立刻跳出
   * 「字体…未就绪，正在用回落字体」，而画面上明明渲染得好好的。
   *
   * 也没法靠浏览器来判：`document.fonts.check('16px "编造的族名"')` 同样返回
   * `true`（本机实测），所以「浏览器说不认识」这条路根本走不通。于是判据收缩成
   * **只对我们自己登记过的族负责**：
   *
   *  - 登记过、但 face 还没 `loaded` ⇒ 真的没就绪（内置字体首次 fetch）；
   *  - 压根没登记过 ⇒ 不是我们的责任，交给浏览器按系统字体处理。
   *
   * ⚠️ 判据是 **`loaded` 而不是 `dataUrl`**，这两个不是一回事：
   * `loaded` = FontFace 已进 `document.fonts`（**能不能渲染**）；
   * `dataUrl` = 导出时光栅化要内联的那份字节，只在 `ensure()` 里生成
   * （**导出能不能内联**）。拿 `dataUrl` 当判据的话，用户导入一个字体之后
   * 显示完全正常，却一直被告知「未就绪，正在用回落字体」—— 而导出流程本来就
   * 会自己 await `ensure()`，不需要提前警告。
   *
   * 没登记过的族名也不能一律放过：那里面既有**系统字体**（能渲染，不该报），
   * 也有**拼错的字体名**（该报）。两者的区别只能问渲染层，见 `familyRenders`。
   */
  missing(doc: TypographyDocument): string[] {
    return usedFontFamilies(doc).filter((f) => {
      const ids = this.byFamily.get(f);
      if (ids?.length) {
        return ids.some((id) => {
          const face = this.faces.get(id);
          if (!face) return false;
          // 内置字体随包分发 ⇒「尚未 loaded」只表示还在 fetch，不是缺失
          // （判据见 FontFaceSource.bundled）；真的加载失败才报。
          if (face.bundled) return face.failed === true && !face.loaded;
          return !face.loaded;
        });
      }
      return !familyRenders(f);
    });
  }

  ready(doc: TypographyDocument): boolean {
    return this.missing(doc).length === 0;
  }

  /**
   * snapDOM 的显式字体素材。**同步** —— 数据已在 ensure() 阶段备好。
   * 一个族有几条 face 就报几条，weight/style 带上，snapDOM 才选得对。
   */
  localFonts(doc: TypographyDocument): FontAsset[] | undefined {
    const out: FontAsset[] = [];
    for (const family of usedFontFamilies(doc)) {
      for (const face of this.facesOf(family)) {
        if (!face.dataUrl) continue;
        out.push({
          family: face.family,
          src: face.dataUrl,
          weight: face.weight,
          style: face.style,
        });
      }
    }
    return out.length ? out : undefined;
  }

  async ensure(doc: TypographyDocument): Promise<void> {
    const families = usedFontFamilies(doc);
    // 子集化的输入是「整篇文档用到的码点」。按族分别裁，因为
    // 一个族可能有多个 face（Inter 的 400 与 700 是两个文件）。
    const glyphs = collectGlyphs(doc);
    await Promise.all(families.map((f) => this.ensureFamily(f, glyphs)));
    // ADR-003 规则 ③：不等 fonts.ready 的话首帧会用回落字体量度，
    // 导出与预览不一致，而且「看起来都正常」，极难定位。
    if (typeof document !== 'undefined' && document.fonts) {
      await document.fonts.ready;
    }
  }

  private ensureFamily(family: string, glyphs: string): Promise<void> {
    const running = this.inflight.get(family);
    if (running) return running;
    const ids = this.byFamily.get(family);
    if (!ids?.length) return Promise.resolve();

    const job = (async () => {
      for (const id of ids) {
        const face = this.faces.get(id);
        if (!face) continue;
        if (!face.bytes && face.url) {
          try {
            const res = await fetch(face.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            face.bytes = await res.arrayBuffer();
          } catch (err) {
            // 拉不到就当作缺字体：渲染会用回落字体，比整个流程崩掉好。
            console.warn(`[typo] 内置字体 ${face.url} 加载失败`, err);
            continue;
          }
        }
        if (!face.loaded) await this.loadFace(face);
        await this.prepareDataUrl(face, glyphs);
      }
    })();

    this.inflight.set(family, job);
    // 失败也要摘掉，否则该族永久停在「加载中」；用 then 两分支避免未处理的拒绝。
    void job.then(
      () => {
        if (this.inflight.get(family) === job) this.inflight.delete(family);
      },
      () => {
        if (this.inflight.get(family) === job) this.inflight.delete(family);
      },
    );
    return job;
  }

  /**
   * ADR-003 规则 ①：字体子集化，按字形集哈希缓存。
   *
   * 为什么必须做：光栅化后端要把字体**内联**进 SVG（不然字形会回落到别的
   * 字体），而内联成本 ≈ 4 µs/KB + 0.7 ms 固定。实测 9.5 MB 的 simhei.ttf
   * 内联一次是 ~129 ms/帧，裁到 9.3 KB 之后是 ~0.7 ms/帧，且逐像素零差异。
   *
   * woff/woff2 **不做子集化**（HarfBuzz 只吃 SFNT，实测 `hb_subset_or_fail`
   * 对 woff2 返回 0），原样内联 —— 好在 woff2 本身就是压缩格式，体积可控。
   */
  private async prepareDataUrl(face: FontFaceSource, glyphs: string): Promise<void> {
    if (!face.bytes) return;

    const canSubset = this.subsetting && isSubsettable(face.mime) && glyphs.length > 0;
    if (!canSubset) {
      if (!face.dataUrl) face.dataUrl = dataUrlFor(new Uint8Array(face.bytes), face.mime);
      return;
    }

    // glyphs 由 collectGlyphs 产出，已经是**排序去重**过的 —— 所以
    // 「打字顺序不同」不会产生不同的键，缓存才稳。
    const key = `${face.id}|${fnv1a(glyphs)}`;
    // 同一个字形集不必重新 base64：ensure 是每次光栅化都调的，而
    // dataUrlFor 的开销与字节数成正比（woff2 / 回退整量时可达上百毫秒/帧）。
    if (face.dataUrl && face.dataUrlKey === key) {
      this.subsetStats.cacheHits += 1;
      return;
    }
    const hit = this.subsetCache.get(key);
    let bytes: Uint8Array;
    if (hit) {
      this.subsetStats.cacheHits += 1;
      bytes = hit;
    } else {
      const t0 = performance.now();
      try {
        bytes = await subsetFont(face.bytes, glyphs);
      } catch (err) {
        // 子集化失败（字体损坏 / wasm 取不到）不该让整条链路挂掉 ——
        // 退回整体内联，代价是慢，但结果是对的。
        console.warn(`[typo] ${face.id} 子集化失败，退回整体内联`, err);
        if (!face.dataUrl || face.dataUrlKey !== key) {
          face.dataUrl = dataUrlFor(new Uint8Array(face.bytes), face.mime);
          face.dataUrlKey = key;
        }
        return;
      }
      this.subsetStats.computed += 1;
      this.subsetStats.lastMs = performance.now() - t0;
      this.subsetStats.lastFullBytes = face.bytes.byteLength;
      this.subsetStats.lastSubsetBytes = bytes.byteLength;
      this.subsetCache.set(key, bytes);
    }
    face.dataUrl = dataUrlFor(bytes, face.mime);
    face.dataUrlKey = key;
  }

  private async loadFace(face: FontFaceSource): Promise<void> {
    if (face.loaded) return;
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
    // 字节优先（ArrayBuffer 直接吃）；只有 URL 时必须包成 CSS 的 src 值 ——
    // 裸 URL 会被 FontFace 判成语法错误（见 `cssUrl`）。
    const src: ArrayBuffer | string | null = face.bytes ?? (face.url ? cssUrl(face.url) : null);
    if (!src) return;
    try {
      const descriptors: FontFaceDescriptors = { weight: String(face.weight), style: face.style };
      const ff = new FontFace(face.family, src, descriptors);
      await ff.load();
      document.fonts.add(ff);
      face.loaded = true;
      face.failed = false;
    } catch (err) {
      face.failed = true;
      console.warn(`[typo] 字体 ${face.id} 的 FontFace 加载失败`, err);
    }
  }

  /** 文档用到的字体引用（写进 TypographyDocument.fonts）。 */
  refFor(family: string): FontRef | null {
    const faces = this.facesOf(family);
    if (!faces.length) return null;
    const mime = faces[0]!.mime;
    return {
      id: `font-${family}`,
      family,
      // HarfBuzz 的 subset 只吃 SFNT；woff/woff2 只能整体内联（见 P7）。
      format: mime.includes('woff2') ? 'woff2' : mime.includes('woff') ? 'woff' : 'sfnt',
      source: faces[0]!.url ? { kind: 'builtin' } : { kind: 'file' },
    };
  }
}
