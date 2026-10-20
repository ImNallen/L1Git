import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  CircleCheck,
  Cloud,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Tag,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { initials } from "../domain/author";
import { diffstatBlocks } from "../domain/diffstat";
import { buildGraph } from "../domain/graph";
import type { GraphRow } from "../domain/graph";
import { highlightBranch } from "../domain/highlight";
import type { RowHighlight } from "../domain/highlight";
import { historyAction, nextRow, revealRow } from "../domain/navigation";
import { refLabels } from "../domain/refs";
import type { RefLabel } from "../domain/refs";
import type {
  Commit,
  LineStats,
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import { useLineStats } from "../useLineStats";

const ROW_HEIGHT = 36;
const OVERSCAN = 10;
const HIGHLIGHT_DELAY = 400;
const color = (lane: number) => `var(--graph-lane-${(lane % 6) + 1})`;
const x = (lane: number) => 14 + lane * 24;

function GraphCell({
  row,
  commit,
  selected,
  width,
  known,
  lit,
}: {
  row: GraphRow;
  commit: Commit;
  selected: boolean;
  width: number;
  known: Set<Oid>;
  lit: RowHighlight | undefined;
}) {
  const dim = (on: boolean | undefined) => (lit && !on ? "dim" : undefined);
  const curve = (from: number, to: number, start: number, end: number) =>
    `M ${x(from)} ${start} C ${x(from)} ${(start + end) / 2}, ${x(to)} ${(start + end) / 2}, ${x(to)} ${end}`;
  const merge = commit.parents.length > 1;
  const radius = merge ? 5 : 10;
  return (
    <svg
      className="graph-cell"
      width={width}
      height={ROW_HEIGHT}
      aria-hidden="true"
    >
      {row.continuations.map((edge, index) => (
        <path
          key={`continue-${edge.from}`}
          className={dim(lit?.continuations[index])}
          d={curve(edge.from, edge.to, 0, 36)}
          stroke={color(edge.from)}
        />
      ))}
      {row.incoming && (
        <path
          className={dim(lit?.incoming)}
          d={`M ${x(row.lane)} 0 V 18`}
          stroke={color(row.lane)}
        />
      )}
      {row.parents.map((edge, index) => (
        <path
          key={edge.oid}
          className={dim(lit?.parents[index])}
          d={curve(edge.from, edge.to, 18, 36)}
          stroke={color(edge.to)}
          strokeDasharray={known.has(edge.oid) ? undefined : "3 3"}
        />
      ))}
      <g className="graph-node">
        <title>{`${commit.author} <${commit.email}>`}</title>
        {selected && (
          <circle
            cx={x(row.lane)}
            cy={18}
            r={radius + 2}
            fill="none"
            stroke="var(--text)"
            strokeWidth={2}
          />
        )}
        {merge ? (
          <circle
            cx={x(row.lane)}
            cy={18}
            r={radius}
            fill="var(--canvas)"
            stroke={color(row.lane)}
            strokeWidth={2}
          />
        ) : (
          <>
            <circle
              cx={x(row.lane)}
              cy={18}
              r={radius}
              fill={color(row.lane)}
            />
            <text
              x={x(row.lane)}
              y={18}
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--on-lane)"
              fontSize={8.5}
              fontWeight={600}
            >
              {initials(commit.author)}
            </text>
          </>
        )}
      </g>
    </svg>
  );
}

function ChangesCell({ stats }: { stats: LineStats | undefined }) {
  if (!stats) return <td className="changes-cell" />;
  const { added, deleted } = stats;
  const lines = (count: number) => `${count} line${count === 1 ? "" : "s"}`;
  const label = `${lines(added)} added, ${lines(deleted)} deleted`;
  return (
    <td className="changes-cell" aria-label={label} title={label}>
      <span className="change-stat added">+{added.toLocaleString()}</span>
      <span className="change-stat deleted">
        {"\u2212"}
        {deleted.toLocaleString()}
      </span>
      <span className="diffstat" aria-hidden="true">
        {diffstatBlocks(added, deleted).map((block, index) => (
          <span key={index} className={block} />
        ))}
      </span>
    </td>
  );
}

function labelName(label: RefLabel): string {
  return label.kind === "head" ? "HEAD" : label.name;
}

function badge(label: RefLabel): { Icon: LucideIcon; title: string } {
  switch (label.kind) {
    case "local":
      return {
        Icon: label.head ? CircleCheck : GitBranch,
        title: label.reference,
      };
    case "remote":
      return { Icon: Cloud, title: label.reference };
    case "tag":
      return { Icon: Tag, title: label.reference };
    case "worktree":
      return { Icon: FolderGit2, title: `Detached worktree at ${label.root}` };
    case "head":
      return { Icon: GitCommitHorizontal, title: "Detached HEAD" };
    default: {
      const exhaustive: never = label;
      return exhaustive;
    }
  }
}

function RefBadge({ label, lane }: { label: RefLabel; lane: number }) {
  const { Icon, title } = badge(label);
  return (
    <span
      className={`ref-badge ${label.kind}`}
      style={{ background: color(lane) }}
      title={title}
    >
      <Icon size={11} />
      <span className="ref-name">{labelName(label)}</span>
      {label.kind === "local" && label.worktree !== null && (
        <span
          className="ref-worktree"
          title={`Checked out in ${label.worktree}`}
        >
          <FolderGit2 size={10} />
        </span>
      )}
    </span>
  );
}

function MoreRefs({ labels, lane }: { labels: RefLabel[]; lane: number }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener("scroll", close, { capture: true, once: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [anchor]);
  const open = (event: { currentTarget: HTMLElement }) =>
    setAnchor(event.currentTarget.getBoundingClientRect());
  return (
    <>
      <span
        className="ref-badge more-refs"
        style={{ background: color(lane) }}
        aria-label={`${labels.length} more: ${labels.map(labelName).join(", ")}`}
        onMouseEnter={open}
        onMouseLeave={() => setAnchor(null)}
      >
        +{labels.length}
      </span>
      {anchor &&
        createPortal(
          <div
            className="more-refs-popover"
            role="tooltip"
            style={{ top: anchor.bottom + 4, left: anchor.left }}
          >
            {labels.map((label, index) => (
              <RefBadge key={index} label={label} lane={lane} />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

type Props = {
  snapshot: RepositorySnapshot;
  selectedOid: Oid | null;
  revealSeq: number;
  onSelect: (oid: Oid) => void;
  /** Opens the first changed file of the selected commit. */
  onOpen: () => void;
  /** Where the history of `root` was scrolled when it was last shown. */
  scrollTopOf: (root: RepositoryRoot) => number;
  onScroll: (root: RepositoryRoot, scrollTop: number) => void;
  busy: boolean;
  hidden: boolean;
  /** Tips of the default branch, which the highlight treats as trunk. */
  trunk: Oid[];
};

export function History({
  snapshot,
  selectedOid,
  revealSeq,
  onSelect,
  onOpen,
  scrollTopOf,
  onScroll,
  busy,
  hidden,
  trunk,
}: Props) {
  const graph = useMemo(
    () => buildGraph(snapshot.commits, snapshot.squashes),
    [snapshot.commits, snapshot.squashes],
  );
  const known = useMemo(
    () => new Set(snapshot.commits.map((commit) => commit.oid)),
    [snapshot.commits],
  );
  const labels = useMemo(() => refLabels(snapshot), [snapshot]);
  const commits = snapshot.commits;
  const [hovered, setHovered] = useState<Oid | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const highlight = useMemo(
    () =>
      hovered === null
        ? null
        : highlightBranch(snapshot.commits, graph.rows, hovered, trunk),
    [snapshot.commits, graph.rows, hovered, trunk],
  );
  const hover = (oid: Oid) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(
      () => setHovered(oid),
      HIGHLIGHT_DELAY,
    );
  };
  const unhover = () => {
    window.clearTimeout(hoverTimer.current);
    setHovered(null);
  };
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  // A refresh can move or drop the hovered tip without unmounting its badge
  // under a still pointer, so no mouseleave arrives to clear it.
  useLayoutEffect(unhover, [snapshot]);
  const commitsRef = useRef(commits);
  const rootRef = useRef(snapshot.root);
  const revealed = useRef<{
    root: RepositoryRoot;
    oid: Oid | null;
    seq: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  // Enter hides the history behind a diff, so focus returns when it closes.
  const refocus = useRef(false);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () =>
      setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
    // A hovered row can scroll out of the window and unmount without a mouseleave.
    const scrolled = () => {
      window.clearTimeout(hoverTimer.current);
      setHovered(null);
      measure();
      onScroll(rootRef.current, scroller.scrollTop);
    };
    measure();
    scroller.addEventListener("scroll", scrolled, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", scrolled);
      observer.disconnect();
    };
  }, [onScroll]);

  useLayoutEffect(() => {
    commitsRef.current = commits;
    rootRef.current = snapshot.root;
  });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (hidden || !scroller) return;
    const last = revealed.current;
    revealed.current = {
      root: snapshot.root,
      oid: selectedOid,
      seq: revealSeq,
    };
    // A repository reopens where it was left instead of jumping to its
    // remembered selection. A branch jump reveals with a later `revealSeq`.
    if (last?.root !== snapshot.root) {
      scroller.scrollTop = scrollTopOf(snapshot.root);
      setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
      return;
    }
    if (
      selectedOid === null ||
      (last.oid === selectedOid && last.seq === revealSeq)
    )
      return;
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
  }, [snapshot.root, scrollTopOf, selectedOid, revealSeq, hidden]);

  useLayoutEffect(() => {
    if (hidden || !refocus.current) return;
    refocus.current = false;
    tableRef.current?.focus({ preventScroll: true });
  }, [hidden]);

  function keyboard(event: KeyboardEvent<HTMLTableElement>) {
    const action = historyAction(event.nativeEvent);
    if (action === null) return;
    event.preventDefault();
    if (action === "open") {
      refocus.current = true;
      onOpen();
      return;
    }
    const oid = nextRow(commits, graph.rows, selectedOid, action);
    const scroller = scrollRef.current;
    if (oid === null || !scroller) return;
    const header = headRef.current?.offsetHeight ?? 0;
    scroller.scrollTop = revealRow(
      commits.findIndex((commit) => commit.oid === oid),
      ROW_HEIGHT,
      scroller.scrollTop,
      scroller.clientHeight - header,
    );
    setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
    onSelect(oid);
  }

  const first = Math.min(
    commits.length,
    Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN),
  );
  const last = Math.min(
    commits.length,
    Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
  );
  const visible = useMemo(
    () => commits.slice(first, last),
    [commits, first, last],
  );
  const lineStats = useLineStats(snapshot.root, visible);
  const graphWidth = Math.max(48, graph.lanes * 24 + 10);
  const columns = `200px ${graphWidth}px minmax(260px, 1fr) 160px`;
  const active =
    selectedOid !== null && visible.some((commit) => commit.oid === selectedOid)
      ? rowId(selectedOid)
      : undefined;

  return (
    <section
      className="history"
      aria-label="Commit history"
      aria-busy={busy}
      hidden={hidden}
    >
      <div className="history-scroll" ref={scrollRef}>
        <table
          ref={tableRef}
          className={`history-table${highlight ? " highlighting" : ""}`}
          style={{ minWidth: graphWidth + 620 }}
          role="grid"
          tabIndex={0}
          aria-label="Commits"
          aria-rowcount={commits.length + 1}
          aria-activedescendant={active}
          onKeyDown={keyboard}
        >
          <thead ref={headRef}>
            <tr style={{ gridTemplateColumns: columns }} aria-rowindex={1}>
              <th scope="col">Branch / Tag</th>
              <th scope="col">Graph</th>
              <th scope="col">Commit message</th>
              <th scope="col">Changes</th>
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true" style={{ height: first * ROW_HEIGHT }} />
            )}
            {visible.map((commit, offset) => {
              const row = graph.rows.get(commit.oid);
              const [label, ...more] = labels.get(commit.oid) ?? [];
              const selected = selectedOid === commit.oid;
              const lit = highlight?.commits.has(commit.oid);
              return (
                <tr
                  key={commit.oid}
                  id={rowId(commit.oid)}
                  className={
                    [selected && "selected", lit && "lit"]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  style={{ gridTemplateColumns: columns }}
                  aria-rowindex={first + offset + 2}
                  aria-selected={selected}
                  onClick={() => {
                    onSelect(commit.oid);
                    tableRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <td className="ref-cell">
                    {label && (
                      <span
                        className="ref-badges"
                        onMouseEnter={() => hover(commit.oid)}
                        onMouseLeave={unhover}
                      >
                        <RefBadge label={label} lane={row?.lane ?? 0} />
                        {more.length > 0 && (
                          <MoreRefs labels={more} lane={row?.lane ?? 0} />
                        )}
                      </span>
                    )}
                  </td>
                  <td>
                    {row && (
                      <GraphCell
                        row={row}
                        commit={commit}
                        selected={selected}
                        width={graphWidth}
                        known={known}
                        lit={highlight?.rows.get(commit.oid)}
                      />
                    )}
                  </td>
                  <td>
                    <button
                      className="commit-description"
                      tabIndex={-1}
                      aria-label={`${commit.subject}, ${commit.author}, ${commit.oid.slice(0, 7)}`}
                      aria-pressed={selected}
                    >
                      <span className="commit-subject" title={commit.subject}>
                        {commit.subject || "(no subject)"}
                      </span>
                    </button>
                  </td>
                  <ChangesCell stats={lineStats.get(commit.oid)} />
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
            <h2>No commits yet</h2>
            <p>
              This repository has no commit history. Create a commit in Git,
              then refresh.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function rowId(oid: Oid): string {
  return `history-row-${oid}`;
}

/** Holds the history pane while a repository opens for the first time. */
export function HistoryPlaceholder() {
  return (
    <section className="history" aria-label="Commit history" aria-busy>
      <div className="history-pending" aria-hidden="true">
        {[46, 62, 38, 55, 70, 42, 58, 35].map((width, index) => (
          <span key={index} style={{ width: `${width}%` }} />
        ))}
      </div>
    </section>
  );
}
