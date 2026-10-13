import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type ProcessEvidence = {
  pid: number;
  seccomp: number;
  seccompFilters: number;
  noNewPrivs: number;
  pidNamespace: string;
  userNamespace: string;
};
type Isolation = {
  args: string[];
  diagnostic: { namespaceSandbox: boolean; pidNamespaces: boolean; seccompBpf: boolean };
  browser: ProcessEvidence;
  renderers: ProcessEvidence[];
  elf: boolean;
};
type GateEvent = {
  requestId: string;
  request: { url: string; method: string };
  frameId: string;
  resourceType: string;
  networkId?: string;
  responseStatusCode?: number;
  responseErrorReason?: string;
  redirectedRequestId?: string;
  responseHeaders?: { name: string; value: string }[];
};
type DocumentFrame = { id: string; loaderId: string; url: string };
type DocumentRequest = {
  type: string;
  frameId: string;
  requestId: string;
  loaderId: string;
  request: { url: string; method: string };
  redirectResponse?: object;
};
type DomEvidence = { observationId: string; mutations: number; title: string; text: string; truncated: boolean };
const harness = require('./guest-browser.cjs') as {
  parseRequest: (line: string) => unknown;
  responseGateDecision: (event: GateEvent, mainFrameId: string) => string | null;
  gateResponse: (
    cdp: { send: (method: string, params: unknown) => Promise<unknown> },
    event: GateEvent,
    frameId: string,
  ) => Promise<{ admitted: boolean; reason?: string }>;
  createDocumentGuard: (frameId: string) => {
    request: (event: DocumentRequest) => void;
    response: (event: {
      type: string;
      frameId: string;
      requestId: string;
      loaderId: string;
      response: { url: string; status: number };
    }) => void;
    commit: (frame: DocumentFrame) => void;
    assert: (frame: DocumentFrame, receipt: { networkId: string; status: number }) => unknown;
  };
  assertStableDom: (before: DomEvidence, after: DomEvidence) => void;
  descendantProcesses: () => { pid: number }[];
  truncateUtf8: (value: string, limit: number) => { text: string; truncated: boolean };
  safeLocation: (url: string) => { origin: string; path: string };
  requestDecision: (request: {
    url: string;
    method: string;
    mainFrame: boolean;
    navigation: boolean;
    redirected: boolean;
  }) => string | null;
  inspectIpv6Readiness: (text: string) => { pending: boolean; fingerprint: string };
  waitForNetworkReadiness: (
    step: (pending: Promise<void>) => Promise<void>,
    dependencies?: { read?: () => string; pause?: (milliseconds: number) => Promise<void>; now?: () => number },
    signal?: AbortSignal,
  ) => Promise<void>;
  parseDiagnostics: (text: string) => Isolation['diagnostic'];
  validateIsolation: (proof: Isolation) => void;
  stillOwned: (identity: { pid: number; startTicks: string }) => boolean;
  closeOwned: (browser: { close: () => Promise<void> }, identities: Map<number, unknown>) => Promise<boolean>;
};
const valid = {
  operation: 'capture',
  url: 'https://docs.docker.com/',
  sandboxName: 'wsl-sbx-smoke-20261006',
  captureId: 'aed63f37-c606-4c29-9a78-7bd2f397b44b',
};
const input = (change: Record<string, unknown>) => JSON.stringify({ ...valid, ...change });
const request = { url: valid.url, method: 'GET', mainFrame: true, navigation: true, redirected: false };
const proof = (): Isolation => ({
  args: ['chromium', '--remote-debugging-pipe'],
  elf: true,
  diagnostic: { namespaceSandbox: true, pidNamespaces: true, seccompBpf: true },
  browser: { pid: 10, seccomp: 2, seccompFilters: 1, noNewPrivs: 0, pidNamespace: 'pid:[1]', userNamespace: 'user:[1]' },
  renderers: [{ pid: 12, seccomp: 2, seccompFilters: 2, noNewPrivs: 1, pidNamespace: 'pid:[2]', userNamespace: 'user:[2]' }],
});
afterEach(() => vi.restoreAllMocks());

describe('guest 固定输入和出站边界（离线单测，不是真实网页验收）', () => {
  it('只接受固定操作、URL、sandbox 与 UUID，拒绝任意参数', () => {
    expect(harness.parseRequest(input({}))).toEqual(valid);
    for (const change of [
      { url: 'https://example.com/' },
      { url: `${valid.url}?token=secret` },
      { sandboxName: 'other' },
      { captureId: 'not-a-uuid' },
      { operation: 'eval' },
      { executablePath: '/bin/sh' },
      { args: ['--no-sandbox'] },
      { expression: 'process.env' },
      { output: '/tmp/x' },
    ]) {
      expect(() => harness.parseRequest(input(change))).toThrow('请求不符合固定网页采集合同');
    }
    for (const line of ['null', '[]', '{}', '{bad', 'x'.repeat(1025)]) expect(() => harness.parseRequest(line)).toThrow();
  });
  it('拒绝跨域、凭据、其它协议/端口、POST、子框架、redirect 与后续导航', () => {
    expect(harness.requestDecision(request)).toBeNull();
    expect(harness.requestDecision({ ...request, navigation: false, url: 'https://docs.docker.com/assets/main.css?v=1' })).toBeNull();
    for (const url of [
      'https://docs.docker.com.evil.test/',
      'http://docs.docker.com/',
      'file:///etc/passwd',
      'https://docs.docker.com:8443/',
      'https://user:secret@docs.docker.com/',
      'data:text/html,test',
      'https://127.0.0.1/',
    ])
      expect(harness.requestDecision({ ...request, url })).not.toBeNull();
    expect(harness.requestDecision({ ...request, method: 'POST' })).toBe('method');
    expect(harness.requestDecision({ ...request, mainFrame: false })).toBe('frame');
    expect(harness.requestDecision({ ...request, redirected: true })).toBe('redirect');
    expect(harness.requestDecision({ ...request, url: 'https://docs.docker.com/manuals/' })).toBe('navigation');
  });
  it('错误摘要不包含 URL 用户信息、query 或 fragment', () => {
    expect(harness.safeLocation('https://secret:token@docs.docker.com/page?credential=value#password')).toEqual({
      origin: 'https://docs.docker.com',
      path: '/page',
    });
    expect(harness.safeLocation('not a URL')).toEqual({ origin: 'invalid', path: '' });
    expect(harness.safeLocation(`https://docs.docker.com/${'x'.repeat(1024)}`).path).toHaveLength(256);
  });
  it('UTF-8 正文上限不切断码点，截断标记准确', () => {
    expect(harness.truncateUtf8('a中😀z', 8)).toEqual({ text: 'a中😀', truncated: true });
    expect(harness.truncateUtf8('中😀', 7)).toEqual({ text: '中😀', truncated: false });
    const result = harness.truncateUtf8('😀'.repeat(20000), 65536);
    expect(Buffer.byteLength(result.text)).toBe(65536);
    expect(result.truncated).toBe(true);
  });
});

describe('Chromium 隔离拒绝策略（合成诊断只用于离线单测）', () => {
  it('同时要求真实参数、ELF、诊断与更强 renderer 进程限制', () => {
    expect(() => harness.validateIsolation(proof())).not.toThrow();
    for (const flag of [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-seccomp-filter-sandbox',
      '--disable-namespace-sandbox',
      '--single-process',
      '--in-process-gpu',
      '--remote-debugging-port=9222',
    ]) {
      const value = proof();
      value.args.push(flag);
      expect(() => harness.validateIsolation(value)).toThrow('无法证明');
    }
    for (const value of [
      { ...proof(), args: [] },
      { ...proof(), elf: false },
      { ...proof(), renderers: [] },
      { ...proof(), diagnostic: { namespaceSandbox: true, pidNamespaces: true, seccompBpf: false } },
    ])
      expect(() => harness.validateIsolation(value)).toThrow('无法证明');
  });
  it('外层容器自身的 Seccomp=2 不能冒充 Chromium renderer sandbox', () => {
    for (const change of [{ seccompFilters: 1 }, { noNewPrivs: 0 }, { seccomp: 0 }, { pidNamespace: 'pid:[1]' }]) {
      const value = proof();
      Object.assign(value.renderers[0]!, change);
      expect(() => harness.validateIsolation(value)).toThrow('无法证明');
    }
  });
  it('诊断中的 No 或局部启用不能变成通过', () => {
    expect(harness.parseDiagnostics('Namespace sandbox Yes\nPID namespaces Yes\nSeccomp-BPF sandbox Yes')).toEqual(proof().diagnostic);
    expect(harness.parseDiagnostics('Namespace sandbox No\nPID namespaces Yes\nSeccomp-BPF sandbox No')).toEqual({
      namespaceSandbox: false,
      pidNamespaces: true,
      seccompBpf: false,
    });
  });

  it('识别实际 Chromium 153 诊断表的 Namespace 层级，TSYNC 行保持独立', () => {
    // 来自 2026-10-07 内部诊断的文案样本；此处仍为离线解析测试。
    const text = [
      'Sandbox Status',
      'Layer 1 Sandbox\tNamespace',
      'PID namespaces\tYes',
      'Network namespaces\tYes',
      'Seccomp-BPF sandbox\tYes',
      'Seccomp-BPF sandbox supports TSYNC\tYes',
      'Ptrace Protection with Yama LSM (Broker)\tNo',
      'Ptrace Protection with Yama LSM (Non-broker)\tNo',
      '',
      'You are adequately sandboxed.',
    ].join('\n');
    expect(harness.parseDiagnostics(text)).toEqual(proof().diagnostic);
    expect(harness.parseDiagnostics(`Namespace sandbox Enabled\r\n${text}`)).toEqual(proof().diagnostic);
  });

  it.each([
    ['未启用', 'Layer 1 Sandbox\tNone'],
    ['不同隔离机制', 'Layer 1 Sandbox\tSUID'],
    ['未知状态', 'Layer 1 Sandbox\tUnknown'],
    ['缺少值', 'Layer 1 Sandbox'],
    ['非完整状态值', 'Layer 1 Sandbox\tNamespace (disabled)'],
    ['旧标签未知状态', 'Namespace sandbox Yesterday'],
    ['标签前缀', 'Not Namespace sandbox Yes'],
    ['跨行借用状态', 'Namespace sandbox\nYes'],
    ['新旧标签矛盾', 'Namespace sandbox No\nLayer 1 Sandbox\tNamespace'],
    ['反向矛盾', 'Namespace sandbox Yes\nLayer 1 Sandbox\tNone'],
    ['重复旧行', 'Namespace sandbox Yes\nNamespace sandbox No'],
    ['重复新行', 'Layer 1 Sandbox\tNamespace\nLayer 1 Sandbox\tNamespace'],
  ])('不把%s当成 namespace 通过证据', (_case, namespace) => {
    const diagnostic = harness.parseDiagnostics(`${namespace}\nPID namespaces Yes\nSeccomp-BPF sandbox Yes`);
    expect(diagnostic.namespaceSandbox).toBe(false);
    expect(() => harness.validateIsolation({ ...proof(), diagnostic })).toThrow('无法证明');
  });

  it.each([
    ['仅 TSYNC', 'PID namespaces Yes\nSeccomp-BPF sandbox supports TSYNC\tYes'],
    ['Seccomp 标签前缀', 'PID namespaces Yes\nNot Seccomp-BPF sandbox Yes'],
    ['Seccomp 重复冲突', 'PID namespaces Yes\nSeccomp-BPF sandbox Yes\nSeccomp-BPF sandbox No'],
    ['PID 重复冲突', 'PID namespaces Yes\nPID namespaces No\nSeccomp-BPF sandbox Yes'],
    ['PID 局部状态', 'PID namespaces Yes (partial)\nSeccomp-BPF sandbox Yes'],
    ['Seccomp 跨行状态', 'PID namespaces Yes\nSeccomp-BPF sandbox\nYes'],
  ])('完整隔离仍拒绝%s', (_case, rest) => {
    const diagnostic = harness.parseDiagnostics(`Namespace sandbox Yes\n${rest}`);
    expect(() => harness.validateIsolation({ ...proof(), diagnostic })).toThrow('无法证明');
  });

  it('清理不把权限错误当成退出，也不触碰 PID 复用后的进程', () => {
    const read = vi.spyOn(fs, 'readFileSync');
    const identity = { pid: 123, startTicks: '100' };
    read.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(harness.stillOwned(identity)).toBe(true);
    read.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    expect(harness.stillOwned(identity)).toBe(false);
    const fields = ['S', ...Array<string>(18).fill('0'), '101'];
    read.mockReturnValue(`123 (test process) ${fields.join(' ')}`);
    expect(harness.stillOwned(identity)).toBe(false);
    fields[19] = '100';
    read.mockReturnValue(`123 (test process) ${fields.join(' ')}`);
    expect(harness.stillOwned(identity)).toBe(true);
    fields[0] = 'Z';
    read.mockReturnValue(`123 (test process) ${fields.join(' ')}`);
    expect(harness.stillOwned(identity)).toBe(false);
  });

  it('清理无法重新核验身份时不发送信号，并报告清理未确认', async () => {
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const identities = new Map([[123, { pid: 123, startTicks: '100' }]]);
    expect(await harness.closeOwned({ close: async () => {} }, identities)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
  it('清理会等待 Browser.close；无所属残留才确认关闭', async () => {
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    let resolveClose: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    let finished = false;
    const pending = harness.closeOwned({ close }, new Map()).then((value) => {
      finished = true;
      return value;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    resolveClose!();
    expect(await pending).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('响应暂停与文档身份（CDP 合成事件，真实浏览器组合仍待验证）', () => {
  const event: GateEvent = {
    requestId: 'fetch-1',
    networkId: 'network-1',
    request: { url: valid.url, method: 'GET' },
    frameId: 'frame-1',
    resourceType: 'Document',
    responseStatusCode: 200,
    responseHeaders: [{ name: 'Content-Security-Policy', value: "default-src 'self'" }],
  };
  it('所有 3xx 包括子资源只 failRequest，绝不调用 continue 发出下一跳', async () => {
    for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
      for (const resourceType of ['Document', 'Script', 'Stylesheet', 'Image']) {
        const send = vi.fn().mockResolvedValue({});
        expect(
          await harness.gateResponse(
            { send },
            {
              ...event,
              resourceType,
              responseStatusCode: status,
              responseHeaders: [{ name: 'Location', value: 'https://unapproved.example/' }],
            },
            'frame-1',
          ),
        ).toEqual({ admitted: false, reason: 'redirect-response' });
        expect(send.mock.calls).toEqual([['Fetch.failRequest', { requestId: 'fetch-1', errorReason: 'BlockedByClient' }]]);
      }
    }
  });
  it('上游错误仍拒绝响应，仅记录 CDP 枚举而不回显任意错误文本', async () => {
    for (const [responseErrorReason, reason] of [
      ['NameNotResolved', 'response-error-NameNotResolved'],
      ['ConnectionRefused', 'response-error-ConnectionRefused'],
      ['unknown https://user:secret@example.test/?token=value', 'response-error'],
    ]) {
      const send = vi.fn().mockResolvedValue({});
      expect(await harness.gateResponse({ send }, { ...event, responseErrorReason }, 'frame-1')).toEqual({ admitted: false, reason });
      expect(send.mock.calls).toEqual([['Fetch.failRequest', { requestId: 'fetch-1', errorReason: 'BlockedByClient' }]]);
    }
  });

  it('通过响应仍叠加固定 CSP 且保留原 CSP，不支持命令则失败而不降级', async () => {
    const send = vi.fn().mockResolvedValue({});
    expect(await harness.gateResponse({ send }, event, 'frame-1')).toMatchObject({ admitted: true, networkId: 'network-1', status: 200 });
    expect(send).toHaveBeenCalledWith('Fetch.continueResponse', {
      requestId: 'fetch-1',
      responseCode: 200,
      responseHeaders: [
        event.responseHeaders![0],
        {
          name: 'Content-Security-Policy',
          value: "worker-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'",
        },
      ],
    });
    send.mockReset().mockRejectedValue(new Error('unsupported'));
    await expect(harness.gateResponse({ send }, event, 'frame-1')).rejects.toThrow('unsupported');
    expect(send.mock.calls.map(([method]) => method)).toEqual(['Fetch.continueResponse']);
  });
  it('响应 stage、frame、GET、来源和 redirect ID 再次校验', () => {
    for (const delta of [
      { responseStatusCode: undefined },
      { responseErrorReason: 'Failed' },
      { frameId: 'child-frame' },
      { request: { url: 'https://example.com/', method: 'GET' } },
      { request: { url: valid.url, method: 'POST' } },
      { redirectedRequestId: 'previous-hop' },
    ])
      expect(harness.responseGateDecision({ ...event, ...delta }, 'frame-1')).not.toBeNull();
  });
  const documentRequest: DocumentRequest = {
    type: 'Document',
    frameId: 'frame-1',
    requestId: 'network-1',
    loaderId: 'loader-1',
    request: { url: valid.url, method: 'GET' },
  };
  const frame: DocumentFrame = { id: 'frame-1', loaderId: 'loader-1', url: valid.url };
  const receipt = { networkId: 'network-1', status: 200 };
  function readyGuard() {
    const guard = harness.createDocumentGuard('frame-1');
    guard.request(documentRequest);
    guard.response({
      type: 'Document',
      frameId: 'frame-1',
      requestId: 'network-1',
      loaderId: 'loader-1',
      response: { url: valid.url, status: 200 },
    });
    guard.commit(frame);
    return guard;
  }
  it('同 URL reload 不能重新绑定 source request 或接受新 loader', () => {
    expect(() => readyGuard().assert(frame, receipt)).not.toThrow();
    expect(() => readyGuard().request({ ...documentRequest, requestId: 'network-2', loaderId: 'loader-2' })).toThrow('页面采集失败');
    expect(() => readyGuard().commit({ ...frame, loaderId: 'loader-2' })).toThrow('页面采集失败');
    expect(() => readyGuard().assert({ ...frame, loaderId: 'loader-2' }, receipt)).toThrow('页面采集失败');
    expect(() => readyGuard().assert(frame, { ...receipt, networkId: 'network-2' })).toThrow('页面采集失败');
  });
  it('没有主响应 gate 回执或响应绑定不同 loader 时不允许输出成功', () => {
    expect(() => readyGuard().assert(frame, { networkId: '', status: 200 })).toThrow();
    const guard = harness.createDocumentGuard('frame-1');
    guard.request(documentRequest);
    expect(() =>
      guard.response({
        type: 'Document',
        frameId: 'frame-1',
        requestId: 'network-1',
        loaderId: 'loader-2',
        response: { url: valid.url, status: 200 },
      }),
    ).toThrow();
  });
  it('截图前后 observer 被替换、DOM 改后恢复正文、标题或正文变化都失败', () => {
    const dom = { observationId: 'observation-1', mutations: 0, title: 'Docker', text: 'real content', truncated: false };
    expect(() => harness.assertStableDom(dom, { ...dom })).not.toThrow();
    for (const delta of [{ observationId: 'observation-2' }, { mutations: 2 }, { title: 'other' }, { text: 'other' }, { truncated: true }])
      expect(() => harness.assertStableDom(dom, { ...dom, ...delta })).toThrow('页面采集失败');
  });
  it('进程树发现仅依赖 stat，namespace 权限不会令所属进程消失', () => {
    vi.spyOn(fs, 'readdirSync').mockReturnValue(['123'] as never);
    const fields = ['S', String(process.pid), ...Array<string>(17).fill('0'), '100'];
    vi.spyOn(fs, 'readFileSync').mockReturnValue(`123 (test process) ${fields.join(' ')}`);
    const link = vi.spyOn(fs, 'readlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('namespace-denied'), { code: 'EACCES' });
    });
    expect(harness.descendantProcesses()).toMatchObject([{ pid: 123 }]);
    expect(link).not.toHaveBeenCalled();
  });
  it('stat 无法读取必须报告发现失败，不能伪造空所属集合', () => {
    vi.spyOn(fs, 'readdirSync').mockReturnValue(['123'] as never);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('stat-denied'), { code: 'EACCES' });
    });
    expect(() => harness.descendantProcesses()).toThrow('stat-denied');
  });
});

function runProtocol(payload: string, end = false, nodeEval = false): Promise<{ code: number | null; frames: unknown[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const file = fileURLToPath(new URL('./guest-browser.cjs', import.meta.url));
    const child = spawn(process.execPath, nodeEval ? ['-e', fs.readFileSync(file, 'utf8')] : [file], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('协议子进程未退出'));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({
        code,
        frames: stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
        stderr,
      });
    });
    if (end) child.stdin.end(payload);
    else child.stdin.write(payload);
  });
}
describe('真实 Node stdio 生命周期（不启动浏览器）', () => {
  it('多帧或代码参数在模块加载/启动浏览器之前失败，仅返回单个脱敏 JSON', async () => {
    for (const payload of [input({ executablePath: '/private/secret' }) + '\n', input({}) + '\n' + input({}) + '\n']) {
      const result = await runProtocol(payload);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.frames).toEqual([
        {
          protocolVersion: 1,
          ok: false,
          error: { code: 'INVALID_REQUEST', message: '请求不符合固定网页采集合同' },
          cleanup: { browserClosed: true },
        },
      ]);
    }
  });
  it('node -e 入口同样执行严格单帧协议', async () => {
    const result = await runProtocol(input({ operation: 'shell' }) + '\n', false, true);
    expect(result.code).toBe(0);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' }, cleanup: { browserClosed: true } });
  });
  it('输入前断线返回失败并退出，不把 EOF 当作已完成采集', async () => {
    const result = await runProtocol('', true);
    expect(result.code).toBe(0);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' }, cleanup: { browserClosed: true } });
  });
});

describe('guest 启动地址就绪（合成内核状态，不是真实联网验收）', () => {
  const row = (flags: string, suffix = '1') => `fe80000000000000000000000000000${suffix} 02 40 20 ${flags} eth0`;
  const step = (pending: Promise<void>) => pending;

  it('等待 tentative 或缺少非 loopback 地址，只允许完成确认的地址表', () => {
    expect(harness.inspectIpv6Readiness(row('c0')).pending).toBe(true);
    expect(harness.inspectIpv6Readiness(row('80')).pending).toBe(false);
    expect(harness.inspectIpv6Readiness(row('82')).pending).toBe(false);
    expect(harness.inspectIpv6Readiness('').pending).toBe(true);
    expect(harness.inspectIpv6Readiness(row('80').replace('eth0', 'lo')).pending).toBe(true);
    expect(harness.inspectIpv6Readiness(row('80')).fingerprint).not.toBe(harness.inspectIpv6Readiness(row('80', '2')).fingerprint);
  });

  it('DAD 失败、缺字段及畸形字段均不能当作已就绪', () => {
    for (const input of [row('88'), row('not-hex'), row('80').replace(' 02 ', ' xx '), row('80').replace('fe80', 'bad'), 'incomplete'])
      expect(() => harness.inspectIpv6Readiness(input)).toThrow('固定目标网页访问失败');
  });

  it('地址确认结束且稳定满 200ms 后才返回', async () => {
    let time = 0;
    await harness.waitForNetworkReadiness(step, {
      read: () => row(time < 300 ? 'c0' : '80'),
      pause: async (milliseconds) => {
        time += milliseconds;
      },
      now: () => time,
    });
    expect(time).toBeGreaterThanOrEqual(500);
    expect(time).toBeLessThanOrEqual(600);
  });

  it('就绪期间地址变化会重新计算稳定窗口', async () => {
    let time = 0;
    await harness.waitForNetworkReadiness(step, {
      read: () => row('80', time < 100 ? '1' : '2'),
      pause: async (milliseconds) => {
        time += milliseconds;
      },
      now: () => time,
    });
    expect(time).toBeGreaterThanOrEqual(300);
  });

  it('持续 tentative 只等待固定 5s 上限，不继续启动浏览器', async () => {
    let time = 0;
    await expect(
      harness.waitForNetworkReadiness(step, {
        read: () => row('c0'),
        pause: async (milliseconds) => {
          time += milliseconds;
        },
        now: () => time,
      }),
    ).rejects.toThrow('固定目标网页访问失败');
    expect(time).toBeGreaterThanOrEqual(5000);
    expect(time).toBeLessThanOrEqual(5100);
  });

  it('无法读取就绪证据时失败，不将权限错误当作空地址表', async () => {
    await expect(
      harness.waitForNetworkReadiness(step, {
        read: () => {
          throw new Error('EACCES');
        },
        pause: async () => {},
        now: () => 0,
      }),
    ).rejects.toThrow('固定目标网页访问失败');
  });

  it.each(['CANCELLED', 'TIMEOUT'])('保留外层 %s 并清除真实等待定时器', async (code) => {
    vi.useFakeTimers();
    try {
      const signal = new AbortController();
      const error = new Error(code);
      const cancelled = new Promise<void>((_resolve, reject) =>
        signal.signal.addEventListener('abort', () => reject(error), { once: true }),
      );
      let reads = 0;
      const pending = harness.waitForNetworkReadiness(
        (wait) => Promise.race([wait, cancelled]),
        {
          read: () => {
            reads++;
            return row('c0');
          },
        },
        signal.signal,
      );
      expect(vi.getTimerCount()).toBe(1);
      signal.abort();
      await expect(pending).rejects.toBe(error);
      expect(vi.getTimerCount()).toBe(0);
      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('外层取消会立即终止等待，不再重试读取', async () => {
    const cancelled = new Error('cancelled');
    let reads = 0;
    await expect(
      harness.waitForNetworkReadiness(
        async () => {
          throw cancelled;
        },
        {
          read: () => {
            reads++;
            return row('c0');
          },
          pause: async () => {},
          now: () => 0,
        },
      ),
    ).rejects.toBe(cancelled);
    expect(reads).toBe(1);
  });
});
