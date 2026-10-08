import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUEST_BROWSER_SANDBOX, ResourceBundleSchema } from '@wsl/protocol';
import { captureGuestPage, saveGuestCapture } from './guest-browser-bridge';
import { ResourceStore } from './resource-store';
import resourceMcp from './resource_mcp.py?raw';

const live = process.env['WSL_LIVE_GUEST_BROWSER'] === '1';
const binary = '/opt/homebrew/bin/sbx';
const evidenceRoot = '/Users/huaodong/workspace/_agent-reports/20261007/sandbox-browser-test';

describe.skipIf(!live)('既有 sandbox guest 浏览器与同一产物 MCP（无模型）', () => {
  it('采集真实 DOM/PNG、保存空间资源并经 guest stdio MCP 精确读取', async () => {
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const attemptId = randomUUID();
    const attemptRoot = path.join(evidenceRoot, `capture-${attemptId}`);
    await mkdir(attemptRoot, { mode: 0o700 });
    const result = await captureGuestPage(binary, attemptId, { startStoppedSandbox: true });
    const evidence = result.ok
      ? {
          ...result,
          screenshot: { mimeType: result.screenshot.mimeType, sha256: result.screenshot.sha256, bytes: result.screenshot.bytes },
        }
      : result;
    await writeFile(path.join(attemptRoot, 'capture-result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    expect(result.ok, result.ok ? '' : result.error.code + ': ' + result.error.message).toBe(true);
    if (!result.ok) return;
    const saved = await saveGuestCapture(new ResourceStore(path.join(attemptRoot, 'space')), path.join(attemptRoot, 'artifacts'), result);
    const bundle = ResourceBundleSchema.parse({
      conversationId: 'conv-space-taskflow-demo-impl',
      generation: attemptId,
      turnId: attemptId,
      spaceId: 'taskflow-demo',
      collectionRevision: saved.collection.revision,
      resources: saved.collection.resources,
    });
    const client = `import types,sys,json,os,subprocess,hashlib,errno\nsource=${JSON.stringify(resourceMcp)}\nmcp=types.ModuleType('mcp')\nexec(compile(source,'<resource-mcp>','exec'),mcp.__dict__)\nbundle=json.load(sys.stdin)\nfd=mcp.sealed_bundle(bundle)\ntry:\n denied=0\n for op in (lambda:os.write(fd,b'x'),lambda:os.ftruncate(fd,0),lambda:os.ftruncate(fd,1048576)):\n  try:op()\n  except OSError as e:\n   if e.errno==errno.EPERM:denied+=1\n record=bundle['resources'][0]\n requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'wsl-guest-browser-test','version':'1'}}},{'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'list_resources','arguments':{}}},{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'read_resource','arguments':{'resourceId':record['resourceId'],'version':record['version']}}},{'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'read_resource','arguments':{'resourceId':record['resourceId'],'version':record['version']+1}}}]\n p=subprocess.run([sys.executable,'-I','-u','-c',source,'/proc/%d/fd/%d'%(os.getpid(),fd)],input=''.join(json.dumps(r)+'\\n' for r in requests),capture_output=True,text=True,timeout=15)\n if p.returncode:raise RuntimeError('MCP process failed')\n responses=[json.loads(line) for line in p.stdout.splitlines()]\n data=responses[2]['result']['structuredContent']['data']\n print(json.dumps({'sealedMutationsDenied':denied,'list':responses[1]['result']['structuredContent'],'read':responses[2]['result']['structuredContent'],'staleVersionRejected':'error' in responses[3],'readContentSha256':hashlib.sha256(data['text'].encode()).hexdigest(),'modelCalls':0}))\nfinally:os.close(fd)\n`;
    const probe = spawnSync(binary, ['exec', '-i', GUEST_BROWSER_SANDBOX, 'python3', '-I', '-c', client], {
      input: JSON.stringify(bundle),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(probe.status).toBe(0);
    const receipt = JSON.parse(probe.stdout);
    await writeFile(path.join(attemptRoot, 'mcp-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    expect(receipt.sealedMutationsDenied).toBe(3);
    expect(receipt.staleVersionRejected).toBe(true);
    expect(receipt.read.untrusted).toBe(true);
    expect(receipt.read.data).toEqual(saved.resource);
    expect(receipt.list.data.resources[0].resourceId).toBe(saved.resource.resourceId);
    expect(receipt.readContentSha256).toBe(saved.resource.contentSha256);
    expect(
      createHash('sha256')
        .update(await readFile(saved.screenshotArtifact))
        .digest('hex'),
    ).toBe(saved.resource.extractionVersion === 'rendered-dom-text-v1' ? saved.resource.screenshotSha256 : 'wrong source');
  }, 110000);
});
