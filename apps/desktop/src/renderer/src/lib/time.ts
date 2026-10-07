const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}
