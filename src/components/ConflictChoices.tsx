import { useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { Ref } from "react";
import { File, UnresolvedFile } from "@pierre/diffs";
import type {
  FileContents,
  MergeConflictResolution,
  UnresolvedFileOptions,
} from "@pierre/diffs";

export type ConflictCard = {
  index: number;
  startLineIndex: number;
  host: HTMLElement;
};
export type ConflictChoicesHandle = {
  choose: (index: number, resolution: MergeConflictResolution) => void;
};
type Options = Omit<
  UnresolvedFileOptions<undefined>,
  | "mergeConflictActionsType"
  | "onMergeConflictAction"
  | "onMergeConflictResolve"
>;

// The 1.5.2 React wrapper injects onMergeConflictAction and owns resolution state, so this mounts the vanilla UnresolvedFile.
export function ConflictChoices({
  ref,
  file,
  options,
  onCards,
  onChoose,
}: {
  ref?: Ref<ConflictChoicesHandle>;
  file: FileContents;
  options: Options;
  onCards: (cards: ConflictCard[]) => void;
  onChoose: (contents: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<UnresolvedFile<undefined> | null>(null);
  const callbacks = useRef({ onCards, onChoose });
  useLayoutEffect(() => {
    callbacks.current = { onCards, onChoose };
  });
  useImperativeHandle(ref, () => ({
    choose: (index, resolution) => {
      const resolved = instance.current?.resolveConflict(index, resolution);
      if (resolved) callbacks.current.onChoose(resolved.file.contents);
    },
  }));
  useLayoutEffect(() => {
    if (!host.current) return;
    let cards: ConflictCard[] = [];
    const created = new UnresolvedFile({
      ...options,
      mergeConflictActionsType: (action) => {
        const slot = document.createElement("div");
        slot.className = "conflict-card-slot";
        cards = [
          ...cards.filter((card) => card.index !== action.conflictIndex),
          {
            index: action.conflictIndex,
            startLineIndex: action.conflict.startLineIndex,
            host: slot,
          },
        ].sort((left, right) => left.index - right.index);
        callbacks.current.onCards(cards);
        return slot;
      },
    });
    created.render({ file, containerWrapper: host.current });
    if (created.fileDiff?.hunks.length === 0) {
      created.cleanUp();
      callbacks.current.onCards([]);
      const result = new File({
        theme: options.theme,
        themeType: options.themeType,
        disableFileHeader: options.disableFileHeader,
        unsafeCSS: options.unsafeCSS,
      });
      result.render({ file, containerWrapper: host.current });
      return () => result.cleanUp();
    }
    instance.current = created;
    return () => {
      instance.current = null;
      created.cleanUp();
      callbacks.current.onCards([]);
    };
  }, [file, options]);
  return <div ref={host} />;
}
