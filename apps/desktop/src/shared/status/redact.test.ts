import { describe, expect, it } from 'vitest';
import type { DebugStatusSnapshot, StatusFact, StatusTransition } from '@wsl/protocol';
import {
  redact,
  redactDebugSnapshot,
  redactFact,
  redactPath,
  redactSecrets,
  redactTransition,
  redactUrl,
  sha256Hex,
  sshAlias,
  truncateText,
} from './index';

const context = { homeDir: '/Users/alice', roots: ['/Users/alice/work/project', '/srv/data'] };

describe('sha256Hex（纯 TS）', () => {
  it('已知向量', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // 448 位消息：填充恰好需要第二个分组
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    expect(sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('按 UTF-8 编码非 ASCII 文本（含补充平面字符）', () => {
    expect(sha256Hex('你好')).toBe('670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e');
    expect(sha256Hex('hello 世界 😀')).toBe('355b21ab0eb2f71c2613b228e39a9ac9cf75e49bd305d5ac781c60bcf85ef02c');
  });
});

describe('redactUrl', () => {
  it('保留协议、主机、路径；去掉查询串与片段', () => {
    expect(redactUrl('https://example.com/a/b?token=SECRET&x=1#section')).toBe('https://example.com/a/b');
    expect(redactUrl('http://localhost:5173/app?q=1')).toBe('http://localhost:5173/app');
    expect(redactUrl('wsl-demo://taskflow/index.html?session=abc#x')).toBe('wsl-demo://taskflow/index.html');
  });

  it('去掉用户信息', () => {
    expect(redactUrl('https://user:pass@example.com/p?x=1')).toBe('https://example.com/p');
  });

  it('file: URL 按本地路径处理（家目录与授权根）', () => {
    expect(redactUrl('file:///Users/alice/notes/a.html?x=1#h', context)).toBe('~/notes/a.html');
    expect(redactUrl('file:///Users/alice/work/project/src/index.html#h', context)).toBe('src/index.html');
    expect(redactUrl('file:///Users/alice/My%20Docs/a.html', context)).toBe('~/My Docs/a.html');
    expect(redactUrl('file:///etc/hosts', context)).toBe('/etc/hosts');
  });

  it('data: 等不透明协议整体隐藏；无法解析时按首个 ? 或 # 截断', () => {
    expect(redactUrl('data:text/html;base64,AAAA')).toBe('data:[redacted]');
    expect(redactUrl('javascript:alert(1)')).toBe('javascript:[redacted]');
    expect(redactUrl('not a url?secret=1#x')).toBe('not a url');
  });
});

describe('redactPath', () => {
  it('授权根内改为相对根路径，根本身为 .', () => {
    expect(redactPath('/Users/alice/work/project/src/a.ts', context)).toBe('src/a.ts');
    expect(redactPath('/Users/alice/work/project', context)).toBe('.');
    expect(redactPath('/srv/data/x/y', context)).toBe('x/y');
  });

  it('家目录替换为 ~；其他路径不变', () => {
    expect(redactPath('/Users/alice/Library/x', context)).toBe('~/Library/x');
    expect(redactPath('/Users/alice', context)).toBe('~');
    expect(redactPath('/Users/alicia/x', context)).toBe('/Users/alicia/x');
    expect(redactPath('/usr/bin/node', context)).toBe('/usr/bin/node');
  });

  it('最长授权根优先；根末尾斜杠不影响匹配', () => {
    const nested = { roots: ['/a/', '/a/b'] };
    expect(redactPath('/a/b/c', nested)).toBe('c');
    expect(redactPath('/a/x', nested)).toBe('x');
  });
});

describe('redactSecrets：四类凭据模式', () => {
  it('私钥块（含缺少结束行的截断文本）', () => {
    const block = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactSecrets(`key: ${block} tail`)).toBe('key: [redacted] tail');
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow')).toBe('[redacted]');
  });

  it('OpenAI token（sk-…，含 sk-proj-…）', () => {
    expect(redactSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx')).toBe('OPENAI_API_KEY=[redacted]');
    expect(redactSecrets('sk-proj-AbC_dEf-123456789012345678')).toBe('[redacted]');
    expect(redactSecrets('task-list sk-short')).toBe('task-list sk-short');
  });

  it('GitHub token（ghp_ / gho_ / ghu_ / ghs_ / ghr_ / github_pat_）', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'])
      expect(redactSecrets(`token ${prefix}${'A1b2C3d4E5'.repeat(3)} end`)).toBe('token [redacted] end');
    expect(redactSecrets(`github_pat_${'A1b2C3d4E5_'.repeat(4)}`)).toBe('[redacted]');
  });

  it('AWS access key（AKIA…）', () => {
    expect(redactSecrets('id=AKIAIOSFODNN7EXAMPLE;')).toBe('id=[redacted];');
    expect(redactSecrets('AKIAshort')).toBe('AKIAshort');
    // 临时凭据前缀 ASIA
    expect(redactSecrets('id=ASIAIOSFODNN7EXAMPLE;')).toBe('id=[redacted];');
  });

  it('随机 ID 保留', () => {
    const id = '3f2b8c1e-5a47-4d0b-9c1e-0a1b2c3d4e5f';
    expect(redactSecrets(`runId ${id} instance inst-8f3a`)).toBe(`runId ${id} instance inst-8f3a`);
  });
});

describe('redact：自由文本', () => {
  it('文本中的 URL 去掉查询串与片段', () => {
    expect(redact('已拦截导航：https://example.com/p?token=SECRET#x', context)).toBe('已拦截导航：https://example.com/p');
    expect(redact('see https://example.com/p?token=SECRET#x for details', context)).toBe('see https://example.com/p for details');
  });

  it('含非 ASCII 查询值的 URL 不残留查询串尾部', () => {
    expect(redact('https://a.com/p?q=中文&token=abc')).toBe('https://a.com/p');
    expect(redact('打开 https://a.com/p?q=中文&token=abc#片段 失败')).toBe('打开 https://a.com/p 失败');
  });

  it('中英文句末标点不被吞入 URL，并原样接回', () => {
    expect(redact('见 https://a.com/p?q=1。')).toBe('见 https://a.com/p。');
    expect(redact('见（https://a.com/p?q=1）。')).toBe('见（https://a.com/p）。');
    expect(redact('地址 https://a.com/p，')).toBe('地址 https://a.com/p，');
    expect(redact('visit https://a.com/p?q=1.')).toBe('visit https://a.com/p.');
    expect(redact('「https://a.com/p?q=1」 与 《https://b.com/x?y=2》')).toBe('「https://a.com/p」 与 《https://b.com/x》');
    expect(redact('a https://a.com/p?x=1！ b https://b.com/q?x=2、')).toBe('a https://a.com/p！ b https://b.com/q、');
  });

  it('家目录与授权根在文本中替换', () => {
    expect(redact('读取 /Users/alice/Library/a.txt 失败', context)).toBe('读取 ~/Library/a.txt 失败');
    expect(redact('cwd=/Users/alice/work/project/src ok', context)).toBe('cwd=src ok');
    expect(redact('root (/Users/alice/work/project) 已授权', context)).toBe('root (.) 已授权');
    expect(redact('备份 /Users/alice/work/project.bak', context)).toBe('备份 ~/work/project.bak');
    expect(redact('其他 /Users/alicia/x 不变', context)).toBe('其他 /Users/alicia/x 不变');
  });

  it('SSH 主机与用户替换为 ssh:<sha256 前 8 位>', () => {
    const text = redact('连接 deploy@build.internal.example 失败（build.internal.example:22）', {
      sshIdentities: ['build.internal.example', 'deploy'],
    });
    const host = `ssh:${sha256Hex('build.internal.example').slice(0, 8)}`;
    const user = `ssh:${sha256Hex('deploy').slice(0, 8)}`;
    expect(text).toBe(`连接 ${user}@${host} 失败（${host}:22）`);
    expect(sshAlias('deploy')).toBe(user);
    expect(text).not.toContain('build.internal');
    expect(redact('deployment 不受影响', { sshIdentities: ['deploy'] })).toBe('deployment 不受影响');
  });

  it('凭据在文本中替换，并先于截断处理', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const text = redact(`${'x'.repeat(290)} ${secret}`);
    expect(text).not.toContain('sk-');
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it('文本截断到 300 字符，以省略号结尾，不拆开代理对', () => {
    const text = redact('a'.repeat(1000));
    expect(text).toHaveLength(300);
    expect(text.endsWith('…')).toBe(true);
    expect(redact('a'.repeat(300))).toBe('a'.repeat(300));
    const emoji = redact('😀'.repeat(400));
    expect(emoji.length).toBeLessThanOrEqual(300);
    expect(emoji.endsWith('…')).toBe(true);
    expect(emoji.slice(0, -1)).toBe('😀'.repeat((emoji.length - 1) / 2));
  });
});

describe('truncateText', () => {
  it('不超限则原样返回；超限时长度恰为 max', () => {
    expect(truncateText('abc', 3)).toBe('abc');
    expect(truncateText('abcd', 3)).toBe('ab…');
    expect(truncateText('abcd', 1)).toBe('…');
  });
});

describe('事实、转换与快照出口', () => {
  const fact = {
    key: 'web:w1:blocked-nav',
    domain: 'web',
    facet: 'blocked-nav',
    scope: { kind: 'resource', workspaceId: 'ws', resourceId: 'w1' },
    phase: 'degraded',
    kind: 'problem',
    priority: 20,
    label: '已拦截导航：file:///Users/alice/a.html?x=1',
    detail: '令牌 ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5 位于 /Users/alice/notes',
    instanceToken: 'inst:3',
    raw: { instanceId: 'inst', documentGeneration: 3 },
  } satisfies StatusFact;

  it('redactFact：label / detail 脱敏且长度受限，ID 与 key 保留', () => {
    const redacted = redactFact(fact, context);
    expect(redacted.label).toBe('已拦截导航：~/a.html');
    expect(redacted.detail).toBe('令牌 [redacted] 位于 ~/notes');
    expect(redacted.key).toBe(fact.key);
    expect(redacted.instanceToken).toBe(fact.instanceToken);
    expect(redacted.raw).toEqual(fact.raw);
    expect(fact.label).toContain('Users/alice');
    expect(redactFact({ ...fact, label: 'x'.repeat(120), detail: undefined }, context).detail).toBeUndefined();
  });

  it('redactFact 对 raw 中的字符串字段做凭据兜底', () => {
    const redacted = redactFact({ ...fact, raw: { instanceId: 'sk-abcdefghijklmnopqrstuvwxyz' } });
    expect(redacted.raw).toEqual({ instanceId: '[redacted]' });
  });

  it('redactTransition 与 redactDebugSnapshot', () => {
    const endpoint = { phase: 'failed', kind: 'problem', label: '失败：sk-abcdefghijklmnopqrstuvwxyz' } as const;
    const transition: StatusTransition = { key: fact.key, from: null, to: endpoint, at: '2026-10-11T00:00:00Z', seq: 1 };
    expect(redactTransition(transition).to?.label).toBe('失败：[redacted]');
    expect(redactTransition(transition).from).toBeNull();
    const snapshot: DebugStatusSnapshot = {
      appInstanceId: 'app',
      seq: 2,
      generatedAt: '2026-10-11T00:00:00Z',
      facts: [fact],
      transitions: [transition],
    };
    const redacted = redactDebugSnapshot(snapshot, context);
    expect(JSON.stringify(redacted)).not.toMatch(/sk-abc|ghp_|Users\/alice/);
    expect(redacted.appInstanceId).toBe('app');
  });
});
