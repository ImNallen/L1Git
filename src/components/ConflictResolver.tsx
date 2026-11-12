import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { File, EditProvider } from "@pierre/diffs/react";
import type { MergeConflictResolution } from "@pierre/diffs";
import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import focusStyles from "../styles/focus.css?inline";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Ellipsis,
  FileText,
  HardDriveDownload,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { typingIn } from "../actions";
import { diffTheme } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
import { conflictRegions, hasLeftoverMarkers } from "../domain/conflictRegions";
import { inProgress } from "../domain/inProgress";
import { conflictTextSchema, problemFrom } from "../domain/repository";
import type { ConflictFile, RepositoryRoot } from "../domain/repository";
import { useDraftImpact } from "../draftProtection";
import { useMergeState } from "../useMergeState";
import { mergeAllows, replayNames } from "../domain/merge";
import {
  attachEditor,
  chooseResolution,
  completeEditor,
  editResolution,
  isDirty,
  isStale,
  markBlock,
  markResolution,
  readResolution,
  reloadResolution,
  resolutionKey,
  saveResolution,
  useResolutionDraft,
} from "../resolutionDrafts";
import type { MarkBlock, ResolutionDraft } from "../resolutionDrafts";
import type { WritesView } from "../useWrites";
import { ConflictChoices } from "./ConflictChoices";
import type { ConflictCard, ConflictChoicesHandle } from "./ConflictChoices";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import { SideChip } from "./OperationStrip";

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
const markReasons: Record<MarkBlock | "busy", string> = {
  conflicts: "Resolve every conflict first.",
  markers: "Remove the leftover conflict markers first.",
  unsaved: "Save the result first.",
  stale: "The file changed on disk. Reload it first.",
  working: "Wait for the save to finish.",
  problem: "Refresh the conflict first.",
  reading: "Wait for L1 Git to read the file.",
  busy: "Wait for the current operation to finish.",
};

const choices: {
  resolution: MergeConflictResolution;
  label: string;
  key: string;
}[] = [
  { resolution: "current", label: "Current", key: "1" },
  { resolution: "incoming", label: "Incoming", key: "2" },
  { resolution: "both", label: "Both", key: "3" },
];
type Command =
  | { kind: "choose"; resolution: MergeConflictResolution }
  | { kind: "edit" }
  | { kind: "move"; by: 1 | -1 };
const shortcuts: Record<string, Command> = {
  ...Object.fromEntries(
    choices.map(({ resolution, key }) => [key, { kind: "choose", resolution }]),
  ),
  e: { kind: "edit" },
  j: { kind: "move", by: 1 },
  k: { kind: "move", by: -1 },
};

type Sides = { current: string; incoming: string } | null;

type Props = {
  root: RepositoryRoot;
  path: string;
  refresh: unknown;
  theme: Appearance;
  painted: boolean;
  writes: WritesView;
  onResolved: () => void;
  leading: ReactNode;
};
export function ConflictResolver({
  root,
  path,
  refresh,
  theme,
  painted,
  writes,
  onResolved,
  leading,
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
  const [editAt, setEditAt] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  const [cards, setCards] = useState<ConflictCard[]>([]);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [discardRevision, setDiscardRevision] = useState<number | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  const resolver = useRef<HTMLDivElement>(null);
  const choicesRef = useRef<ConflictChoicesHandle>(null);
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
  const running =
    mergeRead.kind === "ready" ? inProgress(mergeRead.value) : null;
  const sides: Sides =
    running?.kind === "running"
      ? { current: running.current.name, incoming: running.incoming.name }
      : null;
  const options = useMemo(
    () => editorOptions(theme, painted),
    [theme, painted],
  );
  const epoch = draft?.editorEpoch;
  const file = useMemo(
    () => draft && { name: path, contents: draft.text },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the editor owns the text within an epoch; only a new epoch replaces its file
    [path, epoch, mode],
  );
  const labels = markerLabels(sides);
  const choiceOptions = useMemo(
    () => ({ ...options, unsafeCSS: `${options.unsafeCSS}${labels}` }),
    [options, labels],
  );
  const name = path.slice(path.lastIndexOf("/") + 1);
  const directory = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
  const header = (children?: ReactNode) => (
    <header className="conflict-header">
      {leading}
      <span className="conflict-divider" aria-hidden="true" />
      <FileText size={14} className="conflict-file-icon" aria-hidden="true" />
      <strong className="conflict-file-name" title={path}>
        {name}
      </strong>
      {directory && (
        <span className="conflict-file-directory">{directory}</span>
      )}
      {children}
    </header>
  );
  if (!draft)
    return (
      <div className="conflict-resolver">
        {header()}
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
      </div>
    );
  const dirty = isDirty(draft);
  const stale = isStale(draft);
  const regions = conflictRegions(draft.text);
  const leftover = regions === 0 && hasLeftoverMarkers(draft.text);
  const focused = Math.max(0, Math.min(focus, regions - 1));
  const allowed =
    mergeRead.kind === "ready" &&
    mergeAllows(mergeRead.value, {
      kind: "stageFiles",
      entries: [draft.snapshot.entry],
    });
  const notAllowed = allowed
    ? null
    : mergeRead.kind === "loading"
      ? "Checking for an operation in progress…"
      : mergeRead.kind === "error"
        ? mergeRead.error.message
        : mergeRead.value.kind === "attention"
          ? mergeRead.value.message
          : `This path is outside the ${mergeRead.value.kind === "replay" ? replayNames[mergeRead.value.progress.kind].noun : "merge"}'s affected paths. Preserve it externally before continuing.`;
  const busy =
    frozen || draft.phase.kind !== "editing" || writes.running !== null;
  const problem = draft.phase.kind === "editing" ? draft.phase.problem : null;
  const valid = conflictTextSchema.safeParse(draft.text).success;
  const canSave =
    !busy && allowed && read.kind !== "loading" && dirty && !stale && valid;
  const block =
    markBlock(draft) ??
    (busy ? "busy" : read.kind === "loading" ? "reading" : null);
  const markBlocked = notAllowed ?? (block && markReasons[block]);
  const status =
    draft.phase.kind === "saving" || draft.phase.kind === "rereading"
      ? "Saving…"
      : draft.phase.kind === "marking"
        ? "Marking resolved…"
        : dirty
          ? "Unsaved changes"
          : draft.revision > 0
            ? "Saved"
            : null;
  const choosing = mode === "choices";
  const reveal = (ordinal: number) =>
    cards[ordinal]?.host.scrollIntoView?.({ block: "center" });
  const move = (by: 1 | -1) => {
    const next = Math.max(0, Math.min(focused + by, regions - 1));
    setFocus(next);
    reveal(next);
  };
  const choose = (ordinal: number, resolution: MergeConflictResolution) => {
    const card = cards[ordinal];
    if (busy || !card) return;
    setFocus(ordinal);
    resolver.current?.focus({ preventScroll: true });
    choicesRef.current?.choose(card.index, resolution);
  };
  const edit = (ordinal: number) => {
    if (busy) return;
    setEditAt(cards[ordinal]?.startLineIndex ?? null);
    setMode("edit");
  };
  const run = (command: Command) => {
    if (command.kind === "move") move(command.by);
    else if (command.kind === "edit") edit(focused);
    else choose(focused, command.resolution);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const command = shortcuts[event.key];
    const target = event.nativeEvent.composedPath()[0];
    if (
      !command ||
      !choosing ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !(target instanceof HTMLElement) ||
      !event.currentTarget.contains(event.target as Node) ||
      typingIn(target)
    )
      return;
    event.preventDefault();
    run(command);
  };
  const copy = () =>
    void navigator.clipboard.writeText(draft.text).then(
      () => setCopyProblem(null),
      () =>
        setCopyProblem(
          "Could not copy the result. Select the text in Edit and copy it.",
        ),
    );
  const anchor = menu?.getBoundingClientRect();
  const menuItems: {
    label: string;
    icon: typeof Copy;
    disabled: boolean;
    run: () => void;
    separated?: true;
  }[] = [
    { label: "Copy result", icon: Copy, disabled: false, run: copy },
    {
      label: "Reload from disk…",
      icon: HardDriveDownload,
      disabled: busy,
      run: () => setDiscardRevision(draft.revision),
    },
    {
      label: "Refresh conflict",
      icon: RefreshCw,
      disabled: busy,
      run: () => setRetry((value) => value + 1),
      separated: true,
    },
  ];
  return (
    <EditProvider createEditor={createEditor}>
      <div
        ref={resolver}
        className="conflict-resolver"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {header(
          <>
            <span
              className="conflict-counter"
              role="status"
              data-done={(regions === 0 && !leftover) || undefined}
            >
              {leftover
                ? "Leftover markers"
                : regions === 0
                  ? "No conflicts left"
                  : choosing
                    ? `Conflict ${focused + 1} of ${regions}`
                    : `${regions} ${regions === 1 ? "conflict" : "conflicts"} left`}
            </span>
            <div className="conflict-actions">
              <button
                className="button ghost"
                disabled={!choosing || focused === 0 || regions === 0}
                aria-keyshortcuts="K"
                title="Previous conflict (K)"
                onClick={() => move(-1)}
              >
                <ChevronUp size={14} aria-hidden="true" />
                <span className="conflict-step-label">Previous</span>
              </button>
              <button
                className="button ghost"
                disabled={!choosing || focused >= regions - 1}
                aria-keyshortcuts="J"
                title="Next conflict (J)"
                onClick={() => move(1)}
              >
                <ChevronDown size={14} aria-hidden="true" />
                <span className="conflict-step-label">Next</span>
              </button>
              {status && (
                <span
                  className="conflict-save-status"
                  data-dirty={dirty || undefined}
                  title={status}
                >
                  <span className="conflict-save-text">{status}</span>
                </span>
              )}
              <span className="conflict-divider" aria-hidden="true" />
              <button
                className="button secondary"
                disabled={markBlocked !== null}
                title={markBlocked ?? "Stage the saved result"}
                onClick={() =>
                  void markResolution(key, writes.write).then((marked) => {
                    if (marked) onResolved();
                  })
                }
              >
                Mark resolved
              </button>
              <button
                className={`button ${dirty ? "primary" : "secondary"}`}
                disabled={!canSave}
                title="Write the result to the file"
                onClick={() => void saveResolution(key, writes.write)}
              >
                Save result
              </button>
              <button
                className="icon-button conflict-more"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                onClick={(event) => setMenu(event.currentTarget)}
              >
                <Ellipsis size={16} aria-hidden="true" />
              </button>
            </div>
          </>,
        )}
        <div className="conflict-hint">
          <span className="conflict-legend" aria-hidden="true">
            <kbd className="keycap">J</kbd>
            <kbd className="keycap">K</kbd>
            Next and previous conflict
          </span>
          <span className="conflict-hint-space" />
          <span>Save result writes the file. Mark resolved stages it.</span>
          <div className="diff-style" role="group" aria-label="Result mode">
            <button
              aria-pressed={choosing}
              disabled={busy}
              onClick={() => setMode("choices")}
            >
              Choices
            </button>
            <button
              aria-pressed={!choosing}
              disabled={busy}
              onClick={() => {
                setEditAt(null);
                setMode("edit");
              }}
            >
              Edit
            </button>
          </div>
        </div>
        <div className="conflict-body">
          {mergeRead.kind === "ready" &&
            mergeRead.value.kind === "replay" &&
            mergeRead.value.progress.kind === "revert" && (
              <p className="conflict-help">
                In a revert, Incoming holds the reverse of the commit. Base is
                that commit and Incoming is its parent.
              </p>
            )}
          {notAllowed && (
            <p className="conflict-help" role="status">
              {notAllowed}
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
          {copyProblem && (
            <div className="notice error-notice" role="alert">
              {copyProblem}
            </div>
          )}
          <div
            className="conflict-code"
            inert={
              frozen || draft.phase.kind === "marking" || (choosing && busy)
            }
          >
            {choosing && file ? (
              <ConflictChoices
                ref={choicesRef}
                file={file}
                options={choiceOptions}
                onCards={setCards}
                onChoose={(contents) => {
                  if (epoch !== undefined)
                    chooseResolution(key, epoch, contents);
                }}
              />
            ) : (
              <ResultEditor
                key={draft.editorEpoch}
                draftKey={key}
                draft={draft}
                options={options}
                line={editAt}
              />
            )}
          </div>
          <details className="conflict-source">
            <summary>Git index versions</summary>
            <div className="conflict-source-toolbar">
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
            <File
              file={{ name: path, contents: draft.snapshot[source] }}
              options={options}
            />
          </details>
        </div>
        {choosing &&
          cards.map((card, ordinal) =>
            createPortal(
              <ConflictCardBar
                ordinal={ordinal}
                total={regions}
                focused={ordinal === focused}
                sides={sides}
                disabled={busy}
                onFocus={() => setFocus(ordinal)}
                onChoose={(resolution) => choose(ordinal, resolution)}
                onEdit={() => edit(ordinal)}
              />,
              card.host,
              `${card.index}`,
            ),
          )}
        {menu && anchor && (
          <ContextMenu
            className="conflict-menu"
            x={anchor.right - 200}
            y={anchor.bottom + 6}
            label="More actions"
            onClose={({ returnFocus }) => {
              setMenu(null);
              if (returnFocus) menu.focus();
            }}
          >
            {menuItems.map(
              ({ label, icon: Icon, disabled, run, separated }) => [
                separated && (
                  <div
                    key={`${label} separator`}
                    className="menu-separator"
                    role="separator"
                  />
                ),
                <button
                  key={label}
                  role="menuitem"
                  aria-disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    setMenu(null);
                    menu.focus();
                    run();
                  }}
                >
                  <Icon size={14} aria-hidden="true" />
                  {label}
                </button>,
              ],
            )}
          </ContextMenu>
        )}
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

function ConflictCardBar({
  ordinal,
  total,
  focused,
  sides,
  disabled,
  onFocus,
  onChoose,
  onEdit,
}: {
  ordinal: number;
  total: number;
  focused: boolean;
  sides: Sides;
  disabled: boolean;
  onFocus: () => void;
  onChoose: (resolution: MergeConflictResolution) => void;
  onEdit: () => void;
}) {
  const named = (resolution: MergeConflictResolution) =>
    resolution === "both"
      ? "both sides"
      : (sides?.[resolution] ??
        (resolution === "current" ? "Current" : "Incoming"));
  return (
    <div
      className="conflict-card"
      role="group"
      aria-label={`Conflict ${ordinal + 1} of ${total}`}
      data-focused={focused || undefined}
      onFocus={onFocus}
    >
      <span className="conflict-card-dot" aria-hidden="true" />
      <strong className="conflict-card-title">
        Conflict {ordinal + 1} of {total}
      </strong>
      <SideChip side="current">{sides?.current ?? "Current"}</SideChip>
      <SideChip side="incoming">{sides?.incoming ?? "Incoming"}</SideChip>
      <div className="conflict-card-actions">
        <span className="conflict-card-keep">Keep</span>
        {choices.map(({ resolution, label, key }) => (
          <button
            key={resolution}
            className="button secondary"
            disabled={disabled}
            aria-keyshortcuts={key}
            title={`Keep ${named(resolution)} (${key})`}
            onClick={() => onChoose(resolution)}
          >
            {label}
            <kbd className="keycap" aria-hidden="true">
              {key}
            </kbd>
          </button>
        ))}
        <span className="conflict-divider" aria-hidden="true" />
        <button
          className="button ghost"
          disabled={disabled}
          aria-keyshortcuts="E"
          title="Edit the result at this conflict (E)"
          onClick={onEdit}
        >
          Edit result
          <kbd className="keycap" aria-hidden="true">
            E
          </kbd>
        </button>
      </div>
    </div>
  );
}

function ResultEditor({
  draftKey,
  draft,
  options,
  line,
}: {
  draftKey: string;
  draft: ResolutionDraft;
  options: ReturnType<typeof editorOptions>;
  line: number | null;
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
      editorOptions={{
        onAttach: (editor) => {
          attachEditor(draftKey, epoch, session);
          if (line === null) return;
          const at = { line, character: 0 };
          editor.setSelections([{ start: at, end: at, direction: "none" }]);
          editor.focus();
        },
      }}
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
function markerLabels(sides: Sides) {
  const label = (side: string, ref: string | undefined) =>
    JSON.stringify(ref === undefined ? side : `${side} · ${ref}`);
  return `[data-merge-conflict=marker-start]:after{content:${label("Current", sides?.current)}}[data-merge-conflict=marker-end]:after{content:${label("Incoming", sides?.incoming)}}`;
}

export function RetainedResolution({
  onClose,
  ...props
}: Omit<Props, "leading"> & { onClose: () => void }) {
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
      <ConflictResolver
        {...props}
        leading={
          <button className="button ghost" onClick={onClose}>
            Close
          </button>
        }
      />
    </dialog>
  );
}
