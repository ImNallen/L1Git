import { useLayoutEffect, useRef } from "react";
import { File, UnresolvedFile } from "@pierre/diffs";
import type { FileContents, UnresolvedFileOptions } from "@pierre/diffs";

// The 1.5.2 React wrapper injects onMergeConflictAction, which conflicts with onMergeConflictResolve.
export function ConflictChoices({
  file,
  options,
}: {
  file: FileContents;
  options: UnresolvedFileOptions<undefined>;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    const instance = new UnresolvedFile(options);
    instance.render({ file, containerWrapper: host.current });
    if (instance.fileDiff?.hunks.length === 0) {
      instance.cleanUp();
      const result = new File({
        theme: options.theme,
        themeType: options.themeType,
        disableFileHeader: options.disableFileHeader,
        unsafeCSS: options.unsafeCSS,
      });
      result.render({ file, containerWrapper: host.current });
      return () => result.cleanUp();
    }
    return () => instance.cleanUp();
  }, [file, options]);
  return <div ref={host} />;
}
