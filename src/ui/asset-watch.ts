/**
 * asset-watch.ts — 桌面版：监视 linked 素材的本机原文件。
 *
 * **只标 stale，不自动换内容。** 自动重读会让「同一帧在两次渲染里用了不同
 * 字节」这种问题变得无法复现；用户看到提示后自己决定重链 / 收集。
 *
 * 浏览器没有这条能力（`platform.watchPaths` 为 undefined），这里静默跳过。
 */

import { platform } from '../platform/index';
import { contentOfPath } from '../project/fingerprint';
import { appState, type OpenProject } from './app-state.svelte';
import { tr } from '../i18n/index.svelte';

let stop: (() => void) | null = null;

export function watchProjectAssets(p: OpenProject): void {
  stop?.();
  stop = null;
  if (!platform.watchPaths) return;

  const paths = p.assets
    .ids()
    .map((id) => p.assets.localOf(id))
    .filter((x): x is string => !!x && !x.startsWith('fsa:'));
  if (!paths.length) return;

  stop = platform.watchPaths(paths, (path) => {
    void checkOne(p, path);
  });
}

async function checkOne(p: OpenProject, path: string): Promise<void> {
  if (!p.assets || appState.activeProject !== p) return;
  const id = p.assets.ids().find((x) => p.assets.localOf(x) === path);
  if (!id || !platform.readPath || !platform.statPath) return;

  const known = p.assets.contentOf(id);
  const st = await platform.statPath(path).catch(() => null);
  if (!known || !st) return;

  const content = await contentOfPath(st.size, (s, e) => platform.readPath!(path, s, e));
  if (content.fp === known.fp) return;

  p.assets.markStale(id);
  // 只是「源文件变了」的运行期提示：工程内容一个字节都没改，别把工程标脏。
  p.store.invalidate();
  appState.flash(
    tr('pool.sourceChanged', { name: p.assets.input(id)?.name ?? path }),
    'info',
  );
}
