/** The RPC sends only message, so preserve nested owner diagnostics there too. */
function shutdownErrorMessage(error: unknown, ancestors = new Set<Error>()): string {
  if (!(error instanceof Error)) return String(error);
  if (ancestors.has(error)) return '[circular error reference]';
  ancestors.add(error);
  const messages = [error.message];
  if (error instanceof AggregateError) for (const nested of error.errors) messages.push(shutdownErrorMessage(nested, ancestors));
  if (error.cause !== undefined) messages.push(shutdownErrorMessage(error.cause, ancestors));
  ancestors.delete(error);
  return messages.filter(Boolean).join('\n');
}

/** App mappings need the shared connection until app cleanup settles. */
export async function shutdownServiceOwners(
  apps: () => Promise<void>,
  chat: () => Promise<void>,
  environments: () => Promise<void>,
): Promise<void> {
  const appResult = await Promise.allSettled([Promise.resolve().then(apps)]);
  const results = [...appResult, ...(await Promise.allSettled([Promise.resolve().then(chat), Promise.resolve().then(environments)]))];
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, errors.map((error: unknown) => shutdownErrorMessage(error)).join('\n'));
}
