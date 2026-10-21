declare global {
  var __wslSourceDispatchAudit: unknown;
}

// Observation only: every original utility request/reply is forwarded untouched, without a gate or fake response.
export const sourceDispatchAudit = `
const sourceAuditElectron = require('electron');
const sourceAuditFs = require('node:fs');
const sourceAuditPath = require('node:path');
const sourceAudit = globalThis.__wslSourceDispatchAudit = { sends: [], sourceRequests: [], appCalls: [], truncated: false };
const sourceAuditAppend = (list, record, limit) => {
  if (list.length >= limit) sourceAudit.truncated = true;
  else list.push(record);
};
const sourceAuditFork = sourceAuditElectron.utilityProcess.fork.bind(sourceAuditElectron.utilityProcess);
sourceAuditElectron.utilityProcess.fork = (...args) => {
  const child = sourceAuditFork(...args);
  const originalPost = child.postMessage.bind(child);
  child.on('message', (message) => {
    if (message && message.type === 'app-call')
      sourceAuditAppend(sourceAudit.appCalls, { runId: message.scope?.runId, tool: message.tool }, 100);
  });
  child.postMessage = (...parameters) => {
    const message = parameters[0];
    if (message?.method === 'app.source.snapshot')
      sourceAuditAppend(sourceAudit.sourceRequests, structuredClone(message.payload), 10);
    if (message?.method === 'send') {
      const runId = message.payload?.observationScope?.runId;
      const receipt = { runId, beforeDispatch: true, baseline: null, error: null, outboundHostDetails: null };
      try {
        if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new Error('invalid bound run');
        const profile = sourceAuditElectron.app.getPath('userData');
        const file = sourceAuditPath.join(profile, 'runs', runId, 'baseline.json');
        const info = sourceAuditFs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw new Error('invalid baseline');
        receipt.baseline = JSON.parse(sourceAuditFs.readFileSync(file, 'utf8'));
        const outbound = JSON.stringify(message.payload);
        receipt.outboundHostDetails = [profile, 'objects.git', 'baseline.json', 'source.patch', receipt.baseline.baseTree].some((value) => typeof value === 'string' && outbound.includes(value));
      } catch {
        receipt.error = 'Host baseline was not readable before model dispatch';
      }
      sourceAuditAppend(sourceAudit.sends, receipt, 10);
    }
    return originalPost(...parameters);
  };
  return child;
};
`;
