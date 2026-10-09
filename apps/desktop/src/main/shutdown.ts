/** Independent owners both get a cleanup attempt; failure prevents window closure. */
export async function shutdownOwners(owners: (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(owners.map((close) => Promise.resolve().then(close)));
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, '运行资源清理未确认');
}
