import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { format, resolveConfig } from 'prettier';

const outDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(outDir, '..', '..', '..', '..');

const fail = (message) => {
  process.stderr.write(`compare-checks: ${message}\n`);
  process.exit(1);
};

const safeName = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value) && !value.includes('..');

const [baselineRootArg, baselineLintName, baselineFormatName, finalLintName, finalFormatName, outputName] = process.argv.slice(2);
if (process.argv.length !== 8)
  fail('用法: node compare-checks.mjs <baselineRoot> <baselineLint> <baselineFormat> <finalLint> <finalFormat> <output>');
for (const name of [baselineLintName, baselineFormatName, finalLintName, finalFormatName, outputName])
  if (!safeName(name)) fail(`不安全名称: ${name}`);
const baselineRoot = resolve(baselineRootArg);
if (!statSync(baselineRoot, { throwIfNoEntry: false })?.isDirectory()) fail(`baselineRoot 不是目录: ${baselineRootArg}`);

const readEvidence = (name) => {
  const file = join(outDir, `${name}.txt`);
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) fail(`${name}.txt 为空`);
  return text;
};

const relativeRepoPath = (base, filePath, source) => {
  const rel = relative(base, filePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail(`${source} 的 filePath 越界: ${filePath}`);
  return rel;
};

const parseLint = (text, base, source) => {
  let parsed;
  try {
    parsed = JSON.parse(stripVTControlCharacters(text));
  } catch (error) {
    fail(`${source} 不是合法 eslint JSON: ${error.message ?? error}`);
  }
  if (!Array.isArray(parsed)) fail(`${source} eslint JSON 不是数组`);
  let errors = 0;
  let warnings = 0;
  const errorFiles = new Set();
  for (const result of parsed) {
    if (typeof result?.filePath !== 'string' || typeof result?.errorCount !== 'number') fail(`${source} 含非法 eslint 结果项`);
    errors += result.errorCount;
    warnings += typeof result.warningCount === 'number' ? result.warningCount : 0;
    if (result.errorCount > 0) errorFiles.add(relativeRepoPath(base, result.filePath, source));
  }
  return { errors, warnings, errorFiles: [...errorFiles].sort() };
};

const parseFormat = (text, source) => {
  const files = new Set();
  let summary = null;
  for (const line of stripVTControlCharacters(text).split('\n')) {
    if (!line.startsWith('[warn]')) continue;
    const rest = line.slice(6).trim();
    const summaryMatch = /^Code style issues found in (\d+) file/.exec(rest);
    if (summaryMatch) {
      summary = Number(summaryMatch[1]);
      continue;
    }
    if (rest) files.add(rest);
  }
  if (summary === null) fail(`${source} 缺少 Code style issues 汇总行`);
  if (summary !== files.size) fail(`${source} 汇总 ${summary} 与 [warn] 路径数 ${files.size} 不一致`);
  return [...files].sort();
};

const diff = (before, after) => {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    newFiles: after.filter((file) => !beforeSet.has(file)),
    fixedFiles: before.filter((file) => !afterSet.has(file)),
    filesIdentical: before.length === after.length && before.every((file, index) => file === after[index]),
  };
};

const baselineLint = parseLint(readEvidence(baselineLintName), baselineRoot, baselineLintName);
const baselineFormat = parseFormat(readEvidence(baselineFormatName), baselineFormatName);
const finalLint = parseLint(readEvidence(finalLintName), root, finalLintName);
const finalFormat = parseFormat(readEvidence(finalFormatName), finalFormatName);

const report = {
  inputs: {
    baselineRoot,
    worktreeRoot: root,
    baselineLint: `${baselineLintName}.txt`,
    baselineFormat: `${baselineFormatName}.txt`,
    finalLint: `${finalLintName}.txt`,
    finalFormat: `${finalFormatName}.txt`,
  },
  lint: {
    baseline: baselineLint,
    final: finalLint,
    errorsDelta: finalLint.errors - baselineLint.errors,
    warningsDelta: finalLint.warnings - baselineLint.warnings,
    ...diff(baselineLint.errorFiles, finalLint.errorFiles),
  },
  format: {
    baseline: { files: baselineFormat },
    final: { files: finalFormat },
    filesDelta: finalFormat.length - baselineFormat.length,
    ...diff(baselineFormat, finalFormat),
  },
};

const outputPath = join(outDir, `${outputName}.json`);
const prettierOptions = { ...(await resolveConfig(outputPath)), filepath: outputPath };
try {
  writeFileSync(outputPath, await format(JSON.stringify(report), prettierOptions), { flag: 'wx' });
} catch (error) {
  fail(`无法创建 ${outputName}.json: ${error instanceof Error ? (error.code ?? error.message) : error}`);
}

process.stdout.write(
  `lint: errors ${baselineLint.errors} → ${finalLint.errors}（new ${report.lint.newFiles.length} / fixed ${report.lint.fixedFiles.length}，filesIdentical=${report.lint.filesIdentical}）\n` +
    `format: files ${baselineFormat.length} → ${finalFormat.length}（new ${report.format.newFiles.length} / fixed ${report.format.fixedFiles.length}，filesIdentical=${report.format.filesIdentical}）\n`,
);
