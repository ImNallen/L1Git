export type DiffstatBlock = "added" | "deleted" | "neutral";

/**
 * GitHub's five diffstat blocks: one colored block per changed line, at most
 * five, split by the share of added lines.
 */
export function diffstatBlocks(
  added: number,
  deleted: number,
): DiffstatBlock[] {
  const total = added + deleted;
  const colored = Math.min(5, total);
  const greens = total === 0 ? 0 : Math.round((colored * added) / total);
  return [
    ...Array<DiffstatBlock>(greens).fill("added"),
    ...Array<DiffstatBlock>(colored - greens).fill("deleted"),
    ...Array<DiffstatBlock>(5 - colored).fill("neutral"),
  ];
}
