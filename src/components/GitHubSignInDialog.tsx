import { useEffect, useEffectEvent, useId, useState } from "react";
import { GitPullRequest, LoaderCircle } from "lucide-react";
import type { GhProbe, HostStatus } from "../domain/host";
import type { Host } from "../host";
import { DialogHeader, PathList, useModalDialog } from "./Dialog";
import { githubPromise } from "./githubPromise";

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

type Prompt = NonNullable<HostStatus["deviceCode"]>;

function expiresIn(ms: number) {
  const minutes = Math.ceil(ms / 60_000);
  return minutes > 1
    ? `The code expires in ${minutes} minutes.`
    : "The code expires in less than a minute.";
}

function DeviceCode({ prompt }: { prompt: Prompt }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  return (
    <>
      <p>
        Enter this code on GitHub to connect L1 Git. L1 Git keeps the sign-in in
        the system keychain. {githubPromise}
      </p>
      <div className="device-code">
        <output aria-label="Sign-in code">{prompt.userCode}</output>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            navigator.clipboard.writeText(prompt.userCode).then(
              () => setCopied("copied"),
              () => setCopied("failed"),
            )
          }
        >
          {copied === "copied"
            ? "Copied"
            : copied === "failed"
              ? "Could not copy"
              : "Copy code"}
        </button>
      </div>
      <p role="status">
        <LoaderCircle size={14} className="spin" /> Waiting for GitHub.{" "}
        {expiresIn(prompt.expiresInMs)}
      </p>
    </>
  );
}

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
  const connected = host.status?.github.kind === "connected";
  const closeConnected = useEffectEvent(close);
  useEffect(() => {
    if (connected) closeConnected();
  }, [connected]);
  const { cancelDevice } = host;
  useEffect(() => () => void cancelDevice(), [cancelDevice]);
  const looking = host.busy === "probeGh";
  const probe = looking ? null : host.probe;
  const connecting = host.busy === "connectGh";
  const prompt = host.status?.deviceCode ?? null;
  const browser =
    host.status?.deviceSignIn === true &&
    (probe !== null || host.problem !== null);
  const startBrowser = (className: string, label: string) => (
    <button
      type="button"
      className={className}
      disabled={host.busy === "deviceStart"}
      onClick={() => void host.startDevice()}
    >
      {host.busy === "deviceStart" && (
        <LoaderCircle size={14} className="spin" />
      )}
      {label}
    </button>
  );

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
      {prompt ? (
        <DeviceCode prompt={prompt} />
      ) : probe === null ? (
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
            the system keychain. {githubPromise} Disconnecting later does not
            sign the GitHub CLI out.
          </p>
          <PathList paths={[probe.path]} label="GitHub CLI" />
          {probe.access === "publicOnly" && (
            <p>
              This sign-in covers public repositories only. To add private ones,
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
        {browser &&
          !prompt &&
          probe?.kind === "ready" &&
          startBrowser(
            "button ghost dialog-aside",
            "Sign in with a browser instead",
          )}
        <button type="button" className="button secondary" onClick={close}>
          Cancel
        </button>
        {prompt ? (
          <a
            className="button primary"
            href={prompt.verificationUri}
            target="_blank"
            rel="noreferrer"
          >
            Open GitHub
          </a>
        ) : probe?.kind === "ready" ? (
          <button
            type="button"
            className="button primary"
            disabled={connecting}
            onClick={() => void host.connectGh(probe.login)}
          >
            {connecting && <LoaderCircle size={14} className="spin" />}
            Sign in as @{probe.login}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`button ${browser ? "secondary" : "primary"}`}
              disabled={looking}
              onClick={() => void host.probeGh()}
            >
              Check again
            </button>
            {browser &&
              startBrowser("button primary", "Sign in with a browser")}
          </>
        )}
      </div>
    </dialog>
  );
}
