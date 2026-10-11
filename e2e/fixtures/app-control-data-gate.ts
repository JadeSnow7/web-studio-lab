/** Only patched into the newly created live-test project; never installed in product/template source. */
export function installDataGate(source: string, directory: string, nonce: string) {
  const imports = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { setTimeout as delay } from 'node:timers/promises';\n`;
  const gate = `
async function testDataGate(operationId: string, operation: string, appInstanceId: string) {
  if (appInstanceId !== process.env.WSL_APP_INSTANCE_ID) return;
  const directory = ${JSON.stringify(directory)};
  mkdirSync(directory, { recursive: true });
  writeFileSync(directory + '/entered.json', JSON.stringify({ nonce: ${JSON.stringify(nonce)}, operationId, operation, appInstanceId, pid: process.pid, at: Date.now() }));
  const started = Date.now();
  while (!existsSync(directory + '/release')) {
    if (Date.now() - started > 180000) throw new Error('Owned live data gate timed out');
    await delay(100);
  }
}
`;
  if (!source.includes('.then(work)') || !source.includes('    return result;'))
    throw new Error('AgentOperations gate insertion point changed');
  return (
    imports +
    source
      .replace('type Operation =', gate + '\ntype Operation =')
      .replace('.then(work)', '.then(async () => { await testDataGate(id, operation, this.appInstanceId); return work(); })')
      .replace(
        '    return result;',
        `    return result.then((envelope) => {
      if (this.appInstanceId === process.env.WSL_APP_INSTANCE_ID) writeFileSync(${JSON.stringify(directory + '/terminal.json')}, JSON.stringify({ nonce: ${JSON.stringify(nonce)}, receipt, pid: process.pid, at: Date.now() }));
      return envelope;
    });`,
      )
  );
}
