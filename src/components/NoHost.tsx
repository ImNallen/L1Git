import type { HostStatus } from "../domain/host";
import { WorkspaceIcon } from "./WorkspaceIcon";

type Ended = NonNullable<
  Extract<HostStatus["github"], { kind: "notConnected" }>["ended"]
>;

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

/** Why the last sign-in ended, and the way to a new one. */
export function NoHost({
  ended,
  onSignIn,
}: {
  ended: Ended | null;
  onSignIn: () => void;
}) {
  return (
    <>
      {ended && (
        <p className="settings-error hosts-ended">{endedText(ended)}</p>
      )}
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
    </>
  );
}
