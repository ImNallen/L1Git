import { useState } from "react";
import { LoaderCircle, Unplug } from "lucide-react";
import type { Access, HostStatus } from "../domain/host";
import type { Host } from "../host";
import { settingsDestinations } from "../settingsSearch";
import { ConfirmDialog } from "./ConfirmDialog";
import { GitHubSignInDialog } from "./GitHubSignInDialog";
import { WorkspaceIcon } from "./WorkspaceIcon";

type Ended = NonNullable<
  Extract<HostStatus["github"], { kind: "notConnected" }>["ended"]
>;

const access: Record<Access, string> = {
  private: "Reads private and public repositories.",
  publicOnly: "Reads public repositories only.",
  perRepository: "Reads the repositories this token allows.",
};

function endedText({ login, reason }: Ended) {
  const account = login === null ? "" : ` for @${login}`;
  switch (reason) {
    case "revoked":
      return `GitHub no longer accepts L1 Git's sign-in${account}.`;
    case "tokenMissing":
      return `L1 Git's sign-in${account} is no longer in the system keychain.`;
    case "unreadable":
      return "L1 Git could not read its saved GitHub connection.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function NoHostCard({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="no-host-card">
      <span className="no-host-glyph">
        <WorkspaceIcon name="SettingsHosts" />
      </span>
      <h3>Connect a host to see pull requests</h3>
      <p>Sign in once so L1 Git can read pull requests from GitHub.</p>
      <button type="button" className="button primary" onClick={onSignIn}>
        Sign in to GitHub
      </button>
    </div>
  );
}

export function HostsSettings({ host }: { host: Host }) {
  const [signingIn, setSigningIn] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const github = host.status?.github;
  return (
    <section className="settings-page" aria-labelledby="hosts-heading">
      <div className="settings-content">
        <div className="settings-page-heading">
          <h1 id="hosts-heading" tabIndex={-1}>
            Hosts
          </h1>
          <p>Connect the services L1 Git reads pull requests from.</p>
        </div>
        <section
          className="general-settings-group"
          aria-labelledby="hosts-github-heading"
        >
          <h2 id="hosts-github-heading" className="general-settings-title">
            GitHub
          </h2>
          <div id={settingsDestinations.github.targetId} tabIndex={-1}>
            {github === undefined ? (
              <p className="settings-description" role="status">
                Checking the GitHub connection…
              </p>
            ) : github.kind === "notConnected" ? (
              <>
                {github.ended && (
                  <p className="settings-error hosts-ended">
                    {endedText(github.ended)}
                  </p>
                )}
                <NoHostCard onSignIn={() => setSigningIn(true)} />
              </>
            ) : (
              <div className="settings-row-group">
                <div className="settings-row">
                  <div>
                    <h3 className="hosts-login">@{github.login}</h3>
                    <p>github.com · {access[github.access]}</p>
                    {accepted && (
                      <p role="status">
                        GitHub accepted this sign-in just now.
                      </p>
                    )}
                  </div>
                  <div className="update-actions">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={host.busy !== null}
                      onClick={() => {
                        setAccepted(false);
                        void host.verify().then(setAccepted);
                      }}
                    >
                      {host.busy === "verify" && (
                        <LoaderCircle size={14} className="spin" />
                      )}
                      Check connection
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={host.busy !== null}
                      onClick={() => setDisconnecting(true)}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          {host.problem && !signingIn && (
            <p className="settings-error" role="alert">
              {host.problem}
            </p>
          )}
        </section>
      </div>
      {signingIn && (
        <GitHubSignInDialog
          host={host}
          onClose={() => {
            setSigningIn(false);
            setAccepted(github?.kind === "connected");
          }}
        />
      )}
      {disconnecting && github?.kind === "connected" && (
        <ConfirmDialog
          icon={Unplug}
          title="Disconnect GitHub?"
          closeLabel="Close disconnect"
          confirm="Disconnect"
          onConfirm={() => void host.disconnect()}
          onClose={() => setDisconnecting(false)}
        >
          {github.method === "gh" ? (
            <p>
              L1 Git will delete its copy of the sign-in for @{github.login}{" "}
              from the system keychain. The GitHub CLI stays signed in.
            </p>
          ) : (
            <p>
              L1 Git will delete its sign-in for @{github.login} from the system
              keychain.
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}
