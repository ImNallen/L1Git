import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Cloud, GitBranch, Search, X } from "lucide-react";
import { buildGraph } from "../domain/graph";
import type { GraphRow } from "../domain/graph";
import type { Oid, RepositorySnapshot } from "../domain/repository";
import { shortDate } from "../domain/time";

const ROW_HEIGHT = 36;
const OVERSCAN = 10;
const color = (lane: number) => `var(--graph-lane-${(lane % 6) + 1})`;
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
    <svg
      className="graph-cell"
      width={width}
      height={ROW_HEIGHT}
      aria-hidden="true"
    >
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
  selectedOid: Oid | null;
  revealSeq: number;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (oid: Oid) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  hidden: boolean;
};

export function History({
  snapshot,
  selectedOid,
  revealSeq,
  query,
  onQuery,
  onSelect,
  searchRef,
  busy,
  hidden,
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
  const commits = useMemo(
    () =>
      snapshot.commits.filter((commit) =>
        [commit.subject, commit.author, commit.email, commit.oid].some(
          (value) => value.toLocaleLowerCase().includes(search),
        ),
      ),
    [snapshot.commits, search],
  );
  const commitsRef = useRef(commits);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () =>
      setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    commitsRef.current = commits;
  });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (hidden || !scroller || selectedOid === null) return;
    const index = commitsRef.current.findIndex(
      (commit) => commit.oid === selectedOid,
    );
    if (index < 0) return;
    const header = headRef.current?.offsetHeight ?? 0;
    const rows = scroller.clientHeight - header;
    const rowTop = index * ROW_HEIGHT;
    if (
      rowTop + ROW_HEIGHT > scroller.scrollTop &&
      rowTop < scroller.scrollTop + rows
    )
      return;
    scroller.scrollTop = rowTop + ROW_HEIGHT / 2 - rows / 2;
    setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
  }, [selectedOid, revealSeq, hidden]);

  const first = Math.min(
    commits.length,
    Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN),
  );
  const last = Math.min(
    commits.length,
    Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
  );
  const graphWidth = Math.max(66, graph.lanes * 15 + 18);
  const columns = `${graphWidth}px minmax(260px, 1fr) 128px 84px 80px`;

  return (
    <section
      className="history"
      aria-label="Commit history"
      aria-busy={busy}
      hidden={hidden}
    >
      <div className="history-tools">
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
          {search ? `${commits.length.toLocaleString()} matching / ` : ""}
          {snapshot.commits.length.toLocaleString()}
          {snapshot.historyTruncated ? "+" : ""} loaded commits
          <span className="summary-separator">·</span>
          {snapshot.branches.length} branches
        </span>
        <span>
          {search
            ? "Graph connections hidden while filtering"
            : snapshot.historyTruncated
              ? `Newest ${snapshot.commits.length.toLocaleString()} commits`
              : "All branches"}
        </span>
      </div>
      <div className="history-scroll" ref={scrollRef}>
        <table
          className="history-table"
          style={{ minWidth: graphWidth + 552 }}
          aria-rowcount={commits.length + 1}
        >
          <thead ref={headRef}>
            <tr style={{ gridTemplateColumns: columns }} aria-rowindex={1}>
              <th scope="col">Graph</th>
              <th scope="col">Description</th>
              <th scope="col">Author</th>
              <th scope="col">Date</th>
              <th scope="col">Commit</th>
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true" style={{ height: first * ROW_HEIGHT }} />
            )}
            {commits.slice(first, last).map((commit, offset) => {
              const row = graph.rows.get(commit.oid);
              const labels = branches.get(commit.oid) ?? [];
              return (
                <tr
                  key={commit.oid}
                  className={selectedOid === commit.oid ? "selected" : ""}
                  style={{ gridTemplateColumns: columns }}
                  aria-rowindex={first + offset + 2}
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
            {last < commits.length && (
              <tr
                aria-hidden="true"
                style={{ height: (commits.length - last) * ROW_HEIGHT }}
              />
            )}
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
