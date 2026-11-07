import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { flushSync } from "react-dom";
import { LoaderCircle } from "lucide-react";
import {
  baseFromHome,
  DEFAULT_BASE,
  descendInto,
  filterSources,
  headerValue,
  HOME_BASE,
  namesTarget,
  shownHints,
  SOURCES_HINTS,
  STEP_TEXT,
  targetLocation,
  withHeaderValue,
} from "../domain/addRepository";
import type {
  DirectoryEntry,
  SourceKind,
  SourceStep,
  Step,
} from "../domain/addRepository";
import { problemFrom } from "../domain/repository";
import type { Problem } from "../domain/repository";
import { latestReader } from "../latestReader";
import { WorkspaceIcon } from "./WorkspaceIcon";
import {
  cloneRepository,
  createRepository,
  listDirectories,
} from "../repositories";

type Props = {
  onAdd: (path: string, signal: AbortSignal) => Promise<Problem | null>;
  /** The repository opened. */
  onAdded: () => void;
  onClose: () => void;
};

const SOURCE_ICONS: Record<SourceKind, ReactNode> = {
  new: <WorkspaceIcon name="AddNew" />,
  url: <WorkspaceIcon name="AddLink" />,
  local: <WorkspaceIcon name="AddFolder" />,
};

/** A modal's Tab order runs through the page's end, where no key reaches the palette. */
function wrapTab(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const controls = event.currentTarget.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled)",
  );
  const [first, last] = [controls[0], controls[controls.length - 1]];
  const [edge, next] = event.shiftKey ? [first, last] : [last, first];
  if (event.target === edge && next) {
    event.preventDefault();
    next.focus();
  }
}

export function AddRepositoryPalette({ onAdd, onAdded, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const [step, setStep] = useState<Step>({ kind: "sources", query: "" });
  const [base, setBase] = useState(DEFAULT_BASE);
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    dialog.current?.showModal();
    listDirectories(HOME_BASE).then(
      ({ entries }) => {
        if (controller.signal.aborted) return;
        const found = baseFromHome(entries);
        setBase(found);
        setStep((current) =>
          current.kind === "local" && current.path === DEFAULT_BASE
            ? { ...current, path: found }
            : current,
        );
      },
      () => {},
    );
    return () => controller.abort();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="add-palette"
      aria-label="Add repository"
      onKeyDown={wrapTab}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedBackdrop.current)
          onClose();
      }}
    >
      {step.kind === "sources" ? (
        <SourcesStep
          query={step.query}
          onQuery={(query) => setStep({ kind: "sources", query })}
          onOpen={(source) => setStep(source)}
          base={base}
        />
      ) : (
        <SubStep
          step={step}
          base={base}
          operation={operation}
          onStep={setStep}
          onBack={() => setStep({ kind: "sources", query: "" })}
          onAdd={onAdd}
          onAdded={onAdded}
        />
      )}
    </dialog>
  );
}

function SourcesStep({
  query,
  onQuery,
  onOpen,
  base,
}: {
  query: string;
  onQuery: (query: string) => void;
  onOpen: (step: SourceStep) => void;
  base: string;
}) {
  const [activeKind, setActiveKind] = useState<SourceKind | null>(null);
  const results = filterSources(query);
  const found = results.findIndex((source) => source.kind === activeKind);
  const current = found >= 0 ? found : results.length > 0 ? 0 : -1;
  const move = (by: number) => {
    const next = results[(current + by + results.length) % results.length];
    if (next) setActiveKind(next.kind);
  };
  return (
    <>
      <div className="add-palette-header add-palette-search">
        <WorkspaceIcon name="AddSearch" />
        <input
          autoFocus
          role="combobox"
          aria-label="Search sources"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? "add-palette-sources" : undefined}
          aria-activedescendant={
            current >= 0 ? `add-palette-source-${current}` : undefined
          }
          placeholder="Search sources…"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
            setActiveKind(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const source = results[current];
              if (source) onOpen(source.start(base));
            }
          }}
        />
      </div>
      {results.length === 0 ? (
        <p className="add-palette-empty" role="status">
          Nothing matches “{query.trim()}”.
        </p>
      ) : (
        <div className="add-palette-body">
          <div className="add-palette-label">Sources</div>
          <ul
            id="add-palette-sources"
            className="add-palette-options"
            role="listbox"
            aria-label="Sources"
          >
            {results.map((source, index) => (
              <li
                key={source.kind}
                id={`add-palette-source-${index}`}
                className="add-palette-source"
                role="option"
                aria-selected={index === current}
                onMouseMove={() => {
                  if (index !== current) setActiveKind(source.kind);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onOpen(source.start(base))}
              >
                {SOURCE_ICONS[source.kind]}
                <span className="add-palette-source-text">
                  <span className="add-palette-source-title">
                    {source.title}
                  </span>
                  <span className="add-palette-source-detail">
                    {source.detail}
                  </span>
                </span>
                <WorkspaceIcon name="AddChevron" />
              </li>
            ))}
          </ul>
        </div>
      )}
      <Hints
        hints={shownHints(SOURCES_HINTS, {
          query,
          canSubmit: results.length > 0,
        })}
      />
    </>
  );
}

type Listing = {
  path: string;
  entries: readonly DirectoryEntry[];
  problem: string | null;
};

function useListing(path: string | null): Listing | null {
  const [listing, setListing] = useState<Listing | null>(null);
  const [reader] = useState(() =>
    latestReader<string, { entries: DirectoryEntry[] }>({
      read: listDirectories,
      deliver: (key, outcome) =>
        setListing(
          outcome.ok
            ? { path: key, entries: outcome.value.entries, problem: null }
            : {
                path: key,
                entries: [],
                problem: problemFrom(outcome.error).message,
              },
        ),
      same: (left, right) => left === right,
      stallMs: 1000,
      maxReads: 2,
    }),
  );
  useEffect(() => {
    reader.want(path);
    return () => reader.want(null);
  }, [reader, path]);
  return listing;
}

function SubStep({
  step,
  base,
  operation,
  onStep,
  onBack,
  onAdd,
  onAdded,
}: {
  step: SourceStep;
  base: string;
  operation: RefObject<AbortController | null>;
  onStep: (step: SourceStep) => void;
  onBack: () => void;
  onAdd: Props["onAdd"];
  onAdded: () => void;
}) {
  const header = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const typedPath = step.kind === "local" ? step.path.trim() : "";
  const listing = useListing(typedPath === "" ? null : typedPath);
  const entries = typedPath === "" ? [] : (listing?.entries ?? []);
  const found = entries.findIndex((entry) => entry.path === activePath);
  const current = found >= 0 ? found : entries.length > 0 ? 0 : -1;
  const highlighted = entries[current];
  // A listing for an older path may still show, but it is not what Add would add.
  const fresh = listing?.path === typedPath;
  const addable = fresh && highlighted?.repository === true;
  const canSubmit =
    !busy && (step.kind === "local" ? addable : namesTarget(step, base));
  const text = STEP_TEXT[step.kind];

  useLayoutEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [current, listing]);

  // A browser drops focus from a disabled button to the body, where no key reaches this form.
  useLayoutEffect(() => {
    if (!canSubmit && !busy && document.activeElement === primary.current)
      header.current?.focus();
  }, [canSubmit, busy]);

  const edit = (next: SourceStep) => {
    setProblem(null);
    onStep(next);
  };

  async function open(prepare: (signal: AbortSignal) => Promise<string>) {
    const signal = operation.current?.signal;
    if (signal === undefined || busy) return;
    const fail = (message: string) => {
      flushSync(() => {
        setBusy(false);
        setProblem(message);
      });
      header.current?.focus();
    };
    setBusy(true);
    setProblem(null);
    try {
      const path = await prepare(signal);
      if (signal.aborted) return;
      const refused = await onAdd(path, signal);
      if (signal.aborted) return;
      if (refused === null) onAdded();
      else fail(refused.message);
    } catch (error) {
      if (!signal.aborted) fail(problemFrom(error).message);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const target = targetLocation(step, base);
    if (step.kind === "new")
      void open(async () => (await createRepository(target)).path);
    else if (step.kind === "url")
      void open(
        async (signal) =>
          (await cloneRepository(step.url.trim(), target, signal)).path,
      );
    else if (highlighted) void open(async () => highlighted.path);
  }

  function localKey(event: KeyboardEvent<HTMLFormElement>) {
    if (step.kind !== "local" || busy || event.nativeEvent.isComposing) return;
    const input =
      event.target instanceof HTMLInputElement ? event.target : null;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const by = event.key === "ArrowDown" ? 1 : -1;
      const next = entries[(current + by + entries.length) % entries.length];
      if (next) setActivePath(next.path);
    } else if (event.key === "ArrowRight") {
      const atEnd =
        input !== null &&
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length;
      if (atEnd && fresh && highlighted) {
        event.preventDefault();
        edit({ ...step, path: descendInto(step.path, highlighted) });
      }
    } else if (
      event.key === "Backspace" &&
      (input === null || input.value === "")
    ) {
      event.preventDefault();
      onBack();
    }
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      onKeyDown={localKey}
      aria-busy={busy || undefined}
    >
      <div
        className={`add-palette-header add-palette-step-header ${step.kind === "local" ? "local" : ""}`}
      >
        <button
          type="button"
          className="add-palette-back"
          aria-label="Back"
          disabled={busy}
          onClick={onBack}
        >
          <WorkspaceIcon name="AddBack" />
        </button>
        <input
          ref={header}
          autoFocus
          className={text.mono ? "mono" : undefined}
          aria-label={text.input}
          placeholder={text.placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          disabled={busy}
          value={headerValue(step)}
          onChange={(event) => edit(withHeaderValue(step, event.target.value))}
          {...(step.kind === "local" && {
            role: "combobox",
            "aria-expanded": entries.length > 0,
            "aria-controls":
              entries.length > 0 ? "add-palette-directories" : undefined,
            "aria-activedescendant":
              current >= 0 ? `add-palette-directory-${current}` : undefined,
          })}
        />
        <button
          ref={primary}
          type="submit"
          className="add-palette-primary"
          aria-label={busy ? text.busy : text.submit}
          disabled={!canSubmit}
        >
          {busy ? (
            <>
              <LoaderCircle size={13} className="spin" />
              {text.busy}
            </>
          ) : (
            <>
              {text.submit}
              <kbd aria-hidden="true">↵</kbd>
            </>
          )}
        </button>
      </div>
      <div className="add-palette-body">
        {step.kind === "local" ? (
          <>
            <div className="add-palette-label">{text.section}</div>
            {entries.length > 0 ? (
              <ul
                ref={list}
                id="add-palette-directories"
                className="add-palette-options add-palette-directories"
                role="listbox"
                aria-label={text.section}
              >
                {entries.map((entry, index) => (
                  <li
                    key={entry.path}
                    id={`add-palette-directory-${index}`}
                    className="add-palette-directory"
                    role="option"
                    aria-selected={index === current}
                    title={entry.path}
                    onMouseMove={() => {
                      if (index !== current && !busy) setActivePath(entry.path);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setActivePath(entry.path)}
                    onDoubleClick={() => {
                      if (busy || !fresh) return;
                      if (entry.repository) void open(async () => entry.path);
                      else
                        edit({
                          ...step,
                          path: descendInto(step.path, entry),
                        });
                    }}
                  >
                    <WorkspaceIcon
                      name={index === current ? "AddFolder" : "AddDirectory"}
                    />
                    <span className="add-palette-directory-name">
                      {entry.name}
                    </span>
                    <span
                      className={
                        entry.repository
                          ? "add-palette-directory-kind repository"
                          : "add-palette-directory-kind"
                      }
                    >
                      {entry.repository
                        ? "Git repository"
                        : "No Git repository"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              listing?.path === typedPath &&
              listing.problem === null && (
                <p className="add-palette-none" role="status">
                  No directories here.
                </p>
              )
            )}
            {listing?.path === typedPath && listing.problem !== null && (
              <div className="error-message" role="alert">
                {listing.problem}
              </div>
            )}
          </>
        ) : (
          <>
            <label className="add-palette-label" htmlFor="add-palette-location">
              {text.section}
            </label>
            <div className="add-palette-location">
              <WorkspaceIcon name="AddDirectory" />
              <input
                id="add-palette-location"
                className="mono"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
                value={step.location ?? targetLocation(step, base)}
                onChange={(event) =>
                  edit({ ...step, location: event.target.value })
                }
              />
            </div>
          </>
        )}
        {problem !== null && (
          <div className="error-message" role="alert">
            {problem}
          </div>
        )}
      </div>
      <Hints hints={shownHints(text.hints, { query: "", canSubmit })} />
    </form>
  );
}

function Hints({ hints }: { hints: ReturnType<typeof shownHints> }) {
  return (
    <div className="add-palette-footer">
      {hints.map(({ keys, label, disabled }) => (
        <span
          key={label}
          className={
            disabled ? "add-palette-hint disabled" : "add-palette-hint"
          }
        >
          <kbd data-keys={keys}>{keys}</kbd>
          {label}
        </span>
      ))}
    </div>
  );
}
