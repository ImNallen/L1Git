const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const shortSuffixes: Partial<Record<Intl.RelativeTimeFormatUnit, string>> = {
  year: "y",
  month: "mo",
  week: "w",
  day: "d",
  hour: "h",
  minute: "m",
};

/** "3h", "2mo", "now" for a Unix timestamp in seconds, where a column is tight. */
export function shortRelativeTime(
  timestamp: number,
  now = Date.now() / 1000,
): string {
  const elapsed = now - timestamp;
  if (Math.abs(elapsed) < 60) return "now";
  const unit = units.find(([, seconds]) => Math.abs(elapsed) >= seconds);
  if (!unit) return "now";
  const span = `${Math.round(Math.abs(elapsed) / unit[1])}${shortSuffixes[unit[0]]}`;
  return elapsed < 0 ? `in ${span}` : span;
}

/** "3 hours ago", "yesterday", "just now" for a Unix timestamp in seconds. */
export function relativeTime(
  timestamp: number,
  now = Date.now() / 1000,
  locale?: string,
): string {
  const elapsed = now - timestamp;
  if (Math.abs(elapsed) < 60) return "just now";
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, seconds] of units)
    if (Math.abs(elapsed) >= seconds)
      return format.format(-Math.round(elapsed / seconds), unit);
  return format.format(-Math.round(elapsed / 60), "minute");
}
