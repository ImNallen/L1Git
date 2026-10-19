import { useEffect, useRef } from "react";
import { Trash2, X } from "lucide-react";

type Props = {
  name: string;
  onDelete: () => void;
  onClose: () => void;
};

export function DeleteThemeDialog({ name, onDelete, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);

  return (
    <dialog
      ref={dialog}
      className="add-dialog"
      aria-labelledby="delete-theme-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-title">
        <div className="dialog-icon">
          <Trash2 size={20} />
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close delete theme"
        >
          <X size={17} />
        </button>
      </div>
      <h1 id="delete-theme-title">Delete {name}?</h1>
      <p>
        The theme is removed from your themes. If light or dark mode uses it,
        that mode goes back to L1.
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          className="button secondary"
          autoFocus
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
          onClick={() => {
            onDelete();
            onClose();
          }}
        >
          Delete theme
        </button>
      </div>
    </dialog>
  );
}
