import { useMemo } from "react";
import { FileX2, TriangleAlert } from "lucide-react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { diffTheme } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
import type { FilePatch } from "../domain/repository";

export type DiffStyle = "unified" | "split";

export function Diff({
  diff,
  diffStyle,
  theme,
  painted,
}: {
  diff: FilePatch;
  diffStyle: DiffStyle;
  theme: Appearance;
  painted: boolean;
}) {
  if (diff.kind !== "text")
    return (
      <div className="file-diff-empty">
        <FileX2 size={28} />
        <p>
          {diff.kind === "binary"
            ? "Binary file. L1 Git does not display binary changes."
            : `This change is ${(diff.bytes / 1024 / 1024).toFixed(1)} MiB, above the 1 MiB display limit.`}
        </p>
      </div>
    );
  return (
    <>
      {diff.lossy && (
        <div className="notice error-notice" role="status">
          <TriangleAlert size={14} />
          <span>
            This file is not valid UTF-8. Bytes that are not UTF-8 appear as �,
            so some changed lines can look identical.
          </span>
        </div>
      )}
      <Patch
        patch={diff.patch}
        diffStyle={diffStyle}
        theme={theme}
        painted={painted}
      />
    </>
  );
}

function Patch({
  patch,
  diffStyle,
  theme,
  painted,
}: {
  patch: string;
  diffStyle: DiffStyle;
  theme: Appearance;
  painted: boolean;
}) {
  const files = useMemo(
    () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
    [patch],
  );
  const options = useMemo(
    () =>
      ({
        theme: diffTheme(theme, painted),
        themeType: theme,
        diffStyle,
        disableFileHeader: true,
      }) as const,
    [diffStyle, theme, painted],
  );
  if (files.every((file) => file.hunks.length === 0)) {
    const moved = files.find(
      (file) => file.prevName !== undefined && file.prevName !== file.name,
    );
    return (
      <div className="file-diff-empty">
        <p>
          {moved
            ? `${/^copy from /m.test(patch) ? "Copied" : "Renamed"} from ${moved.prevName}. The content did not change.`
            : "No content changes. Only the file mode or an empty file changed."}
        </p>
      </div>
    );
  }
  return (
    <Virtualizer className="file-diff-scroll">
      {files.map((file, index) => (
        <FileDiff key={index} fileDiff={file} options={options} />
      ))}
    </Virtualizer>
  );
}
