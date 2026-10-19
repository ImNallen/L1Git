import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { FileJson, Plus, Upload, X } from "lucide-react";
import type { ThemeFamilyDraft } from "../themes/catalog";
import { parseThemeFile, type ImportResult } from "../themes/importers";

type Props = {
  onAdd: (families: readonly ThemeFamilyDraft[]) => void;
  onClose: () => void;
};

const EXAMPLE = `{
  "version": 1,
  "name": "Aurora",
  "appearance": "light",
  "colors": { "background": "#fbfaff", "accent": "#7c3aed" }
}`;

const readFile = (file: File): Promise<ImportResult> =>
  file
    .text()
    .then((text) => parseThemeFile(text, file.name))
    .catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

async function readFiles(files: readonly File[]) {
  const results = await Promise.all(
    files.map(async (f) => ({ name: f.name, result: await readFile(f) })),
  );
  return {
    families: results.flatMap(({ result }) =>
      result.ok ? [result.family] : [],
    ),
    errors: results.flatMap(({ name, result }) =>
      result.ok ? [] : [`${name}: ${result.error}`],
    ),
  };
}

// A file dropped anywhere else in the dialog would make the webview navigate to it.
const holdDrop = (event: DragEvent) => event.preventDefault();

export function AddThemeDialog({ onAdd, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);

  async function importFiles(files: readonly File[]) {
    const { families, errors } = await readFiles(files);
    if (families.length > 0) onAdd(families);
    if (errors.length > 0) setErrors(errors);
    else onClose();
  }

  function importJson() {
    const result = parseThemeFile(json);
    if (!result.ok) return setErrors([result.error]);
    onAdd([result.family]);
    onClose();
  }

  return (
    <dialog
      ref={dialog}
      className="add-dialog add-theme-dialog"
      aria-labelledby="add-theme-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onDragOver={holdDrop}
      onDrop={holdDrop}
    >
      <div className="dialog-title">
        <div className="dialog-icon">
          <FileJson size={21} />
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close add theme"
        >
          <X size={17} />
        </button>
      </div>
      <h1 id="add-theme-title">Add a theme</h1>
      <p>Import an L1 theme or a VS Code color theme.</p>
      <div
        className={`theme-drop-zone ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          void importFiles([...event.dataTransfer.files]);
        }}
      >
        <div>
          <strong>Theme file</strong>
          <span>Drop L1 or VS Code .json files</span>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={() => picker.current?.click()}
        >
          <Upload size={14} />
          Choose files
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          accept=".json,.jsonc,application/json"
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) void importFiles(files);
          }}
        />
      </div>
      <label htmlFor="theme-json">Theme JSON</label>
      <textarea
        id="theme-json"
        className="theme-json"
        spellCheck={false}
        rows={6}
        placeholder={EXAMPLE}
        value={json}
        onChange={(event) => {
          setJson(event.target.value);
          setErrors([]);
        }}
      />
      {errors.length > 0 && (
        <ul className="error-message theme-import-errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!json.trim()}
          onClick={importJson}
        >
          <Plus size={14} />
          Add theme
        </button>
      </div>
    </dialog>
  );
}
