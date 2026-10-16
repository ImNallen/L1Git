export function shortDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const age = Math.max(0, Date.now() - date.getTime());
  if (age < 60_000) return "Just now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  if (age < 604_800_000) return `${Math.floor(age / 86_400_000)}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
