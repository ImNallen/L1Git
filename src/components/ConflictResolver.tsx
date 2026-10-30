import { useEffect, useMemo, useRef, useState } from "react";
import { File, EditProvider } from "@pierre/diffs/react";
import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import focusStyles from "../styles/focus.css?inline";
import { RotateCcw } from "lucide-react";
import { diffTheme } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
import { conflictTextSchema, problemFrom } from "../domain/repository";
import type { ConflictFile, RepositoryRoot } from "../domain/repository";
import { useDraftImpact } from "../draftProtection";
import { useMergeState } from "../useMergeState";
import { mergeAllows } from "../domain/merge";
import {
  attachEditor,
  canMark,
  chooseResolution,
  completeEditor,
  editResolution,
  isDirty,
  isStale,
  markResolution,
  readResolution,
  reloadResolution,
  resolutionKey,
  saveResolution,
  useResolutionDraft,
} from "../resolutionDrafts";
import type { ResolutionDraft } from "../resolutionDrafts";
import type { WritesView } from "../useWrites";
import { ConflictChoices } from "./ConflictChoices";
import { ConfirmDialog } from "./ConfirmDialog";

const createEditor: EditorFactory<undefined, undefined> = (
  type,
  options,
  key,
) => new Editor(type, options, key);
const reasons: Record<
  Extract<ConflictFile, { kind: "external" }>["reason"],
  string
> = {
  structural:
    "This is a structural conflict. This editor supports both-modified files with all three versions present.",
  binary: "This file contains binary data.",
  encoding: "This file is not UTF-8 text with uniform LF or CRLF line endings.",
  tooLarge: "One of the file versions exceeds the 256 KiB editing limit.",
  specialFile: "Links, submodules and special files need external resolution.",
  attributes:
    "This file uses a Git filter, ident expansion or a working-tree encoding.",
};

type Props = {
  root: RepositoryRoot;
  path: string;
  refresh: unknown;
  theme: Appearance;
  painted: boolean;
  writes: WritesView;
  onResolved: () => void;
};
export function ConflictResolver({
  root,
  path,
  refresh,
  theme,
  painted,
  writes,
  onResolved,
}: Props) {
  const key = resolutionKey(root, path);
  const draft = useResolutionDraft(key);
  const { frozen } = useDraftImpact();
  const [read, setRead] = useState<
    | { kind: "loading" }
    | { kind: "ready"; source: ConflictFile }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [mergeRead] = useMergeState(root, read);
  const [retry, setRetry] = useState(0);
  const [source, setSource] = useState<"base" | "current" | "incoming">(
    "current",
  );
  const [mode, setMode] = useState<"choices" | "edit">("choices");
  const [discardRevision, setDiscardRevision] = useState<number | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setRead({ kind: "loading" });
    void readResolution(root, path).then(
      (source) => {
        if (active && source) setRead({ kind: "ready", source });
      },
      (error) => {
        if (active)
          setRead({ kind: "error", message: problemFrom(error).message });
      },
    );
    return () => {
      active = false;
    };
  }, [root, path, refresh, retry]);
  const options = useMemo(
    () => editorOptions(theme, painted),
    [theme, painted],
  );
  const file = useMemo(
    () => draft && { name: path, contents: draft.text },
    [path, draft?.editorEpoch, mode],
  );
  const choiceOptions = useMemo(
    () => ({
      ...options,
      mergeConflictActionsType: "default" as const,
      onMergeConflictResolve: (file: { contents: string }) => {
        if (draft) chooseResolution(key, draft.editorEpoch, file.contents);
      },
    }),
    [options, key, draft?.editorEpoch],
  );
  if (!draft)
    return (
      <div className="file-diff-empty" role="status">
        <p>
          {read.kind === "loading"
            ? "Reading conflict versions…"
            : read.kind === "error"
              ? read.message
              : read.source.kind === "external"
                ? `${reasons[read.source.reason]} Resolve it outside L1 Git, then refresh and mark it resolved.`
                : "Reading result…"}
        </p>
        {read.kind !== "loading" && (
          <button
            className="button secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            Refresh conflict
          </button>
        )}
      </div>
    );
  const dirty = isDirty(draft);
  const stale = isStale(draft);
  const allowed =
    mergeRead.kind === "ready" &&
    mergeAllows(mergeRead.value, {
      kind: "stageFiles",
      entries: [draft.snapshot.entry],
    });
  const busy =
    frozen || draft.phase.kind !== "editing" || writes.running !== null;
  const problem = draft.phase.kind === "editing" ? draft.phase.problem : null;
  const valid = conflictTextSchema.safeParse(draft.text).success;
  return (
    <EditProvider createEditor={createEditor}>
      <div className="conflict-resolver">
        <section className="conflict-source" aria-label="Git index versions">
          <div className="conflict-toolbar">
            <span>Git index versions</span>
            <div
              className="diff-style"
              role="group"
              aria-label="Conflict version"
            >
              {(["base", "current", "incoming"] as const).map((side) => (
                <button
                  key={side}
                  aria-pressed={source === side}
                  onClick={() => setSource(side)}
                >
                  {side[0]?.toUpperCase()}
                  {side.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="conflict-code">
            <File
              file={{ name: path, contents: draft.snapshot[source] }}
              options={options}
            />
          </div>
        </section>
        <section className="conflict-result" aria-label="Resolution result">
          <div className="conflict-toolbar">
            <strong>Result</strong>
            <span role="status">{dirty ? "Unsaved" : "Saved on disk"}</span>
            <div className="diff-style" role="group" aria-label="Result mode">
              <button
                aria-pressed={mode === "choices"}
                disabled={busy}
                onClick={() => setMode("choices")}
              >
                Choices
              </button>
              <button
                aria-pressed={mode === "edit"}
                disabled={busy}
                onClick={() => setMode("edit")}
              >
                Edit
              </button>
            </div>
            <button
              className="button primary"
              disabled={
                busy ||
                !allowed ||
                read.kind === "loading" ||
                !dirty ||
                stale ||
                !valid
              }
              onClick={() => void saveResolution(key, writes.write)}
            >
              Save result
            </button>
            <button
              className="button secondary"
              disabled={
                busy || !allowed || read.kind === "loading" || !canMark(draft)
              }
              onClick={() =>
                void markResolution(key, writes.write).then((marked) => {
                  if (marked) onResolved();
                })
              }
            >
              Mark resolved
            </button>
          </div>
          <p className="conflict-help">
            Save changes the working file. Review the result, then Mark resolved
            stages it. Undo reverses these two actions separately.
          </p>
          {!allowed && (
            <p role="status">
              {mergeRead.kind === "loading"
                ? "Checking merge state…"
                : mergeRead.kind === "error"
                  ? mergeRead.error.message
                  : mergeRead.value.kind === "attention"
                    ? mergeRead.value.message
                    : "This path is outside the merge's affected paths. Preserve it externally before continuing."}
            </p>
          )}
          {(stale || problem || read.kind === "error" || !valid) && (
            <div className="notice error-notice" role="alert">
              {stale
                ? "The file or conflict changed on disk. Your result is retained. Copy it or reload from disk before saving."
                : (problem ??
                  (read.kind === "error"
                    ? read.message
                    : "The result must be text without NUL bytes, up to 256 KiB."))}
            </div>
          )}
          <div
            className="conflict-code"
            inert={
              frozen ||
              draft.phase.kind === "marking" ||
              (mode === "choices" && busy)
            }
          >
            {mode === "choices" && file ? (
              <ConflictChoices file={file} options={choiceOptions} />
            ) : (
              <ResultEditor
                key={draft.editorEpoch}
                draftKey={key}
                draft={draft}
                options={options}
              />
            )}
          </div>
          <div className="conflict-toolbar">
            <button
              className="button secondary"
              onClick={() =>
                void navigator.clipboard.writeText(draft.text).then(
                  () => setCopyProblem(null),
                  () =>
                    setCopyProblem(
                      "Could not copy the result. Select the text in Edit and copy it.",
                    ),
                )
              }
            >
              Copy result
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setDiscardRevision(draft.revision)}
            >
              Reload from disk…
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setRetry((value) => value + 1)}
            >
              Refresh conflict
            </button>
            {copyProblem && <span role="alert">{copyProblem}</span>}
          </div>
        </section>
      </div>
      {discardRevision !== null && (
        <ConfirmDialog
          icon={RotateCcw}
          title="Discard this result draft?"
          closeLabel="Keep result draft"
          confirm="Discard draft and reload"
          onClose={() => setDiscardRevision(null)}
          onConfirm={() =>
            void reloadResolution(key, discardRevision).then(() =>
              setRetry((value) => value + 1),
            )
          }
        >
          <p>
            Your unsaved result for {path} will be discarded. L1 Git will read
            the conflict from disk again.
          </p>
        </ConfirmDialog>
      )}
    </EditProvider>
  );
}

function ResultEditor({
  draftKey,
  draft,
  options,
}: {
  draftKey: string;
  draft: ResolutionDraft;
  options: ReturnType<typeof editorOptions>;
}) {
  const [session] = useState(() => Symbol("resolution editor"));
  const [initial] = useState(() => ({
    name: draft.snapshot.path,
    contents: draft.text,
  }));
  const epoch = draft.editorEpoch;
  return (
    <File
      file={initial}
      options={options}
      edit
      editStateKey={`${draftKey}:${epoch}`}
      editorOptions={{ onAttach: () => attachEditor(draftKey, epoch, session) }}
      onEditChange={(event) =>
        editResolution(draftKey, epoch, session, event.file.contents)
      }
      onEditComplete={(event) => {
        completeEditor(draftKey, epoch, session, event.file.contents);
        return "accept";
      }}
    />
  );
}
function editorOptions(theme: Appearance, painted: boolean) {
  return {
    theme: diffTheme(theme, painted),
    unsafeCSS: focusStyles,
    themeType: theme,
    disableFileHeader: true,
  };
}

export function RetainedResolution({
  onClose,
  ...props
}: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="resolution-dialog file-diff"
      aria-label={`Unsaved resolution for ${props.path}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="conflict-toolbar">
        <strong>{props.path}</strong>
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
      </header>
      <ConflictResolver {...props} />
    </dialog>
  );
}
