/** Address entry accepts explicit URLs, bare hosts, or a search phrase. Main validates navigation. */
export function browserAddress(input: string): string {
  const value = input.trim();
  if (!value) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value) || /^(?:file|javascript|data|mailto|tel):/iu.test(value)) return value;
  if (!/\s/u.test(value) && /^(?:localhost(?=[:/]|$)|\[[\da-f:]+\]|[^/]+\.[^/]+)(?::\d+)?(?:[/?#]|$)/iu.test(value))
    return 'https://' + value;
  return 'https://www.baidu.com/s?wd=' + encodeURIComponent(value);
}
