import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import config from '../vitest.config.ts';

const projects = config.test.projects.map((project) => project.test);
const owners = (file) =>
  projects.filter(
    (project) =>
      project.include.some((glob) => path.matchesGlob(file, glob)) && !(project.exclude ?? []).some((glob) => path.matchesGlob(file, glob)),
  );

test('runs Mota process boundaries exactly once, after ordinary suite contention', () => {
  const matches = owners('apps/service/src/mota-server.test.ts');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, 'mota-server');
  assert.deepEqual(matches[0].include, ['apps/service/src/mota-server.test.ts']);
  assert.ok(matches[0].sequence.groupOrder > projects.find((project) => project.name === 'ordinary').sequence.groupOrder);
  assert.equal(matches[0].testTimeout, undefined);
  assert.equal(matches[0].expect, undefined);
  assert.equal(matches[0].retry, undefined);
});

test('keeps ordinary coverage and existing process groups separate without duplicate scheduling', () => {
  for (const [file, name] of [
    ['apps/service/src/app-service.test.ts', 'ordinary'],
    ['apps/desktop/src/main/workbench/observation-application.test.ts', 'observation'],
    ['apps/service/src/app-control-mcp.test.ts', 'app-control-mcp'],
    ['apps/service/src/local-terminal.test.ts', 'local-terminal'],
  ])
    assert.deepEqual(
      owners(file).map((project) => project.name),
      [name],
    );
  assert.equal(new Set(projects.map((project) => project.sequence.groupOrder)).size, projects.length);
});
