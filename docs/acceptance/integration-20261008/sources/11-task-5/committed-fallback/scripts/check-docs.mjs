import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 仅扫描当前项目的规范文档入口，不递归扫描历史计划、证据或链接指向的文档。
// 不发起网络请求，不检查 Markdown 锚点；此检查不实现完整的 Markdown 解析器。
const documents = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'CONTRIBUTING.md',
  'docs/ARCHITECTURE.md',
  'docs/architecture/adr/0001-modular-monolith.md',
  'docs/architecture/task-priority-walkthrough.md',
  'docs/architecture/baseline-2026-10-06.md',
];

function withoutCode(source) {
  let fence;
  const prose = source.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      }
      return '';
    }
    if (marker) {
      fence = marker[1];
      return '';
    }
    return line;
  }).join('\n');
  // 保留换行，使诊断仍能定位到原文件的行号。
  return prose.replace(/(`+)(?!`)[\s\S]*?\1(?!`)/g, (code) => code.replace(/[^\n]/g, ' '));
}

const errors = [];
for (const document of documents) {
  const file = resolve(root, document);
  if (!existsSync(file) || !statSync(file).isFile()) {
    errors.push(`${document}: required file is missing`);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    if (/[\t ]+\r?$/.test(line)) errors.push(`${document}:${index + 1}: trailing whitespace`);
  });

  const prose = withoutCode(source);
  // 支持常规行内链接，包括尖括号包裹的目标路径和链接标题。
  const links = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s()]+)(?:\s+"[^"\n]*"|\s+'[^'\n]*')?\s*\)/g;
  for (const match of prose.matchAll(links)) {
    const destination = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//')) continue;
    const pathname = destination.split(/[?#]/, 1)[0];
    if (!pathname) continue;
    const line = prose.slice(0, match.index).split('\n').length;
    let target;
    try {
      target = resolve(dirname(file), decodeURIComponent(pathname));
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      errors.push(`${document}:${line}: invalid link encoding: ${destination}`);
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      errors.push(`${document}:${line}: local link target is missing: ${destination}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed (${documents.length} normative files; local link targets and trailing whitespace). Anchors and external URLs are not checked.`);
}
