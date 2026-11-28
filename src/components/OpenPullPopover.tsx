import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  GitCommitHorizontal,
  GitPullRequest,
  GitPullRequestDraft,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { singleCommit } from "../domain/comparison";
import type { OpenPullContext, Opened } from "../domain/host";
import {
  baseChoices,
  between,
  bodyOf,
  onRemote,
  pushed,
  titleOf,
} from "../domain/openPull";
import type { Pushed } from "../domain/openPull";
import type { BranchStatus } from "../domain/overview";
import { counted } from "../domain/pullRequestDetail";
import type { RepositorySnapshot } from "../domain/repository";
import { shortOid } from "../domain/shortOid";
import type { HostClient } from "../host";
import * as repositories from "../repositories";
import type { OpenedPull, OpenPullAsk } from "../shell/useOpenPull";
import { ContextMenu } from "./ContextMenu";
import { useModalDialog } from "./Dialog";
import { SplitButton } from "./SplitButton";

const WIDTH = 480;
/** The space it keeps from the window's edges, and from the row it opens
 * beside. */
const EDGE = 16;
const GAP = 8;
/** How far above its row it starts, so the sentence lines up with it. */
const LIFT = 24;
/** Where it opens with no row to open beside. */
const TOP = 64;
/** Commits it lists before it says how many more. */
const LISTED = 20;

type Mode = "open" | "draft";

const modes = [
  { key: "open", label: "Open pull request", note: "asks for reviews" },
  { key: "draft", label: "Open as draft", note: "asks no one yet" },
] as const;

type Context =
  | { kind: "reading" }
  | { kind: "read"; value: OpenPullContext }
  | { kind: "failed"; message: string };

type Phase =
  | { kind: "form"; note: string | null }
  | { kind: "sending" }
  | { kind: "failed"; message: string }
  /** `cause` is the host's account of the lost answer, and `message` why a
   * check after it failed. */
  | { kind: "unknown"; at: Date; cause: string; message: string | null }
  | { kind: "checking"; at: Date; cause: string };

type Files =
  | { kind: "reading" }
  | { kind: "read"; files: number; added: number; deleted: number }
  | { kind: "unread" };

/** Beside `anchor`, its sentence level with the row, and never past the
 * window's edges. It moves as it grows. */
function useBeside(
  dialog: RefObject<HTMLDialogElement | null>,
  anchor: HTMLElement | null,
) {
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const { innerHeight, innerWidth } = window;
    const box = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const width = Math.min(WIDTH, innerWidth - 2 * EDGE);
    const left = box ? box.right + GAP : (innerWidth - width) / 2;
    const top = box ? box.top - LIFT : TOP;
    element.style.width = `${width}px`;
    element.style.left = `${Math.max(EDGE, Math.min(left, innerWidth - width - EDGE))}px`;
    element.style.top = `${Math.max(EDGE, Math.min(top, innerHeight - element.offsetHeight - EDGE))}px`;
  });
}

/** What keeps the main button from opening, said where it shows. */
function unpushed(state: Pushed, head: string, remote: string) {
  switch (state.kind) {
    case "pushed":
      return null;
    case "missing":
      return `${head} isn't on ${remote} yet. Publish it first, then open the pull request.`;
    case "ahead":
      return `${remote} doesn't have ${counted(state.ahead, "commit")} of ${head} yet. Push first, then open the pull request.`;
    case "behind":
      return `${remote}/${head} has ${counted(state.behind, "commit")} that ${head} doesn't. Pull first, so the pull request shows what you see here.`;
    case "diverged":
      return `${head} and ${remote}/${head} have each moved on. Pull and push first, then open the pull request.`;
    case "unknown":
      return `${remote}/${head} is at another commit than ${head}, and L1 Git can't tell which is ahead from the history it loaded. Make them match in Git, then open the pull request.`;
  }
}

const time = (at: Date) =>
  at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Asks for a pull request's title and description beside its branch, and
 * opens it once. Its commits and files come from this clone, and GitHub is
 * asked first whether one is already open from the branch.
 */
export function OpenPullPopover({
  ask,
  snapshot,
  host,
  statuses,
  onOpened,
  onView,
  onClose,
}: {
  ask: OpenPullAsk;
  snapshot: RepositorySnapshot;
  /** The overview's branches, whose ahead and behind Git counted. */
  statuses: readonly BranchStatus[];
  host: Pick<HostClient, "ask" | "openPull">;
  onOpened: (pull: OpenedPull) => void;
  onView: (number: number) => void;
  onClose: () => void;
}) {
  const id = useId();
  const { root, github, remote, login, head } = ask;
  const { ref, close, onCancel } = useModalDialog(onClose);
  useBeside(ref, ask.anchor);
  const [context, setContext] = useState<Context>({ kind: "reading" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("open");
  const [phase, setPhase] = useState<Phase>({ kind: "form", note: null });
  const [files, setFiles] = useState<Files>({ kind: "reading" });
  const [single, setSingle] = useState<{ oid: string; body: string } | null>(
    null,
  );
  const [baseMenu, setBaseMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const baseButton = useRef<HTMLButtonElement>(null);

  async function read() {
    setContext({ kind: "reading" });
    const answer = await host.ask({
      op: "openPullContext",
      repository: github,
      head: head.name,
    });
    setContext(
      answer.ok
        ? { kind: "read", value: answer.reply.data }
        : { kind: "failed", message: answer.problem.message },
    );
  }
  // Once on open, and again only when asked.
  const readOnOpen = useEffectEvent(() => void read());
  useEffect(() => readOnOpen(), []);

  const value = context.kind === "read" ? context.value : null;
  const choices = baseChoices(snapshot, remote, head.name);
  const base =
    chosen ??
    value?.open[0]?.base ??
    (value?.defaultBranch && value.defaultBranch !== head.name
      ? value.defaultBranch
      : (choices[0] ?? null));
  const baseOid = base === null ? null : onRemote(snapshot, remote, base);
  const range =
    baseOid === null ? null : between(snapshot.commits, baseOid, head.oid);
  const commits = range?.commits ?? [];
  const already = value?.open.find((pull) => pull.base === base) ?? null;
  const state = head.local
    ? pushed(snapshot, remote, head, statuses)
    : { kind: "pushed" as const };

  useEffect(() => {
    if (baseOid === null) return;
    let current = true;
    setFiles({ kind: "reading" });
    repositories.rangeFiles(root, baseOid, head.oid).then(
      (read) => {
        if (!current) return;
        if (read.kind !== "ready") return setFiles({ kind: "unread" });
        setFiles({
          kind: "read",
          files: read.files.length,
          added: read.files.reduce((sum, file) => sum + (file.added ?? 0), 0),
          deleted: read.files.reduce(
            (sum, file) => sum + (file.deleted ?? 0),
            0,
          ),
        });
      },
      () => {
        if (current) setFiles({ kind: "unread" });
      },
    );
    return () => {
      current = false;
    };
  }, [root, baseOid, head.oid]);

  const only = commits.length === 1 ? commits[0]!.oid : null;
  useEffect(() => {
    if (only === null) return;
    let current = true;
    repositories.commitDetail(root, singleCommit(only)).then(
      (detail) => {
        if (current && detail.target.kind === "commit")
          setSingle({ oid: only, body: bodyOf(detail.target.message) });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [root, only]);

  const shownTitle = title ?? titleOf(commits);
  const shownBody = body ?? (single?.oid === only ? single.body : "");
  const missingBase =
    base !== null && baseOid === null
      ? `L1 Git can't find ${remote}/${base} in this clone. Fetch, then try again.`
      : null;
  const empty =
    range !== null && range.complete && commits.length === 0
      ? `${head.name} has no commits that ${base} doesn't have.`
      : null;
  const blocked =
    base === null
      ? `${remote} has no branch to merge ${head.name} into.`
      : (missingBase ?? unpushed(state, head.name, remote) ?? empty);
  const sending = phase.kind === "sending";
  const unsure = phase.kind === "unknown" || phase.kind === "checking";
  const locked = sending || unsure;
  const ready = value !== null && already === null;

  async function confirm() {
    if (!ready || locked || blocked !== null || value === null || base === null)
      return;
    if (shownTitle.trim() === "") {
      setPhase({ kind: "failed", message: "A pull request needs a title." });
      return;
    }
    setPhase({ kind: "sending" });
    const opened = await host.openPull({
      asLogin: login,
      repository: github,
      open: {
        repositoryId: value.repositoryId,
        base,
        head: head.name,
        title: shownTitle,
        body: shownBody,
        draft: mode === "draft",
      },
    });
    settle(opened, base);
  }

  function settle(opened: Opened, into: string) {
    switch (opened.kind) {
      case "done":
        ref.current?.close();
        return onOpened({
          root,
          github,
          number: opened.number,
          head: head.name,
          base: into,
        });
      case "alreadyOpen":
        setContext({
          kind: "read",
          value: {
            ...value!,
            open: [
              ...value!.open.filter((pull) => pull.base !== into),
              { number: opened.number, base: into },
            ],
          },
        });
        return setPhase({ kind: "form", note: null });
      case "notSent":
      case "refused":
        return setPhase({ kind: "failed", message: opened.message });
      case "unknown":
        return setPhase({
          kind: "unknown",
          at: new Date(),
          cause: opened.message,
          message: null,
        });
    }
  }

  /** The context again: a pull request from the head into the base means
   * the opening landed. */
  async function check() {
    if (phase.kind !== "unknown" || base === null) return;
    const { at, cause } = phase;
    setPhase({ kind: "checking", at, cause });
    const answer = await host.ask({
      op: "openPullContext",
      repository: github,
      head: head.name,
    });
    if (!answer.ok)
      return setPhase({
        kind: "unknown",
        at,
        cause,
        message: answer.problem.message,
      });
    const landed = answer.reply.data.open.find((pull) => pull.base === base);
    if (landed) {
      ref.current?.close();
      return onOpened({
        root,
        github,
        number: landed.number,
        head: head.name,
        base,
      });
    }
    setContext({ kind: "read", value: answer.reply.data });
    setPhase({
      kind: "form",
      note: `GitHub has no pull request from ${head.name} into ${base}, so you can open it again.`,
    });
  }

  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void confirm();
    }
  };

  const openBaseMenu = () => {
    const rect = baseButton.current?.getBoundingClientRect();
    if (rect) setBaseMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  let main: ReactNode;
  if (context.kind === "reading")
    main = (
      <p className="open-pull-status" role="status">
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
        Looking for pull requests from {head.name} on GitHub…
      </p>
    );
  else if (context.kind === "failed")
    main = (
      <div className="open-pull-callout bad" role="alert">
        <CircleAlert size={16} aria-hidden="true" />
        <p>{context.message}</p>
      </div>
    );
  else if (already)
    main = (
      <div className="open-pull-callout" role="status">
        <GitPullRequest size={16} aria-hidden="true" />
        <p>
          {head.name} already has pull request #{already.number} open into{" "}
          {already.base}.
        </p>
      </div>
    );
  else
    main = (
      <>
        {blocked && (
          <div className="open-pull-callout" role="status">
            <CircleAlert size={16} aria-hidden="true" />
            <p>{blocked}</p>
          </div>
        )}
        <fieldset
          className={`open-pull-form${unsure ? " dimmed" : ""}`}
          disabled={locked}
        >
          <legend className="visually-hidden">Pull request</legend>
          <section className="merge-message">
            <label htmlFor={`${id}-title`}>Title</label>
            <input
              id={`${id}-title`}
              value={shownTitle}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setTitle(event.target.value);
                if (phase.kind === "failed")
                  setPhase({ kind: "form", note: null });
              }}
            />
            <div className="open-pull-label">
              <label htmlFor={`${id}-body`}>Description</label>
              <span>Markdown</span>
            </div>
            <textarea
              id={`${id}-body`}
              value={shownBody}
              rows={4}
              placeholder="Why this change, and where a reviewer should start."
              onChange={(event) => setBody(event.target.value)}
            />
          </section>
          {range && (
            <section className="open-pull-commits" aria-label="Commits">
              <div className="open-pull-commits-head">
                <span>
                  <strong>
                    {range.complete ? "" : "At least "}
                    {counted(commits.length, "commit")}
                  </strong>
                  {files.kind === "read" && (
                    <> · {counted(files.files, "file")} changed</>
                  )}
                </span>
                {files.kind === "read" && (
                  <span className="open-pull-lines">
                    <span className="added">
                      +{files.added.toLocaleString()}
                    </span>{" "}
                    <span className="deleted">
                      −{files.deleted.toLocaleString()}
                    </span>
                  </span>
                )}
              </div>
              <ul>
                {commits.slice(0, LISTED).map((commit) => (
                  <li key={commit.oid}>
                    <GitCommitHorizontal size={14} aria-hidden="true" />
                    <code>{shortOid(commit.oid)}</code>
                    <span>{commit.subject}</span>
                  </li>
                ))}
                {commits.length > LISTED && (
                  <li className="more">
                    and {(commits.length - LISTED).toLocaleString()} more
                  </li>
                )}
              </ul>
            </section>
          )}
        </fieldset>
      </>
    );

  const said: ReactNode =
    phase.kind === "failed" ? (
      <p className="error-message" role="alert">
        {phase.message}
      </p>
    ) : phase.kind === "form" && phase.note ? (
      <p className="open-pull-note" role="status">
        {phase.note}
      </p>
    ) : unsure ? (
      <div className="open-pull-callout unknown" role="alert">
        <TriangleAlert size={16} aria-hidden="true" />
        <p>
          {phase.cause}
          {phase.kind === "unknown" && phase.message && ` ${phase.message}`}
        </p>
      </div>
    ) : null;

  let footer: ReactNode;
  if (context.kind === "failed")
    footer = (
      <>
        <span />
        <button type="button" className="button ghost" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => void read()}
        >
          Try again
        </button>
      </>
    );
  else if (already)
    footer = (
      <>
        <span />
        <button type="button" className="button ghost" onClick={close}>
          Close
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            ref.current?.close();
            onView(already.number);
          }}
        >
          View pull request
        </button>
      </>
    );
  else if (unsure)
    footer = (
      <>
        <span>Sent {time(phase.at)}, no answer.</span>
        <button
          type="button"
          className="button ghost"
          aria-disabled={phase.kind === "checking"}
          onClick={() => {
            if (phase.kind !== "checking") close();
          }}
        >
          Close
        </button>
        <button
          type="button"
          className="button primary"
          aria-disabled={phase.kind === "checking"}
          onClick={() => void check()}
        >
          {phase.kind === "checking" && (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          )}
          Check GitHub
        </button>
      </>
    );
  else
    footer = (
      <>
        <span>Opening has no Undo.</span>
        <button
          type="button"
          className="button ghost"
          aria-disabled={sending}
          onClick={() => {
            if (!sending) close();
          }}
        >
          Cancel
        </button>
        <SplitButton
          label={modes.find((each) => each.key === mode)!.label}
          tone="primary"
          choices={modes.map((each) => ({ ...each, off: false }))}
          chosen={mode}
          menuLabel="How to open"
          chooseLabel="Choose how to open"
          busy={sending}
          unavailable={!ready || blocked !== null}
          icon={
            sending ? (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            ) : undefined
          }
          container={ref.current}
          onChoose={setMode}
          onRun={() => void confirm()}
        />
      </>
    );

  return (
    <dialog
      ref={ref}
      className="merge-popover open-pull"
      aria-labelledby={`${id}-title-text`}
      aria-busy={sending}
      onKeyDown={keys}
      onCancel={(event) => {
        if (sending || phase.kind === "checking") event.preventDefault();
        else onCancel(event);
      }}
      onClick={(event) => {
        if (
          event.target === event.currentTarget &&
          !sending &&
          phase.kind !== "checking"
        )
          close();
      }}
    >
      <header className="open-pull-header">
        <span className="open-pull-icon" aria-hidden="true">
          {mode === "draft" ? (
            <GitPullRequestDraft size={16} />
          ) : (
            <GitPullRequest size={16} />
          )}
        </span>
        <div>
          <h1 id={`${id}-title-text`}>Open a pull request</h1>
          <p className="open-pull-sentence">
            Merge <code className="open-pull-head">{head.name}</code> into{" "}
            <button
              ref={baseButton}
              type="button"
              className="open-pull-base"
              aria-label={`Base branch, ${base ?? "none"}`}
              aria-haspopup="menu"
              aria-expanded={baseMenu !== null}
              aria-disabled={locked || choices.length === 0 || undefined}
              onClick={() => {
                if (!locked && choices.length > 0) openBaseMenu();
              }}
            >
              <code>{base ?? "…"}</code>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          </p>
        </div>
      </header>
      {main}
      {said}
      <footer>{footer}</footer>
      {baseMenu && (
        <ContextMenu
          className="open-pull-bases"
          x={baseMenu.x}
          y={baseMenu.y}
          label="Base branch"
          container={ref.current}
          onClose={({ returnFocus }) => {
            setBaseMenu(null);
            if (returnFocus) baseButton.current?.focus();
          }}
        >
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={choice === base}
              onClick={() => {
                setBaseMenu(null);
                baseButton.current?.focus();
                setChosen(choice);
                setPhase({ kind: "form", note: null });
              }}
            >
              <Check
                size={14}
                visibility={choice === base ? "visible" : "hidden"}
                aria-hidden="true"
              />
              <span>{choice}</span>
            </button>
          ))}
        </ContextMenu>
      )}
    </dialog>
  );
}
