/** App mappings need the shared connection until app cleanup settles. */
export async function shutdownServiceOwners(
  apps: () => Promise<void>,
  chat: () => Promise<void>,
  environments: () => Promise<void>,
): Promise<void> {
  const appResult = await Promise.allSettled([Promise.resolve().then(apps)]);
  const results = [...appResult, ...(await Promise.allSettled([Promise.resolve().then(chat), Promise.resolve().then(environments)]))];
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length)
    throw new AggregateError(errors, errors.map((error: unknown) => (error instanceof Error ? error.message : String(error))).join('\n'));
}
