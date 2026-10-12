import { describe, expect, it } from 'vitest';
import { PageCaptureSchema, type StatusFact } from '@wsl/protocol';
import { DISPLAY_STRING_LIMIT, describeCapture, groupFacts, kindCounts, matchesFilter } from './debug';

const fact = (key: string, domain: StatusFact['domain'], kind: StatusFact['kind']) =>
  ({
    key,
    domain,
    kind,
    facet: 'state',
    scope: { kind: 'global' },
    phase: 'ok',
    priority: 0,
    label: key,
    instanceToken: key,
    raw: {},
  }) as StatusFact;

describe('诊断面板的事实过滤与分组', () => {
  const facts = [
    fact('terminal:t1:state', 'terminal', 'steady'),
    fact('run:r1:state', 'run', 'progress'),
    fact('terminal:t1:cleanup', 'terminal', 'unresolved'),
    fact('web:w1:agent-control', 'web', 'control'),
  ];

  it('按 domain 分组，组内按 kind 展示顺序排列', () => {
    const groups = groupFacts(facts);
    expect(groups.map((group) => group.domain)).toEqual(['terminal', 'run', 'web']);
    expect(groups[0]!.facts.map((item) => item.kind)).toEqual(['unresolved', 'steady']);
  });

  it('按 domain / kind 过滤，并统计各 kind 数量', () => {
    expect(facts.filter((item) => matchesFilter({ domain: 'terminal', kind: 'all' }, item))).toHaveLength(2);
    expect(facts.filter((item) => matchesFilter({ domain: 'all', kind: 'progress' }, item)).map((item) => item.key)).toEqual([
      'run:r1:state',
    ]);
    expect(matchesFilter({ domain: 'terminal', kind: 'all' }, { key: 'terminal:t1:state', kind: 'steady' })).toBe(true);
    expect(matchesFilter({ domain: 'run', kind: 'all' }, { key: 'terminal:t1:state', kind: 'steady' })).toBe(false);
    expect(kindCounts(facts)).toMatchObject({ all: 4, steady: 1, progress: 1, unresolved: 1, control: 1, problem: 0 });
  });
});

describe('会话现场的屏幕显示', () => {
  it('截图 data URL 只显示类型与大小，其余字段原样保留', () => {
    const capture = PageCaptureSchema.parse({
      captureId: 'cap-1',
      capturedAt: '2026-10-11T00:00:00Z',
      page: { webContentsId: 7, documentGeneration: 1, url: 'https://example.com/', title: '页', partition: 'p' },
      element: {
        tagName: 'p',
        id: null,
        classes: [],
        role: null,
        ariaLabel: null,
        testId: null,
        text: '未设置',
        selector: 'p',
        rect: null,
      },
      screenshot: { viewport: `data:image/png;base64,${'A'.repeat(400)}`, element: null },
      consoleIssues: [],
    });
    const text = JSON.stringify(describeCapture(capture));
    expect(text).not.toContain('AAAA');
    expect(text).toContain('image/png 数据，约 300 字节');
    expect(text).toContain('未设置');
    expect(text).toContain('webContentsId');
  });

  it('以 data: 开头且没有逗号的超长字符串在线性时间内返回，并被截断', () => {
    const hostile = `data:${'a'.repeat(100_000)}`;
    const capture = PageCaptureSchema.parse({
      captureId: 'cap-2',
      capturedAt: '2026-10-11T00:00:00Z',
      page: { webContentsId: 7, documentGeneration: 1, url: 'https://example.com/', title: hostile, partition: 'p' },
      element: { tagName: 'p', id: null, classes: [], role: null, ariaLabel: null, testId: null, text: 'x', selector: 'p', rect: null },
      screenshot: { viewport: 'data:image/png;base64,AAAA', element: null },
      consoleIssues: [],
    });
    const started = performance.now();
    const shown = describeCapture(capture) as { page: { title: string } };
    expect(performance.now() - started).toBeLessThan(50);
    expect(shown.page.title.length).toBeLessThan(DISPLAY_STRING_LIMIT + 100);
    expect(shown.page.title).toContain('已截断');
  });
});
