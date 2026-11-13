import { GitCommitHorizontal } from "lucide-react";
import type { Oid } from "../domain/repository";
import { ConfirmDialog } from "./ConfirmDialog";
import { shortOid } from "../domain/shortOid";

type Props = {
  oid: Oid;
  onConfirm: () => void;
  onClose: () => void;
};

export function CheckoutCommitDialog({ oid, onConfirm, onClose }: Props) {
  const short = shortOid(oid);
  return (
    <ConfirmDialog
      icon={GitCommitHorizontal}
      title={`Check out commit ${short}?`}
      closeLabel="Close check out commit"
      confirm="Check out"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <p>
        HEAD will be detached at {short}, new commits will belong to no branch
        until you create one, and you can undo this.
      </p>
    </ConfirmDialog>
  );
}
