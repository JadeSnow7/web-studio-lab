// P0a workflow VM worker（合同 §5）。
// 在 node:worker_threads 中运行非 asyncify 的 quickjs release-sync 变体。
// 不能中途挂起同步段：agent() 由宿主函数 __hostCall 支撑，推入 outbox 并返回 pending promise，
// 脚本靠 JS 微任务挂起；每次 executePendingJobs 泵干后把 outbox 按序发给宿主。
// 模块求值方式：evalCode(script, { type: 'module' }) 得到模块命名空间，再取 default 导出调用 main()。

import { parentPort } from 'node:worker_threads';
import process from 'node:process';
import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten';

const outbox = [];
const deferreds = new Map();
const liveHandles = [];
let opSeq = 0;
let finished = false;
let disposed = false;

// VM 预算：由宿主经 load 消息下发（contract.ts 是唯一常量来源，此处只消费）。
let budgets = { heapBytes: 64 * 1024 * 1024, segmentMs: 2000, totalMs: 30000, jobs: 100000 };
let interruptReason = null;
let segmentStart = 0;
let totalVmMs = 0;
let totalJobs = 0;

const module = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
const runtime = module.newRuntime();
const ctx = runtime.newContext();

runtime.setInterruptHandler(() => {
  const now = Date.now();
  if (now - segmentStart > budgets.segmentMs) {
    interruptReason = interruptReason ?? 'vm_cpu_segment';
    return true;
  }
  if (totalVmMs + (now - segmentStart) > budgets.totalMs) {
    interruptReason = interruptReason ?? 'vm_budget_exceeded';
    return true;
  }
  if (totalJobs >= budgets.jobs) {
    interruptReason = interruptReason ?? 'jobs_budget_exceeded';
    return true;
  }
  return false;
});

function enterVm() {
  segmentStart = Date.now();
}

function leaveVm() {
  totalVmMs += Date.now() - segmentStart;
}

function flushOutbox() {
  if (finished || disposed || outbox.length === 0) return;
  parentPort.postMessage({ t: 'outbox', items: outbox.splice(0, outbox.length) });
}

function dumpError(handle) {
  let info;
  try {
    info = ctx.dump(handle);
  } catch {
    info = null;
  }
  const out = { name: 'Error', message: 'unknown vm error' };
  if (info && typeof info === 'object') {
    if (typeof info.name === 'string') out.name = info.name;
    if (typeof info.message === 'string') out.message = info.message;
    if (typeof info.code === 'string') out.code = info.code;
  } else if (info !== undefined) {
    out.message = String(info);
  }
  let codeHandle;
  try {
    codeHandle = ctx.getProp(handle, 'code');
    const code = ctx.dump(codeHandle);
    if (typeof code === 'string') out.code = code;
  } catch {
    // error 对象没有 code 字段时保持缺省
  } finally {
    try {
      codeHandle?.dispose();
    } catch {
      // 已释放则忽略
    }
  }
  if (interruptReason) out.code = interruptReason;
  else if (/out of memory/i.test(out.message) || /out of memory/i.test(out.name)) out.code = 'vm_out_of_memory';
  return out;
}

function settle(ok, payload) {
  if (finished) return;
  finished = true;
  flushOutboxNow();
  // pendingCalls：main 落定时仍未交付的调用数；宿主据此判 dangling calls（合同 §3）。
  const pendingCalls = deferreds.size;
  parentPort.postMessage(
    ok ? { t: 'settled', ok: true, value: payload, pendingCalls } : { t: 'settled', ok: false, error: payload, pendingCalls },
  );
}

function flushOutboxNow() {
  if (disposed || outbox.length === 0) return;
  parentPort.postMessage({ t: 'outbox', items: outbox.splice(0, outbox.length) });
}

// 泵尽本轮可运行 jobs（同一同步段）；预算超限或中断时上报 settled{ok:false}。
function pump() {
  if (finished || disposed) return;
  enterVm();
  try {
    while (true) {
      // 上限是“累计 >jobs”才超限：多给一个探测位，让恰好在边界排空的脚本正常完成。
      const remaining = budgets.jobs + 1 - totalJobs;
      const res = runtime.executePendingJobs(remaining);
      if (res.error) {
        const info = dumpError(res.error);
        try {
          res.error.dispose();
        } catch {
          // 已释放则忽略
        }
        settle(false, info);
        return;
      }
      totalJobs += res.value;
      if (totalJobs > budgets.jobs) {
        interruptReason = interruptReason ?? 'jobs_budget_exceeded';
        settle(false, { name: 'Error', message: 'jobs budget exceeded', code: 'jobs_budget_exceeded' });
        return;
      }
      if (res.value === 0) break;
    }
  } finally {
    leaveVm();
    flushOutbox();
  }
}

function safeDump(handle) {
  try {
    return ctx.dump(handle);
  } catch {
    return { __undumpable: true };
  }
}

// 脚本文本已是静态校验过的 ES module；prelude 负责注入 API 语义与 intrinsics 收缩。
function buildPrelude(meta, args) {
  const phasesJson = JSON.stringify(Array.isArray(meta?.phases) ? meta.phases : []);
  const argsJson = JSON.stringify(args === undefined ? null : args);
  return `(() => {
const declaredPhases = new Set(${phasesJson});
let fanoutPending = 0;
let currentPhase = null;
let logBytes = 0;
let logCount = 0;
let logDropped = false;
const hostCall = globalThis.__hostCall;
const hostPhase = globalThis.__hostPhase;
const hostLog = globalThis.__hostLog;
const hostWarn = globalThis.__hostWarn;
const stringify = JSON.stringify;
const parse = JSON.parse;
delete globalThis.__hostCall;
delete globalThis.__hostPhase;
delete globalThis.__hostLog;
delete globalThis.__hostWarn;
let activeHelpers = null;
let synchronousHelper = null;
const beginHelper = (kind) => {
  const scope = { kind, eligible: kind === 'parallel' && activeHelpers === null, next: activeHelpers };
  for (let active = activeHelpers; active !== null; active = active.next) active.eligible = false;
  activeHelpers = scope;
  return scope;
};
const endHelper = (scope) => {
  if (activeHelpers === scope) activeHelpers = scope.next;
  else {
    let previous = activeHelpers;
    while (previous.next !== scope) previous = previous.next;
    previous.next = scope.next;
  }
};
const invokeHelper = (scope, action) => {
  const previous = synchronousHelper;
  synchronousHelper = scope;
  try { return action(); }
  finally { synchronousHelper = previous; }
};

class WorkflowContractError extends Error {
  constructor(code, message) {
    super(message === undefined ? code : message);
    this.name = 'WorkflowContractError';
    this.code = code;
  }
}
globalThis.WorkflowContractError = WorkflowContractError;

globalThis.agent = (prompt, opts) => {
  // The same data-only options are checked here and dumped by the host. Getters
  // and toJSON cannot change isolation between the two boundaries.
  const snapshot = opts === undefined ? undefined : parse(stringify(opts));
  if (snapshot && snapshot.isolation === 'lane' && activeHelpers !== null &&
      !(synchronousHelper === activeHelpers && synchronousHelper.kind === 'parallel' && synchronousHelper.eligible)) {
    throw new WorkflowContractError('lane_not_serializable', 'lane_not_serializable: lane requires top level or the initial synchronous invocation of one parallel wave');
  }
  return hostCall(prompt, snapshot, currentPhase);
};

globalThis.phase = (title) => {
  if (typeof title !== 'string' || !declaredPhases.has(title)) {
    throw new WorkflowContractError('phase_not_declared', 'phase ' + JSON.stringify(title) + ' is not declared in meta.phases');
  }
  if (fanoutPending > 0) {
    throw new WorkflowContractError('phase_in_branch', 'phase() cannot be called inside parallel/pipeline branches');
  }
  currentPhase = title;
  hostPhase(title);
};

globalThis.log = (message) => {
  let text = String(message);
  if (text.length > 4096) text = text.slice(0, 4096);
  if (logCount >= 2000 || logBytes + text.length > 262144) {
    if (!logDropped) {
      logDropped = true;
      hostWarn('log_budget_exceeded', 'log budget exceeded; further log messages dropped');
    }
    return;
  }
  logCount += 1;
  logBytes += text.length;
  hostLog(text);
};

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};
globalThis.args = deepFreeze(JSON.parse(${JSON.stringify(argsJson)}));

const failedSlot = (code, error) => ({
  status: 'failed',
  code,
  message: String((error && error.message) || error),
  callId: null,
});

globalThis.parallel = (thunks) => {
  if (!Array.isArray(thunks)) throw new WorkflowContractError('invalid_args', 'parallel() requires an array of thunks');
  if (thunks.length > 4096) throw new WorkflowContractError('fanout_too_large', 'parallel() accepts at most 4096 thunks');
  const scope = beginHelper('parallel');
  const slots = new Array(thunks.length);
  const branches = thunks.map((thunk, i) => {
    fanoutPending += 1;
    let p;
    try {
      p = Promise.resolve(invokeHelper(scope, thunk));
    } catch (error) {
      p = Promise.reject(error);
    }
    return p.then(
      (value) => {
        fanoutPending -= 1;
        slots[i] = value;
      },
      (error) => {
        fanoutPending -= 1;
        slots[i] = failedSlot('branch_rejected', error);
      },
    );
  });
  return Promise.all(branches).then(
    () => { endHelper(scope); return slots; },
    (error) => { endHelper(scope); throw error; },
  );
};

globalThis.pipeline = (items, ...stages) => {
  if (!Array.isArray(items)) throw new WorkflowContractError('invalid_args', 'pipeline() requires an array of items');
  if (items.length > 4096) throw new WorkflowContractError('fanout_too_large', 'pipeline() accepts at most 4096 items');
  const scope = beginHelper('pipeline');
  const runners = items.map((item) =>
    (async () => {
      fanoutPending += 1;
      try {
        if (stages.length === 0) return { status: 'ok', value: item, callId: null };
        let input = item;
        let last = null;
        for (const stage of stages) {
          let result;
          try {
            result = await invokeHelper(scope, () => stage(input));
          } catch (error) {
            return failedSlot('stage_error', error);
          }
          const valid =
            result !== null &&
            typeof result === 'object' &&
            (result.status === 'ok' || result.status === 'failed' || result.status === 'conflict');
          if (!valid) return failedSlot('stage_contract', 'stage did not return an AgentResult');
          if (result.status !== 'ok') return result;
          last = result;
          input = result.value;
        }
        return last;
      } finally {
        fanoutPending -= 1;
      }
    })(),
  );
  return Promise.all(runners).then(
    (result) => { endHelper(scope); return result; },
    (error) => { endHelper(scope); throw error; },
  );
};

const blocked = (name) => () => {
  throw new Error(name + ' is not available in the workflow VM (deterministic sandbox)');
};
const DateStub = function Date() {
  throw new Error('Date is not available in the workflow VM (deterministic sandbox)');
};
DateStub.now = blocked('Date.now');
DateStub.parse = blocked('Date.parse');
DateStub.UTC = blocked('Date.UTC');
globalThis.Date = DateStub;
Math.random = blocked('Math.random');
delete globalThis.eval;
delete globalThis.Function;
})()`;
}

function onLoad(msg) {
  try {
    budgets = { ...budgets, ...(msg.budgets ?? {}) };
    runtime.setMemoryLimit(budgets.heapBytes);

    // 宿主函数：__hostCall 推 outbox 并返回 pending promise；其余只推事件。
    const callFn = ctx.newFunction('__hostCall', (promptHandle, optsHandle, phaseHandle) => {
      const opId = ++opSeq;
      const deferred = ctx.newPromise();
      deferreds.set(opId, deferred);
      outbox.push({
        kind: 'call',
        opId,
        prompt: safeDump(promptHandle),
        opts: safeDump(optsHandle),
        phase: safeDump(phaseHandle),
      });
      return deferred.handle;
    });
    ctx.setProp(ctx.global, '__hostCall', callFn);
    callFn.dispose();
    const phaseFn = ctx.newFunction('__hostPhase', (titleHandle) => {
      outbox.push({ kind: 'phase', title: safeDump(titleHandle) });
      return ctx.undefined;
    });
    ctx.setProp(ctx.global, '__hostPhase', phaseFn);
    phaseFn.dispose();
    const logFn = ctx.newFunction('__hostLog', (textHandle) => {
      outbox.push({ kind: 'log', message: safeDump(textHandle) });
      return ctx.undefined;
    });
    ctx.setProp(ctx.global, '__hostLog', logFn);
    logFn.dispose();
    const warnFn = ctx.newFunction('__hostWarn', (codeHandle, messageHandle) => {
      outbox.push({ kind: 'warn', code: safeDump(codeHandle), message: safeDump(messageHandle) });
      return ctx.undefined;
    });
    ctx.setProp(ctx.global, '__hostWarn', warnFn);
    warnFn.dispose();

    enterVm();
    const preludeResult = ctx.evalCode(buildPrelude(msg.meta, msg.args), 'prelude.js');
    leaveVm();
    if (preludeResult.error) {
      const info = dumpError(preludeResult.error);
      preludeResult.error.dispose();
      settle(false, info);
      return;
    }
    preludeResult.value.dispose();

    enterVm();
    const moduleResult = ctx.evalCode(msg.script, 'main.mjs', { type: 'module' });
    leaveVm();
    if (moduleResult.error) {
      const info = dumpError(moduleResult.error);
      moduleResult.error.dispose();
      settle(false, info);
      return;
    }
    const ns = moduleResult.value;
    const mainFn = ctx.getProp(ns, 'default');
    ns.dispose();
    if (ctx.typeof(mainFn) !== 'function') {
      mainFn.dispose();
      settle(false, { name: 'Error', message: 'default export is not a function', code: 'script_error' });
      return;
    }
    enterVm();
    const callResult = ctx.callFunction(mainFn, ctx.undefined, []);
    leaveVm();
    mainFn.dispose();
    if (callResult.error) {
      const info = dumpError(callResult.error);
      callResult.error.dispose();
      settle(false, info);
      return;
    }
    const mainPromise = callResult.value;
    liveHandles.push(mainPromise);
    ctx
      .resolvePromise(mainPromise)
      .then((res) => {
        mainPromise.dispose();
        // 无论 run 是否已终结，resolvePromise 产出的句柄都必须释放（否则 runtime 释放断言）。
        if (res.error) {
          const info = dumpError(res.error);
          res.error.dispose();
          if (!finished && !disposed) settle(false, info);
        } else {
          let value;
          try {
            value = ctx.dump(res.value);
          } catch {
            value = undefined;
          }
          res.value.dispose();
          if (!finished && !disposed) settle(true, value === undefined ? null : value);
        }
      })
      .catch(() => {
        try {
          mainPromise.dispose();
        } catch {
          // 已释放则忽略
        }
        settle(false, { name: 'Error', message: 'failed to settle main()', code: 'internal_error' });
      });
    pump();
  } catch (error) {
    settle(false, { name: 'Error', message: String((error && error.message) || error), code: interruptReason ?? 'internal_error' });
  }
}

function onDeliver(msg) {
  if (finished || disposed) return;
  const deferred = deferreds.get(msg.opId);
  if (!deferred) return; // 迟到或重复 deliver：忽略
  deferreds.delete(msg.opId);
  let valueHandle;
  try {
    enterVm();
    const res = ctx.evalCode('JSON.parse(' + JSON.stringify(JSON.stringify(msg.value ?? null)) + ')', 'deliver.js');
    leaveVm();
    if (res.error) {
      const info = dumpError(res.error);
      res.error.dispose();
      settle(false, info);
      return;
    }
    valueHandle = res.value;
  } catch (error) {
    settle(false, { name: 'Error', message: String((error && error.message) || error), code: 'internal_error' });
    return;
  }
  deferred.resolve(valueHandle);
  valueHandle.dispose();
  deferred.dispose();
  pump();
}

function onDispose() {
  if (disposed) return;
  disposed = true;
  for (const d of deferreds.values()) {
    try {
      d.dispose();
    } catch {
      // 已释放则忽略
    }
  }
  deferreds.clear();
  for (const h of liveHandles) {
    try {
      h.dispose();
    } catch {
      // 已释放则忽略
    }
  }
  try {
    ctx.dispose();
  } catch {
    // 已销毁则忽略
  }
  try {
    runtime.dispose();
  } catch {
    // 已销毁则忽略
  }
  try {
    parentPort.postMessage({ t: 'disposed' });
  } catch {
    // 通道已关闭则忽略
  }
  parentPort.close();
  process.exit(0);
}

parentPort.on('message', (msg) => {
  try {
    if (msg.t === 'load') onLoad(msg);
    else if (msg.t === 'deliver') onDeliver(msg);
    else if (msg.t === 'dispose') onDispose();
  } catch (error) {
    settle(false, { name: 'Error', message: String((error && error.message) || error), code: 'internal_error' });
  }
});

parentPort.postMessage({ t: 'ready' });
