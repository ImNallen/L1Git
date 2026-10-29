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

type Props = {
  root: RepositoryRoot;
  onPublish: (intent: PushIntent) => void;
  onClose: () => void;
};

export function PublishDialog({ root, onPublish, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const remoteInput = useRef<HTMLSelectElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [options, setOptions] = useState<Options>({ kind: "loading" });
  const [remote, setRemote] = useState("");
  const [destination, setDestination] = useState("");
  const [review, dispatch] = useReducer(publishReview, initialPublishReview);
  useEffect(() => {
    dialog.current?.showModal();
    let current = true;
    repositories.publishOptions(root).then(
      (loaded) => {
        if (!current) return;
        setOptions({ kind: "loaded", options: loaded });
        if (loaded.kind === "available") {
          const defaults = publishDefaults(loaded);
          setDestination(defaults.destination);
          setRemote(defaults.remote);
        }
        requestAnimationFrame(() => remoteInput.current?.focus());
      },
      (error: unknown) =>
        current &&
        setOptions({ kind: "failed", message: problemFrom(error).message }),
    );
    return () => {
      current = false;
    };
  }, [root]);
  useEffect(() => {
    if (review.step.kind === "review") reviewHeading.current?.focus();
  }, [review.step.kind]);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const available =
    options.kind === "loaded" && options.options.kind === "available"
      ? options.options
      : null;
  const canPrepare =
    available !== null &&
    remote !== "" &&
    destination !== "" &&
    review.step.kind !== "preparing";
  async function prepare() {
    if (!canPrepare) return;
    const generation = review.generation;
    dispatch({ kind: "prepare" });
    try {
      const choice = publishChoiceSchema.parse({
        remote,
        destination: `refs/heads/${destination}`,
      });
      const result = await repositories.preparePublish(root, choice);
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
      dispatch({
        kind: "failed",
        generation,
        message: problemFrom(error).message,
      });
    }
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
            aria-label="Close publish branch"
          >
            <X size={17} />
          </button>
        </div>
        <h1 id={titleId}>Publish branch</h1>
        <p>
          Choose an existing remote and destination. Review the commit before
          publishing.
        </p>
        {options.kind === "loading" && <p role="status">Loading remotes…</p>}
        {options.kind === "failed" && (
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
            {available.remotes.length === 0 && (
              <p role="status">
                No remotes configured. Add a remote with Git, then reopen
                Publish branch.
              </p>
            )}
            <label htmlFor={`${titleId}-remote`}>Remote</label>
            <select
              id={`${titleId}-remote`}
              ref={remoteInput}
              value={remote}
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
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
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
