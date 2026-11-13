import { useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { FileText, Trash2, TriangleAlert } from "lucide-react";
import { typingIn } from "../actions";
import { pierreThemeOptions } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
import { wholeChoice } from "../domain/wholeFile";
import type { SideNames, WholeCard, WholePreview } from "../domain/wholeFile";
import type { RepositoryRoot, WholeFileConflict } from "../domain/repository";
import type { WritesView } from "../useWrites";
import { SideChip } from "./OperationStrip";

type Props = {
  ref?: Ref<HTMLDivElement>;
  root: RepositoryRoot;
  path: string;
  conflict: WholeFileConflict;
  names: SideNames;
  header: ReactNode;
  help: ReactNode;
  notAllowed: string | null;
  busy: boolean;
  theme: Appearance;
  painted: boolean;
  writes: WritesView;
  onResolved: () => void;
  onRefresh: () => void;
};

export function WholeFileChoice({
  ref,
  root,
  path,
  conflict,
  names,
  header,
  help,
  notAllowed,
  busy,
  theme,
  painted,
  writes,
  onResolved,
  onRefresh,
}: Props) {
  const [choosing, setChoosing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { current, incoming } = names;
  const choice = useMemo(
    () => wholeChoice(conflict, path, { current, incoming }),
    [conflict, path, current, incoming],
  );
  const options = useMemo(
    () => ({
      ...pierreThemeOptions(theme, painted),
      diffStyle: "unified" as const,
      diffIndicators: "classic" as const,
      hunkSeparators: "simple" as const,
      disableFileHeader: true,
      overflow: "wrap" as const,
    }),
    [theme, painted],
  );
  const blocked =
    notAllowed ??
    (busy || choosing ? "Wait for the current operation to finish." : null);
  const choose = async ({ keep, label }: WholeCard) => {
    if (blocked) return;
    setChoosing(true);
    setProblem(null);
    const outcome = await writes.write(root, {
      expect: { head: conflict.head },
      operation: {
        kind: "resolveWhole",
        path,
        version: conflict.version,
        keep,
      },
      label,
    });
    setChoosing(false);
    if (outcome.kind === "applied") onResolved();
    else
      setProblem(
        outcome.kind === "failed"
          ? outcome.problem.message
          : "Another write is running. Try again.",
      );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const card = choice.cards.find(({ key }) => key === event.key);
    const target = event.nativeEvent.composedPath()[0];
    if (
      !card ||
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
    void choose(card);
  };
  return (
    <div
      ref={ref}
      className="conflict-resolver"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {header}
      <div className="conflict-body">
        <div className="whole-choice">
          {help}
          {notAllowed && (
            <p className="conflict-help" role="status">
              {notAllowed}
            </p>
          )}
          {problem && (
            <div
              className="notice error-notice whole-choice-problem"
              role="alert"
            >
              <span>{problem}</span>
              <button className="button secondary" onClick={onRefresh}>
                Refresh conflict
              </button>
            </div>
          )}
          <h2 className="whole-choice-title">{choice.title}</h2>
          <p className="whole-choice-lead">
            {choice.lead.map((part, index) =>
              typeof part === "string" ? (
                part
              ) : (
                <SideChip key={index} side={part.side}>
                  {names[part.side]}
                </SideChip>
              ),
            )}
          </p>
          {choice.editedOnDisk && (
            <p className="whole-choice-warning" role="note">
              <TriangleAlert size={14} aria-hidden="true" />
              The file on disk has edits that match neither side. Choosing
              replaces them. Undo puts them back.
            </p>
          )}
          <div className="whole-choice-cards">
            {choice.cards.map((card) => (
              <ChoiceCard
                key={card.keep}
                card={card}
                options={options}
                blocked={blocked}
                onChoose={() => void choose(card)}
              />
            ))}
          </div>
          <p className="whole-choice-footnote">
            {conflict.shape === "binary" || conflict.shape === "symlink"
              ? ""
              : "Binary files and symlinks get the same choice between the two versions. "}
            To combine the sides by hand, edit and stage the file outside L1
            Git, then use Refresh conflict in the More menu.
          </p>
        </div>
      </div>
    </div>
  );
}

function ChoiceCard({
  card,
  options,
  blocked,
  onChoose,
}: {
  card: WholeCard;
  options: Parameters<typeof FileDiff>[0]["options"];
  blocked: string | null;
  onChoose: () => void;
}) {
  const Icon = card.icon === "delete" ? Trash2 : FileText;
  const titleId = `whole-card-${card.keep}`;
  return (
    <section
      className="whole-card"
      data-side={card.keep}
      aria-labelledby={titleId}
    >
      <header className="whole-card-header">
        <span className="whole-card-icon" aria-hidden="true">
          <Icon size={14} />
        </span>
        <h3 id={titleId}>{card.title}</h3>
        {card.onDisk && (
          <span className="whole-card-disk">Matches what’s on disk</span>
        )}
      </header>
      <p className="whole-card-consequence">{card.consequence}</p>
      <Preview preview={card.preview} options={options} />
      <footer className="whole-card-footer">
        <button
          className="button secondary"
          disabled={blocked !== null}
          aria-keyshortcuts={card.key}
          title={blocked ?? `${card.action} (${card.key})`}
          onClick={onChoose}
        >
          {card.action}
        </button>
        <kbd className="keycap" aria-hidden="true">
          {card.key}
        </kbd>
      </footer>
    </section>
  );
}

function Preview({
  preview,
  options,
}: {
  preview: WholePreview;
  options: Parameters<typeof FileDiff>[0]["options"];
}) {
  switch (preview.kind) {
    case "diff":
      return (
        <Virtualizer className="whole-card-preview">
          <FileDiff fileDiff={preview.diff} options={options} />
        </Virtualizer>
      );
    case "removed":
      return (
        <div className="whole-card-preview" data-kind="removed">
          <span aria-hidden="true">−</span> {preview.text}
        </div>
      );
    case "note":
      return (
        <div className="whole-card-preview" data-kind="note">
          {preview.text}
        </div>
      );
  }
}
