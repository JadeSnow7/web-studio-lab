#!/usr/bin/env node
// 确定性远端协议 fixture；不运行 sbx、shell 或模型。
// W6b：补齐受管 App helper 操作（create/source-snapshot/apply/export/agent）与 lane collect 窗口；
// 工程文件集按 sandbox 持久到宿主状态文件，create→snapshot→apply→snapshot 跨进程一致。
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args[0] === 'version') {
  console.log('sbx version: fixture');
  process.exit(0);
}
if (args[0] === 'inspect') {
  console.log(JSON.stringify({ name: args.at(-1), agent: 'codex', state: 'running', runtime_mounts: [] }));
  process.exit(0);
}
if (args[0] === 'ports') {
  console.log('[]');
  process.exit(0);
}
if (args[0] !== 'exec' || !args.includes('python3')) process.exit(8);
// 依赖归档操作不经 guest 帧协议：请求是 argv 末位 JSON，回执走裸 stdout。
const dependencyRequest = args.at(-1);
if (dependencyRequest?.startsWith('{')) {
  process.stdin.resume();
  process.stdin.on('end', () => {
    console.log('WSL_APP_RESULT:{"dependenciesImported":true}');
    console.log('WSL_APP_RESULT:{"dependenciesCleanup":true}');
  });
} else {
  const sandbox = args[args.indexOf('python3') - 1] ?? 'fixture-sandbox';
  const stateFile = path.join(tmpdir(), `wsl-sbx-fixture-${sandbox}.json`);
  const loadState = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { projects: {} });
  const saveState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
  // 管道 stdout 是异步的：process.exit 会截断未冲刷的帧（快照回执后的 cleanup 尤甚）。
  // 所有帧经同一写入队列；finish/settle 抛出 DIE 哨兵，各帧处理器统一 catch 后
  // 等队列排空再退出——语义仍是「发出帧即结束」，但 cleanup 永不丢失。
  const DIE = Symbol('die');
  let pending = Promise.resolve();
  const writeOut = (text) => {
    pending = pending.then(
      () =>
        new Promise((resolve) => {
          process.stdout.write(text, () => resolve());
        }),
    );
  };
  const die = () => {
    void pending.then(() => process.exit(0));
  };
  const frame = (value) => writeOut(`WSL_GUEST_FRAME:${JSON.stringify(value)}\n`);
  const output = (data) => frame({ type: 'output', stream: 'stdout', data });
  const finish = (exitCode = 0) => {
    frame({ type: 'exit', exitCode });
    frame({ type: 'cleanup', ok: true });
    throw DIE;
  };
  // collect 窗口内收尾：exit 已回传，只补 cleanup。
  const settle = () => {
    frame({ type: 'cleanup', ok: true });
    throw DIE;
  };
  const swallowDie = (error) => {
    if (error !== DIE) throw error;
    die();
  };
  const rl = readline.createInterface({ input: process.stdin });
  let mode;
  let input = '';
  let cwd = '/home/agent/workspace';
  let size;
  /** W6a/W6b lane 采集窗口：exit0 后等待 collect/close；null 表示窗口未开。 */
  let collectWait = null;
  /**
   * W8：runId → 已回复 collect 次数的跨进程计数。波次内每个 lane 是独立 fixture
   * 进程，内存计数会让所有 lane 都拿 n=1（产出同名同内容标记，合并被误判为相同
   * 补丁）——计数存 tmpdir 文件保证不同 lane 拿到不同序号。
   */
  const collectCountPath = (runId) => path.join(tmpdir(), `wsl-sbx-collect-${String(runId).replaceAll(/[^A-Za-z0-9_.-]/g, '_')}.count`);
  const bumpCollectCount = (runId) => {
    let n = 0;
    try {
      n = Number(fs.readFileSync(collectCountPath(runId), 'utf8')) || 0;
    } catch {
      // 首次 collect：文件不存在，从 0 起。
    }
    n += 1;
    fs.writeFileSync(collectCountPath(runId), String(n));
    return n;
  };
  // W3b relay：在本机启动 argv 指定的进程（测试中是确定性的假 ACP Agent），转发 input / input-end；不运行 guest 或模型。
  let relayChild = null;
  /** W6b：app-helper 操作——argv 为 python3 -c <helper>，prompt 是 JSON 请求；工程文件集持久化。 */
  const appHelper = (value) => {
    let request;
    try {
      request = JSON.parse(value.prompt);
    } catch {
      frame({ type: 'output', stream: 'stderr', data: 'fixture: invalid helper request\n' });
      return finish(8);
    }
    const state = loadState();
    const project = state.projects[request.projectId];
    // 与 source-snapshot helper 一致的源码命名空间排除：保留目录/凭据不进快照、不被 apply 清掉。
    const excluded = new Set([
      'node_modules',
      'dist',
      '.data',
      'data',
      '.vite',
      '.git',
      '.env',
      '.npmrc',
      '.netrc',
      '.pypirc',
      '.git-credentials',
      '.ssh',
      '.aws',
      '.azure',
      '.gnupg',
      '.codex',
      '.docker',
      'id_rsa',
      'id_dsa',
      'id_ecdsa',
      'id_ed25519',
      'id_ecdsa_sk',
      'id_ed25519_sk',
    ]);
    const isSourcePath = (value) =>
      typeof value === 'string' &&
      value
        .split('/')
        .every(
          (part) =>
            part !== '' &&
            part !== '.' &&
            part !== '..' &&
            !/[. ]$/.test(part) &&
            !excluded.has(part.toLowerCase()) &&
            !part.toLowerCase().startsWith('.wsl-') &&
            !part.toLowerCase().startsWith('.env.'),
        );
    if (request.operation === 'create') {
      state.projects[request.projectId] = {
        workspaceId: request.workspaceId,
        files: (request.files ?? []).map((file) => ({
          path: file.path,
          base64: file.base64,
          mode: file.mode ?? '100644',
        })),
      };
      saveState(state);
      output(`WSL_APP_RESULT:${JSON.stringify({ created: true })}\n`);
      return finish();
    }
    if (request.operation === 'source-snapshot') {
      if (!project || project.workspaceId !== request.workspaceId) {
        frame({ type: 'output', stream: 'stderr', data: 'fixture: app identity mismatch or missing\n' });
        return finish(1);
      }
      let totalBytes = 0;
      const files = project.files.filter((file) => isSourcePath(file.path));
      for (const file of files) {
        output(`WSL_SOURCE:${JSON.stringify({ type: 'file', path: file.path, mode: file.mode })}\n`);
        const data = Buffer.from(file.base64, 'base64');
        for (let offset = 0; offset < data.length; offset += 48 * 1024) {
          totalBytes += Math.min(48 * 1024, data.length - offset);
          output(`WSL_SOURCE:${JSON.stringify({ type: 'chunk', base64: data.subarray(offset, offset + 48 * 1024).toString('base64') })}\n`);
        }
        output(`WSL_SOURCE:${JSON.stringify({ type: 'end-file' })}\n`);
      }
      output(`WSL_SOURCE:${JSON.stringify({ type: 'complete', totalBytes, fileCount: files.length })}\n`);
      return finish();
    }
    if (request.operation === 'apply') {
      if (!project || project.workspaceId !== request.workspaceId) {
        frame({ type: 'output', stream: 'stderr', data: 'fixture: app identity mismatch or missing\n' });
        return finish(1);
      }
      const before = new Set(project.files.filter((file) => isSourcePath(file.path)).map((file) => file.path));
      project.files = [
        ...(request.files ?? []).map((file) => ({
          path: file.path,
          base64: file.base64,
          mode: file.mode ?? '100644',
        })),
        ...project.files.filter((file) => !isSourcePath(file.path)),
      ];
      const after = new Set(project.files.filter((file) => isSourcePath(file.path)).map((file) => file.path));
      saveState(state);
      output(
        `WSL_APP_RESULT:${JSON.stringify({ applied: true, written: after.size, deleted: [...before].filter((p) => !after.has(p)).length })}\n`,
      );
      return finish();
    }
    if (request.operation === 'export') {
      output(
        `WSL_APP_RESULT:${JSON.stringify({ files: (project?.files ?? []).map((file) => ({ path: file.path, base64: file.base64 })) })}\n`,
      );
      return finish();
    }
    if (request.operation === 'agent') {
      output(`WSL_APP_RESULT:${JSON.stringify({ unsupported: 'fixture' })}\n`);
      return finish();
    }
    frame({ type: 'output', stream: 'stderr', data: `fixture: unsupported app operation ${String(request.operation)}\n` });
    return finish(7);
  };
  rl.on('line', (line) => {
    try {
      onLine(line);
    } catch (failure) {
      swallowDie(failure);
    }
  });
  const onLine = (line) => {
    const value = JSON.parse(line);
    if (value.type === 'start' && value.stdin === 'relay') {
      mode = value.mode;
      if (value.mcp === 'acp-stdio')
        frame({ type: 'mcp-server', name: 'wsl_space', command: '/usr/bin/python3', args: ['-I', '-u', '-c', 'pass'] });
      // 与 guest helper 一致：Profile 配置目录只映射到声明的那一个环境变量（W4）。
      const env = value.profileDir ? { ...process.env, [value.profileDir.env]: value.profileDir.path } : process.env;
      // W4b E2E：只在测试环境变量存在时把 Claude Code 的 ACP 包装器换成确定性的假 ACP Agent。
      const scenario = process.env.WSL_FIXTURE_ACP_SCENARIO;
      const [command, ...rest] =
        scenario && value.argv[0] === 'claude-agent-acp'
          ? [process.execPath, fileURLToPath(new URL('../../apps/service/src/fixtures/fake-acp-agent.mjs', import.meta.url)), scenario]
          : value.argv;
      relayChild = spawn(command, rest, { stdio: ['pipe', 'pipe', 'pipe'], env });
      relayChild.on('error', (error) => {
        try {
          frame({ type: 'error', error: error.message });
          finish(127);
        } catch (failure) {
          swallowDie(failure);
        }
      });
      relayChild.stdout.on('data', (data) => output(data.toString()));
      relayChild.stderr.on('data', (data) => frame({ type: 'output', stream: 'stderr', data: data.toString() }));
      relayChild.on('close', (code) => {
        try {
          finish(code ?? 1);
        } catch (failure) {
          swallowDie(failure);
        }
      });
      frame({ type: 'ready', pid: process.pid });
      return;
    }
    if (relayChild && value.type === 'input') return void relayChild.stdin.write(value.data);
    if (relayChild && value.type === 'input-end') return void relayChild.stdin.end();
    if (relayChild && value.type === 'close') {
      relayChild.kill('SIGKILL');
      return;
    }
    // W6b/W8 lane 采集窗口：exit0 已发，等一帧 collect（回传候选文件集）或 close（仅清理）。
    if (collectWait) {
      if (value.type === 'collect') {
        const n = bumpCollectCount(collectWait.runId);
        // W8 波次：每 run 的 collect 序号进标记名——并行 lane 各自产出独立文件；
        // 首个保持 lane-change.txt 兼容既有 patch-app 断言。
        const marker = {
          path: n === 1 ? 'lane-change.txt' : `lane-${n}.txt`,
          base64: Buffer.from(`fixture lane 候选 runId=${collectWait.runId} n=${n}\n`).toString('base64'),
        };
        const files = [...collectWait.files.filter((file) => file.path !== marker.path), marker];
        // [wave-conflict] 标记的 lane 额外写 shared.txt（内容按 collect 序号不同）→ 合并冲突。
        if (collectWait.prompt.includes('[wave-conflict]')) {
          files.push({
            path: 'shared.txt',
            base64: Buffer.from(`fixture wave lane ${n}\n`).toString('base64'),
          });
        }
        frame({ type: 'collect', runId: collectWait.runId, files });
        collectWait = null;
        settle();
        return;
      }
      if (value.type === 'close') {
        collectWait = null;
        settle();
        return;
      }
      return;
    }
    if (value.type === 'start') {
      mode = value.mode;
      frame({ type: 'ready', pid: process.pid });
      if (mode === 'terminal') {
        size = `${value.rows} ${value.cols}`;
        output('fixture shell\r\n$ ');
        return;
      }
      // W6b：app-helper 调用（argv = python3 -c <helper>）走持久化操作分支。
      if (value.argv[0] === 'python3') return appHelper(value);
      if (value.argv.includes('--version')) {
        output('codex-cli fixture\n');
        finish();
      }
      if (value.argv[1] === 'login') {
        // 与真实 CLI 一致：`codex login status` 的结果写在 stderr（2026-10-22 实测）。
        frame({ type: 'output', stream: 'stderr', data: 'Logged in fixture\n' });
        finish();
      }
      // Claude Code `auth status --json`（W4 自检）：Profile 目录名以 00000000- 开头时视为未登录，其余为已登录。
      if (value.argv.includes('auth') && value.argv.includes('status')) {
        const loggedIn = !value.profileDir?.path.split('/').at(-1).startsWith('00000000-');
        output(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', email: 'fixture@example.invalid' })}\n`);
        return void finish(loggedIn ? 0 : 1);
      }
      if (value.argv.includes('--ignore-user-config') || value.argv.includes('shell_tool')) finish(8);
      const prompt = value.prompt;
      const emit = (event) => output(`${JSON.stringify(event)}\n`);
      const resumed = value.argv.includes('resume');
      const thread = resumed ? value.argv.at(-2) : `fixture-${randomUUID()}`;
      emit({ type: 'thread.started', thread_id: thread });
      emit({ type: 'turn.started' });
      if (prompt.includes('[slow]')) {
        setInterval(() => emit({ type: 'item.completed', item: { id: 'late', type: 'agent_message', text: '迟到回复' } }), 200);
        return;
      }
      if (prompt.includes('[cleanup-fail]')) {
        frame({ type: 'exit', exitCode: 0 });
        frame({ type: 'cleanup', ok: false, error: 'fixture 清理失败' });
        die();
      }
      if (prompt.includes('[missing-cleanup]')) {
        frame({ type: 'exit', exitCode: 0 });
        die();
      }
      if (prompt.includes('[empty-reply]')) {
        emit({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 0 } });
        finish();
      }
      if (prompt.includes('[bad-json]')) {
        output('{broken\n');
        return;
      }
      if (prompt.includes('[exit]')) {
        finish(7);
        return;
      }
      const historyFile = path.join(tmpdir(), `${thread}.json`);
      const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
      const text = prompt.includes('回忆') ? (resumed ? (history[0] ?? '没有之前内容') : '没有之前内容') : `fixture 回复：${prompt}`;
      history.push(prompt);
      fs.writeFileSync(historyFile, JSON.stringify(history));
      emit({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text } });
      if (!prompt.includes('[no-completion]')) emit({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 20 } });
      // W6a lane：collect 声明时 exit0 后打开采集窗口等 collect/close，而不是立刻自清。
      if (value.collect === true && value.workspace) {
        collectWait = { runId: value.workspace.runId, files: value.workspace.files ?? [], prompt: value.prompt ?? '' };
        frame({ type: 'exit', exitCode: 0 });
        return;
      }
      finish();
    } else if (value.type === 'close') finish();
    else if (value.type === 'resize') size = `${value.rows} ${value.cols}`;
    else if (value.type === 'input') {
      if (value.data.includes('')) {
        input = '';
        output('^C\r\n$ ');
        return;
      }
      input += value.data;
      while (input.includes('\r') || input.includes('\n')) {
        const index = input.search(/[\r\n]/);
        const command = input.slice(0, index);
        input = input.slice(index + 1);
        output(`${command}\r\n`);
        if (command.startsWith('cd ')) cwd = command.slice(3);
        else if (command === 'pwd') output(`${cwd}\r\n`);
        else if (command === 'uname -s') output('Linux\r\n');
        else if (command === 'node --version') output('v24.fixture\r\n');
        else if (command === 'codex --version') output('codex-cli fixture\r\n');
        else if (command === 'stty size') output(`${size}\r\n`);
        else if (command === 'exit') finish();
        else if (command.startsWith('printf ')) output('TERMINAL_MARKER\r\n');
        if (command !== 'sleep 60') output('$ ');
      }
    }
  };
  rl.on('close', () => {
    try {
      if (collectWait) settle();
      else finish();
    } catch (failure) {
      swallowDie(failure);
    }
  });
}
