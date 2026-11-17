import { useId } from "react";
import { GitPullRequest, LoaderCircle } from "lucide-react";
import type { GhProbe } from "../domain/host";
import type { Host } from "../host";
import { DialogHeader, PathList, useModalDialog } from "./Dialog";

function Guidance({ probe }: { probe: Exclude<GhProbe, { kind: "ready" }> }) {
  switch (probe.kind) {
    case "missing":
      return (
        <p>
          L1 Git can't find the GitHub CLI. Install it from{" "}
          <a href="https://cli.github.com" target="_blank" rel="noreferrer">
            cli.github.com
          </a>
          , run <code>gh auth login</code> in a terminal, then check again.
        </p>
      );
    case "outdated":
      return (
        <p>
          This GitHub CLI is too old for L1 Git to read its sign-in. Update gh,
          then check again.
        </p>
      );
    case "signedOut":
      return (
        <p>
          The GitHub CLI isn't signed in to github.com. Run{" "}
          <code>gh auth login</code> in a terminal, then check again.
        </p>
      );
    case "broken":
      return (
        <p>
          The GitHub CLI's sign-in for @{probe.login} no longer works. Run{" "}
          <code>gh auth login</code> in a terminal to sign in again, then check
          again.
        </p>
      );
    case "failed":
      return (
        <p>L1 Git could not read the GitHub CLI's sign-in. {probe.detail}</p>
      );
    default: {
      const exhaustive: never = probe;
      return exhaustive;
    }
  }
}

/** Asks gh who is signed in, then copies that sign-in only after consent. */
export function GitHubSignInDialog({
  host,
  onClose,
}: {
  host: Host;
  onClose: () => void;
}) {
  const titleId = useId();
  const { ref, close, onCancel } = useModalDialog(
    () => {
      host.dismiss();
      onClose();
    },
    () => void host.probeGh(),
  );
  const looking = host.busy === "probeGh";
  const probe = looking ? null : host.probe;
  const connecting = host.busy === "connectGh";

  return (
    <dialog
      ref={ref}
      className="add-dialog"
      aria-labelledby={titleId}
      onCancel={onCancel}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <DialogHeader
        icon={<GitPullRequest size={20} />}
        titleId={titleId}
        title="Sign in to GitHub"
        closeLabel="Close GitHub sign-in"
        onClose={close}
      />
      {probe === null ? (
        !host.problem && (
          <p role="status">
            <LoaderCircle size={14} className="spin" /> Looking for the GitHub
            CLI…
          </p>
        )
      ) : probe.kind === "ready" ? (
        <>
          <p>
            L1 Git will copy the GitHub CLI's sign-in for @{probe.login} into
            the system keychain. L1 Git only reads from GitHub. Disconnecting
            later does not sign the GitHub CLI out.
          </p>
          <PathList paths={[probe.path]} label="GitHub CLI" />
          {probe.access === "publicOnly" && (
            <p>
              This sign-in reads public repositories only. To read private ones,
              cancel, run <code>gh auth refresh -h github.com -s repo</code> in
              a terminal, then sign in again.
            </p>
          )}
        </>
      ) : (
        <Guidance probe={probe} />
      )}
      {host.problem && (
        <p className="error-message" role="alert">
          {host.problem}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={close}>
          Cancel
        </button>
        {probe?.kind === "ready" ? (
          <button
            type="button"
            className="button primary"
            disabled={connecting}
            onClick={async () => {
              if (await host.connectGh(probe.login)) close();
            }}
          >
            {connecting && <LoaderCircle size={14} className="spin" />}
            Sign in as @{probe.login}
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={looking}
            onClick={() => void host.probeGh()}
          >
            Check again
          </button>
        )}
      </div>
    </dialog>
  );
}
