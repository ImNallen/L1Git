import { useEffect, useId, useReducer, useRef, useState } from "react";
import { CloudUpload, LoaderCircle, X } from "lucide-react";
import * as repositories from "../repositories";
import { publishChoiceSchema, pushDisabledReason } from "../domain/push";
import type { PublishOptions, PushIntent } from "../domain/push";
import {
  initialPublishReview,
  publishReview,
  publishDefaults,
} from "../domain/publishReview";
import { problemFrom } from "../domain/repository";
import type { RepositoryRoot } from "../domain/repository";

type Options =
  | { kind: "loading" }
  | { kind: "loaded"; options: PublishOptions }
  | { kind: "failed"; message: string };

type RemoteEditor =
  | { kind: "closed" }
  | { kind: "editing"; name: string; url: string; error: string | null }
  | { kind: "saving"; name: string }
  | { kind: "savedNeedsRefresh"; name: string; message: string };

type Props = {
  root: RepositoryRoot;
  onPublish: (intent: PushIntent) => void;
  onClose: () => void;
  onRemoteAdded: () => void;
};

export function PublishDialog({
  root,
  onPublish,
  onClose,
  onRemoteAdded,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const remoteInput = useRef<HTMLSelectElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const remoteNameInput = useRef<HTMLInputElement>(null);
  const remoteUrlInput = useRef<HTMLInputElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const nextFocus = useRef<"remote" | "review">("remote");
  const lifetime = useRef(0);
  const optionsGeneration = useRef(0);
  const saving = useRef(false);
  const [editor, setEditor] = useState<RemoteEditor>({ kind: "closed" });
  const [options, setOptions] = useState<Options>({ kind: "loading" });
  const [remote, setRemote] = useState("");
  const [destination, setDestination] = useState("");
  const [review, dispatch] = useReducer(publishReview, initialPublishReview);
  useEffect(() => {
    dialog.current?.showModal();
    const current = ++lifetime.current;
    const generation = ++optionsGeneration.current;
    saving.current = false;
    nextFocus.current = "remote";
    setEditor({ kind: "closed" });
    setOptions({ kind: "loading" });
    setRemote("");
    setDestination("");
    dispatch({ kind: "edit" });
    repositories.publishOptions(root).then(
      (loaded) => {
        if (
          lifetime.current !== current ||
          optionsGeneration.current !== generation
        )
          return;
        setOptions({ kind: "loaded", options: loaded });
        if (loaded.kind === "available") {
          const defaults = publishDefaults(loaded);
          setDestination(defaults.destination);
          setRemote(defaults.remote);
        }
      },
      () => {
        if (
          lifetime.current === current &&
          optionsGeneration.current === generation
        )
          setOptions({
            kind: "failed",
            message: "Could not load remotes. Reload and try again.",
          });
      },
    );
    return () => {
      ++lifetime.current;
      ++optionsGeneration.current;
    };
  }, [root]);
  useEffect(() => {
    if (review.step.kind === "review") reviewHeading.current?.focus();
  }, [review.step.kind]);
  useEffect(() => {
    if (editor.kind === "editing") remoteNameInput.current?.focus();
    if (editor.kind === "closed" && options.kind === "loaded") {
      if (nextFocus.current === "review") reviewButton.current?.focus();
      else remoteInput.current?.focus();
    }
  }, [editor.kind, options.kind]);
  const close = () => {
    if (saving.current) return;
    ++lifetime.current;
    ++optionsGeneration.current;
    dialog.current?.close();
    onClose();
  };
  const available =
    options.kind === "loaded" && options.options.kind === "available"
      ? options.options
      : null;
  const canPrepare =
    editor.kind === "closed" &&
    available !== null &&
    available.remotes.some(
      (item) => item.name === remote && item.availability.kind === "eligible",
    ) &&
    destination !== "" &&
    review.step.kind !== "preparing";
  async function prepare() {
    if (!canPrepare) return;
    const current = lifetime.current;
    const generation = review.generation;
    dispatch({ kind: "prepare" });
    try {
      const choice = publishChoiceSchema.parse({
        remote,
        destination: `refs/heads/${destination}`,
      });
      const result = await repositories.preparePublish(root, choice);
      if (lifetime.current !== current) return;
      if (result.kind === "ready" && result.intent.purpose === "publish")
        dispatch({ kind: "prepared", generation, intent: result.intent });
      else
        dispatch({
          kind: "failed",
          generation,
          message:
            pushDisabledReason(result) ??
            "Could not prepare publication. Refresh and try again.",
        });
    } catch (error) {
      if (lifetime.current !== current) return;
      dispatch({
        kind: "failed",
        generation,
        message: problemFrom(error).message,
      });
    }
  }
  function openEditor() {
    nextFocus.current = "review";
    ++optionsGeneration.current;
    dispatch({ kind: "edit" });
    setEditor({ kind: "editing", name: "origin", url: "", error: null });
  }
  async function reloadRemotes() {
    if (saving.current) return;
    const current = lifetime.current;
    const generation = ++optionsGeneration.current;
    const saved = editor.kind === "savedNeedsRefresh" ? editor : null;
    dispatch({ kind: "edit" });
    setOptions({ kind: "loading" });
    try {
      const loaded = await repositories.publishOptions(root);
      if (
        lifetime.current !== current ||
        optionsGeneration.current !== generation
      )
        return;
      setOptions({ kind: "loaded", options: loaded });
      if (saved) {
        setRemote(saved.name);
        setEditor({ kind: "closed" });
      }
      if (loaded.kind === "available") {
        const defaults = publishDefaults(loaded);
        setDestination((value) => value || defaults.destination);
        if (!saved)
          setRemote((value) =>
            loaded.remotes.some((item) => item.name === value)
              ? value
              : defaults.remote,
          );
      }
    } catch {
      if (
        lifetime.current !== current ||
        optionsGeneration.current !== generation
      )
        return;
      setOptions({
        kind: "failed",
        message: "Could not load remotes. Reload and try again.",
      });
    }
  }
  async function addRemote() {
    if (editor.kind !== "editing" || saving.current) return;
    if (!editor.name || !editor.url) {
      setEditor({ ...editor, error: "Enter a remote name and endpoint." });
      return;
    }
    const current = lifetime.current;
    const input = { name: editor.name, url: editor.url };
    ++optionsGeneration.current;
    saving.current = true;
    setEditor({ kind: "saving", name: input.name });
    let report;
    try {
      report = await repositories.addRemote(root, input);
    } catch (error) {
      if (lifetime.current !== current) return;
      saving.current = false;
      const problem = problemFrom(error);
      if (problem.kind === "transport") {
        setEditor({ kind: "closed" });
        setOptions({
          kind: "failed",
          message:
            "Could not confirm whether the remote was added. Reload remotes before trying again.",
        });
      } else {
        setEditor({
          kind: "editing",
          name: input.name,
          url: "",
          error: problem.message,
        });
        requestAnimationFrame(() => {
          if (lifetime.current === current) remoteUrlInput.current?.focus();
        });
      }
      return;
    }
    if (lifetime.current !== current) return;
    saving.current = false;
    setRemote(report.name);
    if (report.refresh.kind === "refreshed") {
      setOptions({ kind: "loaded", options: report.refresh.options });
      if (report.refresh.options.kind === "available") {
        const defaults = publishDefaults(report.refresh.options);
        setDestination((value) => value || defaults.destination);
      }
      setEditor({ kind: "closed" });
    } else {
      setEditor({
        kind: "savedNeedsRefresh",
        name: report.name,
        message: report.refresh.message,
      });
      setOptions({ kind: "failed", message: report.refresh.message });
    }
    onRemoteAdded();
  }
  return (
    <dialog
      ref={dialog}
      className="add-dialog branch-dialog publish-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (editor.kind !== "closed") {
            if (editor.kind === "editing") void addRemote();
            return;
          }
          if (!canPrepare) return;
          if (review.step.kind === "review") {
            onPublish(review.step.intent);
            close();
          } else void prepare();
        }}
      >
        <div className="dialog-title">
          <div className="dialog-icon">
            <CloudUpload size={20} />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            disabled={editor.kind === "saving"}
            aria-label="Close publish branch"
          >
            <X size={17} />
          </button>
        </div>
        <h1 id={titleId}>Publish branch</h1>
        <p>
          Choose a remote and destination. Review the commit before publishing.
        </p>
        {options.kind === "loading" && <p role="status">Loading remotes…</p>}
        {options.kind === "failed" && editor.kind === "closed" && (
          <p role="alert" className="error-message">
            {options.message}
          </p>
        )}
        {options.kind === "loaded" &&
          options.options.kind === "unavailable" && (
            <p role="alert">{pushDisabledReason(options.options)}</p>
          )}
        {available && (
          <>
            {available.remotes.length === 0 && editor.kind === "closed" && (
              <p role="status">
                No remotes configured. Add a remote to continue.
              </p>
            )}
            <label htmlFor={`${titleId}-remote`}>Remote</label>
            <select
              id={`${titleId}-remote`}
              ref={remoteInput}
              value={remote}
              disabled={editor.kind !== "closed"}
              onChange={(event) => {
                setRemote(event.target.value);
                dispatch({ kind: "edit" });
              }}
            >
              <option value="">Choose a remote</option>
              {available.remotes.map((item) => (
                <option
                  key={item.name}
                  value={item.name}
                  disabled={item.availability.kind === "unavailable"}
                >
                  {item.name}
                  {item.availability.kind === "unavailable"
                    ? ` — ${pushDisabledReason(item.availability)}`
                    : ""}
                </option>
              ))}
            </select>
            <label htmlFor={`${titleId}-destination`}>Destination branch</label>
            <input
              id={`${titleId}-destination`}
              className="branch-name-input"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={destination}
              disabled={editor.kind !== "closed"}
              aria-invalid={review.step.kind === "failed"}
              aria-describedby={
                review.step.kind === "failed" ? `${titleId}-error` : undefined
              }
              onChange={(event) => {
                setDestination(event.target.value);
                dispatch({ kind: "edit" });
              }}
            />
            {review.step.kind === "review" && (
              <section aria-label="Publication review">
                <h2 ref={reviewHeading} tabIndex={-1}>
                  Review publication
                </h2>
                <dl className="publish-details">
                  <dt>Source branch</dt>
                  <dd>{review.step.intent.branch}</dd>
                  <dt>Commit</dt>
                  <dd>
                    <code>{review.step.intent.source}</code>
                  </dd>
                  <dt>Remote</dt>
                  <dd>{review.step.intent.remote}</dd>
                  <dt>Destination</dt>
                  <dd>{review.step.intent.destination}</dd>
                  <dt>Push endpoint</dt>
                  <dd>{review.step.intent.endpoint}</dd>
                </dl>
                <p>
                  An existing destination can advance by fast-forward. After Git
                  confirms publication, L1 Git sets this branch's upstream.
                </p>
              </section>
            )}
            {review.step.kind === "failed" && (
              <p id={`${titleId}-error`} role="alert" className="error-message">
                {review.step.message}
              </p>
            )}
          </>
        )}
        {editor.kind === "closed" && (
          <button
            type="button"
            className="button secondary"
            onClick={openEditor}
            disabled={options.kind === "failed"}
          >
            Add remote…
          </button>
        )}
        {(editor.kind === "editing" || editor.kind === "saving") && (
          <fieldset
            className="remote-editor"
            disabled={editor.kind === "saving"}
          >
            <legend>Add remote</legend>
            <p>
              Connect an existing Git endpoint. Adding a remote does not fetch
              or publish.
            </p>
            <label htmlFor={`${titleId}-remote-name`}>Remote name</label>
            <input
              id={`${titleId}-remote-name`}
              ref={remoteNameInput}
              className="branch-name-input"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={editor.name}
              onChange={(event) => {
                if (editor.kind === "editing")
                  setEditor({
                    ...editor,
                    name: event.target.value,
                    error: null,
                  });
              }}
            />
            <label htmlFor={`${titleId}-remote-url`}>
              URL or filesystem path
            </label>
            <input
              id={`${titleId}-remote-url`}
              ref={remoteUrlInput}
              className="branch-name-input"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={editor.kind === "editing" ? editor.url : ""}
              aria-invalid={editor.kind === "editing" && editor.error !== null}
              aria-describedby={`${titleId}-remote-error`}
              onChange={(event) => {
                if (editor.kind === "editing")
                  setEditor({
                    ...editor,
                    url: event.target.value,
                    error: null,
                  });
              }}
            />
            {editor.kind === "editing" && editor.error && (
              <p
                id={`${titleId}-remote-error`}
                role="alert"
                className="error-message"
              >
                {editor.error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={editor.kind === "saving"}
                onClick={() => {
                  setEditor({ kind: "closed" });
                  if (options.kind === "loading") void reloadRemotes();
                }}
              >
                Cancel add remote
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={editor.kind === "saving"}
              >
                {editor.kind === "saving" && (
                  <LoaderCircle size={14} className="spin" />
                )}
                {editor.kind === "saving" ? "Adding remote…" : "Add remote"}
              </button>
            </div>
          </fieldset>
        )}
        {editor.kind === "savedNeedsRefresh" && (
          <p role="status">{editor.message}</p>
        )}
        {(editor.kind === "savedNeedsRefresh" ||
          (editor.kind === "closed" && options.kind === "failed")) && (
          <button
            type="button"
            className="button secondary"
            disabled={options.kind === "loading"}
            onClick={() => void reloadRemotes()}
          >
            {options.kind === "loading" ? "Loading remotes…" : "Reload remotes"}
          </button>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={close}
            disabled={editor.kind === "saving"}
          >
            Cancel
          </button>
          <button
            ref={reviewButton}
            type="submit"
            className="button primary"
            disabled={!canPrepare}
          >
            {review.step.kind === "preparing" && (
              <LoaderCircle size={14} className="spin" />
            )}
            {review.step.kind === "review"
              ? "Publish branch"
              : "Review publication"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
