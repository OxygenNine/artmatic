/**
 * zh-CN —— 中文文案表。**改文案的唯一入口。**
 *
 * 按域拆文件只是为了「找得到」：每个域自带前缀（`tl.` / `typo.` / `fx.` …），
 * 搜前缀就能把一个功能的文案聚齐。合并之后是一张**扁平**表 ——
 * 所以 `tr()` 的 key 是编译期可检查的，写错一个字母 svelte-check 就报，
 * 不会在运行期静默退化成把 key 本身画到界面上。
 *
 * 加一门语言 = 复制这个目录 + 在 `../index.ts` 登记一行。
 * 键集必须与 zh-CN 完全一致，`tests/unit/i18n.test.ts` 会挡住缺失项。
 */
import { common } from './common';
import { media } from './media';
import { pool } from './pool';
import { preclip } from './preclip';
import { effects } from './effects';
import { app } from './app';
import { project } from './project';
import { timeline } from './timeline';
import { inspector } from './inspector';
import { curve } from './curve';
import { transitions } from './transitions';
import { typography } from './typography';
import { ribbon } from './ribbon';
import { shortcuts } from './shortcuts';
import { hint } from './hint';
import { errors } from './errors';
import { lab } from './lab';
import { agent } from './agent';
import { plugins } from './plugins';
import { grade } from './grade';
import { mod } from './mod';

export const zhCN = {
  ...common,
  ...media,
  ...pool,
  ...preclip,
  ...effects,
  ...app,
  ...project,
  ...timeline,
  ...inspector,
  ...curve,
  ...transitions,
  ...typography,
  ...ribbon,
  ...shortcuts,
  ...hint,
  ...errors,
  ...lab,
  ...agent,
  ...plugins,
  ...grade,
  ...mod,
} as const;
