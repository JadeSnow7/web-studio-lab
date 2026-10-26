/**
 * W9 运行辅助：vite `?raw` 后缀的 Node esm 钩子（node:module registerHooks 同步注册用）。
 * scripts/*.mjs 经 tsx 直接执行源码时用；把 `x.py?raw` 解析成 `export default <文本>`。
 * 非 ?raw 请求原样透传给链上的下一个 loader（tsx）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith('?raw')) return nextResolve(specifier, context);
  const resolved = nextResolve(specifier.slice(0, -'?raw'.length), context);
  return { ...resolved, url: `${resolved.url}?raw`, shortCircuit: true };
}

export function load(url, context, nextLoad) {
  if (!url.endsWith('?raw')) return nextLoad(url, context);
  const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8');
  return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
}
