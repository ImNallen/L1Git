import { use, useMemo } from "react";
import type { ReactNode } from "react";
import { FileDiff } from "@pierre/diffs/react";
import { getFiletypeFromFileName, parsePatchFiles } from "@pierre/diffs";
import { InTurn } from "./InTurn";
import { patchOptions } from "./patchOptions";
import { SurroundingsContext } from "./pullRequestText";

/** One hunk of a file. Throws when Pierre can't read it. */
export function Hunk({
  path,
  patch,
  before,
}: {
  path: string;
  patch: string;
  before: ReactNode;
}) {
  const { theme, painted } = use(SurroundingsContext);
  const file = useMemo(() => {
    const [found] = parsePatchFiles(patch).flatMap(({ files }) => files);
    if (found?.hunks.length !== 1) throw new Error("This is not one hunk.");
    return { ...found, name: path, prevName: undefined };
  }, [path, patch]);
  const options = useMemo(
    () =>
      ({
        ...patchOptions(theme, painted),
        diffStyle: "unified",
        diffIndicators: "classic",
        hunkSeparators: "simple",
        disableFileHeader: true,
      }) as const,
    [theme, painted],
  );
  return (
    <InTurn
      code={patch}
      language={getFiletypeFromFileName(path)}
      before={before}
    >
      <FileDiff fileDiff={file} options={options} />
    </InTurn>
  );
}
