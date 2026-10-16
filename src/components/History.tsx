import { useMemo } from "react";
import type { RefObject } from "react";
import { Cloud, GitBranch, Search, X } from "lucide-react";
import { buildGraph } from "../domain/graph";
import type { GraphRow } from "../domain/graph";
import type { FullRef, Oid, RepositorySnapshot } from "../domain/repository";
import { shortDate } from "../domain/time";

const colors = [
  "#60a5fa",
  "#a78bfa",
  "#fbbf24",
  "#34d399",
  "#f472b6",
  "#22d3ee",
];
const color = (lane: number) => colors[lane % colors.length] ?? "#60a5fa";
const x = (lane: number) => 16 + lane * 15;

function GraphCell({
  row,
  width,
  filtered,
  known,
}: {
  row: GraphRow;
  width: number;
  filtered: boolean;
  known: Set<Oid>;
}) {
  const curve = (from: number, to: number, start: number, end: number) =>
    `M ${x(from)} ${start} C ${x(from)} ${(start + end) / 2}, ${x(to)} ${(start + end) / 2}, ${x(to)} ${end}`;
  return (
    <svg className="graph-cell" width={width} height={36} aria-hidden="true">
      {!filtered && (
        <>
          {row.continuations.map((edge) => (
            <path
              key={`continue-${edge.from}`}
              d={curve(edge.from, edge.to, 0, 36)}
              stroke={color(edge.from)}
            />
          ))}
          {row.incoming && (
            <path d={`M ${x(row.lane)} 0 V 18`} stroke={color(row.lane)} />
          )}
          {row.parents.map((edge) => (
            <path
              key={edge.oid}
              d={curve(edge.from, edge.to, 18, 36)}
              stroke={color(edge.to)}
              strokeDasharray={known.has(edge.oid) ? undefined : "3 3"}
            />
          ))}
        </>
      )}
      <circle
        cx={x(row.lane)}
        cy={18}
        r={4}
        fill={row.parents.length > 1 ? "var(--canvas)" : color(row.lane)}
        stroke={color(row.lane)}
        strokeWidth={2}
      />
    </svg>
  );
}

type Props = {
  snapshot: RepositorySnapshot;
  reference: FullRef | null;
  selectedOid: Oid | null;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (oid: Oid) => void;
  onBrowse: (reference: FullRef | null) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
};

export function History({
  snapshot,
  reference,
  selectedOid,
  query,
  onQuery,
  onSelect,
  onBrowse,
  searchRef,
  busy,
}: Props) {
  const graph = useMemo(() => buildGraph(snapshot.commits), [snapshot.commits]);
  const known = useMemo(
    () => new Set(snapshot.commits.map((commit) => commit.oid)),
    [snapshot.commits],
  );
  const branches = useMemo(() => {
    const byOid = new Map<Oid, typeof snapshot.branches>();
    for (const branch of snapshot.branches)
      byOid.set(branch.oid, [...(byOid.get(branch.oid) ?? []), branch]);
    return byOid;
  }, [snapshot.branches]);
  const search = query.trim().toLocaleLowerCase();
  const commits = snapshot.commits.filter((commit) =>
    [commit.subject, commit.author, commit.email, commit.oid].some((value) =>
      value.toLocaleLowerCase().includes(search),
    ),
  );
  const graphWidth = Math.max(66, graph.lanes * 15 + 18);
  const columns = `${graphWidth}px minmax(260px, 1fr) 128px 84px 80px`;

  return (
    <section className="history" aria-label="Commit history" aria-busy={busy}>
      <div className="history-tools">
        <label className="branch-select">
          <GitBranch size={14} />
          <select
            aria-label="Browse branch history"
            value={reference ?? ""}
            disabled={busy}
            onChange={(event) => {
              const branch = snapshot.branches.find(
                (branch) => branch.reference === event.target.value,
              );
              onBrowse(branch?.reference ?? null);
            }}
          >
            <option value="">All branches</option>
            {snapshot.branches.map((branch) => (
              <option key={branch.reference} value={branch.reference}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        <div className="history-search">
          <Search size={14} />
          <input
            ref={searchRef}
            aria-label="Search loaded history"
            placeholder="Search loaded messages, authors, and SHAs"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="Clear history search"
              onClick={() => onQuery("")}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="history-summary">
        <span>
          {search ? `${commits.length} matching / ` : ""}
          {snapshot.commits.length}
          {snapshot.historyTruncated ? "+" : ""} loaded commits
          <span className="summary-separator">·</span>
          {snapshot.branches.length} branches
        </span>
        <span>
          {search
            ? "Graph connections hidden while filtering"
            : snapshot.historyTruncated
              ? "Newest 200 · refine by branch"
              : reference
                ? "Browsing branch · HEAD unchanged"
                : "Local history"}
        </span>
      </div>
      <div className="history-scroll">
        <table className="history-table" style={{ minWidth: graphWidth + 552 }}>
          <colgroup>
            <col style={{ width: graphWidth }} />
            <col />
            <col className="author-col" style={{ width: 128 }} />
            <col style={{ width: 84 }} />
            <col style={{ width: 80 }} />
          </colgroup>
          <thead>
            <tr style={{ gridTemplateColumns: columns }}>
              <th scope="col">Graph</th>
              <th scope="col">Description</th>
              <th scope="col">Author</th>
              <th scope="col">Date</th>
              <th scope="col">Commit</th>
            </tr>
          </thead>
          <tbody>
            {commits.map((commit) => {
              const row = graph.rows.get(commit.oid);
              const labels = branches.get(commit.oid) ?? [];
              return (
                <tr
                  key={commit.oid}
                  className={selectedOid === commit.oid ? "selected" : ""}
                  style={{ gridTemplateColumns: columns }}
                >
                  <td>
                    {row && (
                      <GraphCell
                        row={row}
                        width={graphWidth}
                        filtered={search.length > 0}
                        known={known}
                      />
                    )}
                  </td>
                  <td>
                    <button
                      className="commit-description"
                      aria-label={`${commit.subject}, ${commit.oid.slice(0, 7)}`}
                      aria-pressed={selectedOid === commit.oid}
                      onClick={() => onSelect(commit.oid)}
                    >
                      <span className="ref-badges">
                        {labels.slice(0, 2).map((branch) => (
                          <span
                            className={`ref-badge ${branch.kind}`}
                            key={branch.reference}
                            title={branch.reference}
                          >
                            {branch.kind === "remote" ? (
                              <Cloud size={11} />
                            ) : (
                              <GitBranch size={11} />
                            )}
                            {branch.name}
                          </span>
                        ))}
                        {labels.length > 2 && (
                          <span
                            className="more-refs"
                            title={labels
                              .slice(2)
                              .map((branch) => branch.name)
                              .join(", ")}
                          >
                            +{labels.length - 2}
                          </span>
                        )}
                      </span>
                      <span className="commit-subject" title={commit.subject}>
                        {commit.subject || "(no subject)"}
                      </span>
                    </button>
                  </td>
                  <td title={`${commit.author} <${commit.email}>`}>
                    <span className="author-avatar">
                      {commit.author
                        .split(/\s+/)
                        .map((part) => part[0])
                        .slice(0, 2)
                        .join("")}
                    </span>
                    <span className="author-name">{commit.author}</span>
                  </td>
                  <td
                    title={new Date(commit.timestamp * 1000).toLocaleString()}
                  >
                    {shortDate(commit.timestamp)}
                  </td>
                  <td className="commit-hash">{commit.oid.slice(0, 7)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {commits.length === 0 && (
          <div className="history-empty">
            <GitBranch size={26} />
            <h2>{search ? "No matching commits" : "No commits yet"}</h2>
            <p>
              {search
                ? "Search covers the loaded messages, authors, emails, and commit IDs."
                : "This repository has no commit history. Create a commit in Git, then refresh."}
            </p>
            {search && (
              <button className="button secondary" onClick={() => onQuery("")}>
                Clear search
              </button>
            )}
          </div>
        )}
      </div>
      {busy && (
        <div className="history-loading" role="status">
          <span className="loading-dot" />
          Reading local Git history…
        </div>
      )}
    </section>
  );
}
