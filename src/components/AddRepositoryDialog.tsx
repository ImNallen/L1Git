import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { FolderOpen, LoaderCircle, X } from "lucide-react";
import { chooseDirectory, native } from "../repositories";
import { problemFrom } from "../domain/repository";
import type { Problem } from "../domain/repository";

type Props = {
  onAdd: (path: string, signal: AbortSignal) => Promise<Problem | null>;
  onClose: () => void;
};

export function AddRepositoryDialog({ onAdd, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    dialog.current?.showModal();
    return () => {
      controller.abort();
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const controller = operation.current;
    if (!path.trim() || busy || controller === null) return;
    setBusy(true);
    setError(null);
    const problem = await onAdd(path, controller.signal);
    if (controller.signal.aborted) return;
    setBusy(false);
    if (problem) setError(problem.message);
    else onClose();
  }

  async function browse() {
    const controller = operation.current;
    if (controller === null) return;
    setPicking(true);
    try {
      const selected = await chooseDirectory();
      if (selected !== null && !controller.signal.aborted) {
        setPath(selected);
        setError(null);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(problemFrom(error).message);
    } finally {
      if (!controller.signal.aborted) setPicking(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="add-dialog"
      aria-labelledby="add-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-title">
          <div className="dialog-icon">
            <FolderOpen size={21} />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close add repository"
          >
            <X size={17} />
          </button>
        </div>
        <h1 id="add-title">Add a repository</h1>
        <p>
          Open a local Git working copy. Subfolders and linked worktrees are
          welcome.
        </p>
        <label htmlFor="repository-path">Repository path</label>
        <div className="path-input">
          <input
            id="repository-path"
            autoFocus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/Projects/repository"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
          {native && (
            <button
              type="button"
              className="button secondary"
              disabled={busy || picking}
              onClick={() => void browse()}
            >
              {picking ? "Choosing…" : "Browse…"}
            </button>
          )}
        </div>
        {!native && (
          <p className="field-hint">
            Browser preview. Enter an absolute path on this computer. The local
            Rust reader opens it.
          </p>
        )}
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!path.trim() || busy || picking}
            type="submit"
          >
            {busy && <LoaderCircle size={14} className="spin" />}
            {busy ? "Opening…" : "Add repository"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
