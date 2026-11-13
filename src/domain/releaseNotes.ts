type Change = { title: string; pullNumber: string | null };

type ReleaseNotes =
  | { kind: "changes"; changes: Change[] }
  | { kind: "text"; text: string };

export function releaseNotes(notes: string): ReleaseNotes {
  const lines = notes.trim().split(/\r?\n/);
  if (lines[0] === "## What's Changed") lines.shift();
  const changes: Change[] = [];
  let formatted = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bullet = /^[*-] /.test(trimmed);
    let title = trimmed.replace(/^[*-] /, "");
    const reference =
      / by @[\w-]+ in https:\/\/github\.com\/ImNallen\/L1Git\/pull\/([1-9]\d*)$/.exec(
        title,
      ) ?? / \(#([1-9]\d*)\)$/.exec(title);
    if (reference) title = title.slice(0, reference.index);
    if (!title || /[<>`\[\]#*]|:\/\//.test(title))
      return { kind: "text", text: notes };
    formatted ||= bullet || reference !== null;
    changes.push({ title, pullNumber: reference?.[1] ?? null });
  }
  return changes.length && (formatted || changes.length > 1)
    ? { kind: "changes", changes }
    : { kind: "text", text: notes };
}
