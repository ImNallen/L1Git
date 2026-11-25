/** Nothing for a file without counted lines. */
export function LineTotals({
  added,
  deleted,
}: {
  added: number | null;
  deleted: number | null;
}) {
  if (added === null || deleted === null) return null;
  return (
    <span className="line-totals">
      <span className="change-stat added">+{added.toLocaleString()}</span>
      <span className="change-stat deleted">
        {"−"}
        {deleted.toLocaleString()}
      </span>
    </span>
  );
}
