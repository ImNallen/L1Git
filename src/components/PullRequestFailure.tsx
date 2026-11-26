import { GitPullRequest } from "lucide-react";
import type { OpenedPullRequest } from "../shell/usePullRequests";

export function PullRequestFailure({
  opened: { read, repository, number },
  url,
  onBack,
  onRefresh,
}: {
  opened: OpenedPullRequest;
  url: string;
  onBack: () => void;
  onRefresh: (() => void) | null;
}) {
  const { problem } = read;
  if (problem === null) return null;
  const gone = problem.kind === "notFound";
  return (
    <div className="pull-empty">
      <span className="no-host-glyph">
        <GitPullRequest size={16} />
      </span>
      <h3>
        {gone
          ? "Couldn't find this pull request"
          : `Couldn't read #${number} in ${repository.name}`}
      </h3>
      <p role="status">{problem.message}</p>
      <div className="pull-empty-actions">
        {problem.kind === "ssoRequired" && (
          <a
            className="button secondary"
            href={problem.url}
            target="_blank"
            rel="noreferrer"
          >
            Authorize on GitHub
          </a>
        )}
        {gone ? (
          <button type="button" className="button secondary" onClick={onBack}>
            Back to pull requests
          </button>
        ) : (
          <button
            type="button"
            className="button secondary"
            onClick={onRefresh ?? undefined}
          >
            Try again
          </button>
        )}
        <a
          className="button secondary"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub
        </a>
      </div>
    </div>
  );
}
