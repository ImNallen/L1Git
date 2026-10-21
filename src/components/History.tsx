import {
  Fragment,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent, ReactNode, Ref } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Check,
  CircleCheck,
  Cloud,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Pin,
  Tag,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { initials } from "../domain/author";
import { mac } from "../repositories";
import { compareRows, comparedRowId } from "../domain/comparison";
import type { Compare } from "../domain/comparison";
import { diffstatBlocks } from "../domain/diffstat";
import type { Graph, GraphRow, RowId } from "../domain/graph";
import { highlightBranch } from "../domain/highlight";
import type { RowHighlight } from "../domain/highlight";
import {
  historyAction,
  navigate,
  landingFromHidden,
  revealRow,
} from "../domain/navigation";
import type { HistoryAction, Trail } from "../domain/navigation";
import { refLabels } from "../domain/refs";
import type { RefLabel } from "../domain/refs";
import {
  matchPositions,
  matchCommits,
  matchCount,
  stepMatch,
} from "../domain/search";
import { historyPlace, rowSelection, selectedRowId } from "../domain/selection";
import type { Selection } from "../domain/selection";
import { changeSummary } from "../domain/worktree";
import type { HistoryRow, WorktreeRow } from "../domain/worktree";
import { SHORT_OID_MIN_LENGTH, uniqueShortOids } from "../domain/shortOid";
import { relativeTime } from "../domain/time";
import { branchVisibility } from "../domain/visibility";
import type { VisibilityRule } from "../domain/visibility";
import type {
  Commit,
  LineStats,
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import { columnLayout, historyColumns } from "../historyColumns";
import type { ColumnId } from "../historyColumns";
import { useLineStats } from "../useLineStats";
import { ContextMenu } from "./ContextMenu";
import { HistorySearch } from "./HistorySearch";

const ROW_HEIGHT = 36;
const OVERSCAN = 10;
const HIGHLIGHT_DELAY = 400;
const color = (lane: number) => `var(--graph-lane-${(lane % 6) + 1})`;
const x = (lane: number) => 14 + lane * 24;
const NO_COMMITS: readonly Commit[] = [];
const WORKTREE_DASH = "2 3";
const NO_EDGES: RowHighlight = {
  incoming: false,
  parents: [],
  continuations: [],
};

function GraphCell({
  row,
  width,
  known,
  lit,
  parentDash,
  children,
}: {
  row: GraphRow;
  width: number;
  known: ReadonlySet<Oid>;
  lit: RowHighlight | undefined;
  parentDash?: string;
  children: ReactNode;
}) {
  const dim = (on: boolean | undefined) => (lit && !on ? "dim" : undefined);
  const curve = (from: number, to: number, start: number, end: number) =>
    `M ${x(from)} ${start} C ${x(from)} ${(start + end) / 2}, ${x(to)} ${(start + end) / 2}, ${x(to)} ${end}`;
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
          strokeDasharray={
            parentDash ?? (known.has(edge.oid) ? undefined : "3 3")
          }
        />
      ))}
      {children}
    </svg>
  );
}

type Ring = "selected" | "compared" | null;

function RowRing({
  lane,
  radius,
  ring,
}: {
  lane: number;
  radius: number;
  ring: Ring;
}) {
  if (ring === null) return null;
  return (
    <circle
      cx={x(lane)}
      cy={18}
      r={radius + 2}
      fill="none"
      stroke="var(--text)"
      strokeWidth={2}
      strokeDasharray={ring === "compared" ? "3 2" : undefined}
    />
  );
}

function WorktreeNode({ lane, ring }: { lane: number; ring: Ring }) {
  return (
    <g className="graph-node">
      <RowRing lane={lane} radius={8} ring={ring} />
      <circle
        cx={x(lane)}
        cy={18}
        r={8}
        fill="var(--canvas)"
        stroke={color(lane)}
        strokeWidth={2}
        strokeDasharray={WORKTREE_DASH}
      />
    </g>
  );
}

function CommitNode({
  commit,
  lane,
  ring,
}: {
  commit: Commit;
  lane: number;
  ring: Ring;
}) {
  const merge = commit.parents.length > 1;
  const radius = merge ? 5 : 10;
  return (
    <g className="graph-node">
      <title>{`${commit.author} <${commit.email}>`}</title>
      <RowRing lane={lane} radius={radius} ring={ring} />
      {merge ? (
        <circle
          cx={x(lane)}
          cy={18}
          r={radius}
          fill="var(--canvas)"
          stroke={color(lane)}
          strokeWidth={2}
        />
      ) : (
        <>
          <circle cx={x(lane)} cy={18} r={radius} fill={color(lane)} />
          <text
            x={x(lane)}
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
  );
}

function WorktreeDescription({ row }: { row: WorktreeRow }) {
  const summary =
    row.changes.kind === "error"
      ? "Could not read the changes"
      : changeSummary(row.changes.status.entries);
  return (
    <button
      className="commit-description"
      tabIndex={-1}
      aria-label={`Uncommitted changes in ${row.worktree.name}, ${summary}`}
    >
      <span className="commit-subject worktree-subject">
        Uncommitted changes
      </span>
      <span className="worktree-summary" title={summary}>
        {summary}
      </span>
    </button>
  );
}

function ChangesCell({ stats }: { stats: LineStats | undefined }) {
  if (!stats) return <td role="gridcell" className="changes-cell" />;
  const { added, deleted } = stats;
  const lines = (count: number) => `${count} line${count === 1 ? "" : "s"}`;
  const label = `${lines(added)} added, ${lines(deleted)} deleted`;
  return (
    <td
      role="gridcell"
      className="changes-cell"
      aria-label={label}
      title={label}
    >
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

function TextCell({
  className,
  title,
  children,
}: {
  className?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <td
      role="gridcell"
      className={className ? `text-cell ${className}` : "text-cell"}
      title={title}
    >
      <span>{children}</span>
    </td>
  );
}

type CellContext = {
  stats: LineStats | undefined;
  shortOid: string;
  now: number;
};

const cells: Record<
  ColumnId,
  (commit: Commit, context: CellContext) => ReactNode
> = {
  author: (commit) => (
    <TextCell title={`${commit.author} <${commit.email}>`}>
      {commit.author}
    </TextCell>
  ),
  date: (commit, { now }) => (
    <TextCell
      className="date-cell"
      title={new Date(commit.timestamp * 1000).toLocaleString()}
    >
      {relativeTime(commit.timestamp, now)}
    </TextCell>
  ),
  sha: (commit, { shortOid }) => (
    <TextCell className="sha-cell" title={commit.oid}>
      {shortOid}
    </TextCell>
  ),
  changes: (_, { stats }) => <ChangesCell stats={stats} />,
};

function useNowSeconds(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now() / 1000);
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
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

export function RefBadge({
  label,
  lane,
}: {
  label: RefLabel;
  lane: number | null;
}) {
  const { Icon, title } = badge(label);
  return (
    <span
      className={`ref-badge ${label.kind}${lane === null ? " off-graph" : ""}`}
      style={lane === null ? undefined : { background: color(lane) }}
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

export type HistoryHandle = {
  openSearch: () => void;
  focus: () => void;
  picked: () => Oid | null;
  pick: (oid: Oid | null) => void;
  compareWithPick: (oid: Oid) => void;
  compareWithWorkingCopy: (oid: Oid) => void;
};

type Search = { root: RepositoryRoot; query: string };

type Props = {
  ref?: Ref<HistoryHandle>;
  snapshot: RepositorySnapshot;
  visibleCommits: readonly Commit[];
  visibleOids: ReadonlySet<Oid>;
  rows: readonly HistoryRow[];
  graph: Graph;
  rule: VisibilityRule;
  selection: Selection | null;
  compare: Compare | null;
  revealSeq: number;
  onSelect: (selection: Selection) => void;
  onCompare: (compare: Compare) => void;
  onEndCompare: () => void;
  onOpenFirstFile: () => void;
  onCancelOpen: () => void;
  /** Where the history of `root` was scrolled when it was last shown. */
  scrollTopOf: (root: RepositoryRoot) => number;
  onScroll: (root: RepositoryRoot, scrollTop: number) => void;
  busy: boolean;
  hidden: boolean;
  /** Tips of the default branch, which the highlight treats as trunk. */
  trunk: Oid[];
  visibleColumns: ReadonlySet<ColumnId>;
  onToggleColumn: (id: ColumnId) => void;
};

export function History({
  ref,
  snapshot,
  visibleCommits: commits,
  visibleOids: known,
  rows,
  graph,
  rule,
  selection,
  compare,
  revealSeq,
  onSelect,
  onCompare,
  onEndCompare,
  onOpenFirstFile,
  onCancelOpen,
  scrollTopOf,
  onScroll,
  busy,
  hidden,
  trunk,
  visibleColumns,
  onToggleColumn,
}: Props) {
  const selectedOid = selection?.kind === "commit" ? selection.oid : null;
  const selectedId = selectedRowId(selection);
  const comparedId = compare && comparedRowId(compare);
  const labels = useMemo(
    () =>
      refLabels({
        ...snapshot,
        branches: snapshot.branches.filter(
          (branch) => branchVisibility(rule, branch.reference) !== "hidden",
        ),
      }),
    [snapshot, rule],
  );
  const [search, setSearch] = useState<Search | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  if (search && search.root !== snapshot.root) setSearch(null);
  const query = search?.query ?? "";
  const matches = useMemo(
    () => matchPositions(matchCommits(commits, query)),
    [commits, query],
  );
  const searching = matches.size > 0;
  const [hovered, setHovered] = useState<Oid | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const highlight = useMemo(
    () =>
      hovered === null || searching
        ? null
        : highlightBranch(rows, graph.rows, hovered, trunk),
    [rows, graph.rows, hovered, trunk, searching],
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
  useLayoutEffect(unhover, [snapshot, rows]);
  const rowsRef = useRef(rows);
  const rootRef = useRef(snapshot.root);
  const revealed = useRef<{
    root: RepositoryRoot;
    id: RowId | null;
    seq: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const trail = useRef<Trail | null>(null);
  const wasHidden = useRef(hidden);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    commit: Oid | null;
  } | null>(null);
  const revealOnClose = useRef<ColumnId | null>(null);
  const now = useNowSeconds(visibleColumns.has("date"));
  const shaShown = visibleColumns.has("sha");
  const short = useMemo(
    () =>
      shaShown
        ? uniqueShortOids(snapshot.commits.map((commit) => commit.oid))
        : new Map<Oid, string>(),
    [snapshot.commits, shaShown],
  );
  const shaLength = useMemo(
    () =>
      [...short.values()].reduce(
        (longest, prefix) => Math.max(longest, prefix.length),
        SHORT_OID_MIN_LENGTH,
      ),
    [short],
  );

  function openColumnMenu(event: MouseEvent) {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, commit: null });
  }

  const [pick, setPick] = useState<{
    root: RepositoryRoot;
    oid: Oid;
  } | null>(null);

  function startCompare(next: Compare) {
    setPick(null);
    onCompare(next);
  }

  function clickRow(event: MouseEvent, row: HistoryRow) {
    const clicked = rowSelection(row);
    const anchor = compare?.anchor ?? selection;
    const modifier = mac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    const next =
      anchor !== null && modifier
        ? compareRows(snapshot.commits, snapshot.root, anchor, clicked)
        : null;
    if (next) startCompare(next);
    else onSelect(clicked);
    tableRef.current?.focus({ preventScroll: true });
  }

  function compareWithPick(oid: Oid) {
    if (!picked) return;
    const next = compareRows(
      snapshot.commits,
      snapshot.root,
      { kind: "commit", oid },
      { kind: "commit", oid: picked.oid },
    );
    if (next) startCompare(next);
  }

  function compareWithWorkingCopy(oid: Oid) {
    startCompare({
      root: snapshot.root,
      anchor: { kind: "commit", oid },
      base: oid,
      target: { kind: "worktree", root: snapshot.root },
    });
  }

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
    rowsRef.current = rows;
    rootRef.current = snapshot.root;
  });

  function rowShown(index: number): boolean {
    const scroller = scrollRef.current;
    if (!scroller) return false;
    const height = scroller.clientHeight - (headRef.current?.offsetHeight ?? 0);
    const rowTop = index * ROW_HEIGHT;
    return (
      rowTop + ROW_HEIGHT > scroller.scrollTop &&
      rowTop < scroller.scrollTop + height
    );
  }

  function revealCentered(index: number) {
    const scroller = scrollRef.current;
    if (index < 0 || !scroller || rowShown(index)) return;
    const height = scroller.clientHeight - (headRef.current?.offsetHeight ?? 0);
    scroller.scrollTop = index * ROW_HEIGHT + ROW_HEIGHT / 2 - height / 2;
    setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
  }

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (hidden || !scroller) return;
    const last = revealed.current;
    revealed.current = {
      root: snapshot.root,
      id: selectedId,
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
      selectedId === null ||
      (last.id === selectedId && last.seq === revealSeq)
    )
      return;
    revealCentered(rowsRef.current.findIndex((row) => row.id === selectedId));
  }, [snapshot.root, scrollTopOf, selectedId, revealSeq, hidden]);

  const ruleShown = useRef({ root: snapshot.root, rule });
  useLayoutEffect(() => {
    const last = ruleShown.current;
    ruleShown.current = { root: snapshot.root, rule };
    if (last.root === snapshot.root && last.rule !== rule)
      revealCentered(rows.findIndex((row) => row.id === selectedId));
  }, [snapshot.root, rule, rows, selectedId]);

  useLayoutEffect(
    function refocusWhenDiffCloses() {
      const shown = wasHidden.current && !hidden;
      wasHidden.current = hidden;
      if (shown && !document.activeElement?.closest(".sidebar, dialog"))
        tableRef.current?.focus({ preventScroll: true });
    },
    [hidden],
  );

  useEffect(() => {
    trail.current = null;
  }, [snapshot.root]);
  useEffect(() => {
    if (trail.current?.end !== selectedId) trail.current = null;
  }, [selectedId]);

  useImperativeHandle(ref, () => ({
    picked: () => picked?.oid ?? null,
    pick: (oid) => setPick(oid && { root: snapshot.root, oid }),
    compareWithPick,
    compareWithWorkingCopy,
    focus() {
      tableRef.current?.focus({ preventScroll: true });
    },
    openSearch() {
      const scroller = scrollRef.current;
      const atBottom =
        scroller !== null &&
        scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
      const selectedRow = rows.findIndex((row) => row.id === selectedId);
      const selectedShown = selectedRow >= 0 && rowShown(selectedRow);
      flushSync(() => {
        closeMenu();
        setSearch((open) => open ?? { root: snapshot.root, query: "" });
      });
      if (scroller) {
        if (atBottom) scroller.scrollTop = scroller.scrollHeight;
        if (selectedShown)
          scroller.scrollTop = revealRow(
            selectedRow,
            ROW_HEIGHT,
            scroller.scrollTop,
            scroller.clientHeight - (headRef.current?.offsetHeight ?? 0),
          );
        setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
      }
      searchInput.current?.focus();
      searchInput.current?.select();
    },
  }));

  function closeSearch() {
    setSearch(null);
    tableRef.current?.focus({ preventScroll: true });
  }

  function step(by: 1 | -1) {
    const oid = stepMatch(snapshot.commits, matches, selectedOid, by);
    if (oid === null) return;
    revealCentered(rows.findIndex((row) => row.id === oid));
    onSelect({ kind: "commit", oid });
  }

  function closeMenu() {
    setMenu(null);
    revealColumn(revealOnClose.current);
    revealOnClose.current = null;
  }

  function run(action: HistoryAction) {
    if (action === "open") return onOpenFirstFile();
    if (action === "cancel") {
      onCancelOpen();
      if (compare) onEndCompare();
      return;
    }
    if (action === "columns") {
      const header = headRef.current?.getBoundingClientRect();
      const pane = scrollRef.current?.getBoundingClientRect();
      const commit =
        selectedOid !== null && rows.some((row) => row.id === selectedOid)
          ? selectedOid
          : null;
      const row =
        commit &&
        document.getElementById(rowId(commit))?.getBoundingClientRect();
      if (header && pane)
        setMenu({
          x: pane.left + 14,
          y: row ? row.bottom : header.bottom,
          commit,
        });
      return;
    }
    const landing = landingFromHidden(
      snapshot.commits,
      known,
      historyPlace(selection, snapshot.worktrees),
      action,
    );
    const next =
      landing === null
        ? navigate(rows, graph.rows, selectedId, action, trail.current)
        : { id: landing, trail: null };
    trail.current = next.trail;
    const scroller = scrollRef.current;
    const index = rows.findIndex((row) => row.id === next.id);
    const row = rows[index];
    if (row === undefined || !scroller) return;
    const header = headRef.current?.offsetHeight ?? 0;
    scroller.scrollTop = revealRow(
      index,
      ROW_HEIGHT,
      scroller.scrollTop,
      scroller.clientHeight - header,
    );
    setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
    onSelect(rowSelection(row));
  }

  const first = Math.min(
    rows.length,
    Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN),
  );
  const last = Math.min(
    rows.length,
    Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
  );
  const visible = useMemo(() => rows.slice(first, last), [rows, first, last]);
  const visibleCommits = useMemo(
    () =>
      visibleColumns.has("changes")
        ? visible.flatMap((row) => (row.kind === "commit" ? [row.commit] : []))
        : NO_COMMITS,
    [visible, visibleColumns],
  );
  const lineStats = useLineStats(snapshot.root, visibleCommits);
  const graphWidth = Math.max(48, graph.lanes * 24 + 10);
  const layout = columnLayout(graphWidth, visibleColumns, shaLength);
  function revealColumn(id: ColumnId | null) {
    const index = layout.columns.findIndex((column) => column.id === id);
    const headerCells = headRef.current?.rows[0]?.cells;
    const cell =
      headerCells?.[headerCells.length - layout.columns.length + index];
    const scroller = scrollRef.current;
    if (index < 0 || !cell || !scroller) return;
    const { left, right } = cell.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const viewRight = view.left + scroller.clientWidth;
    if (right > viewRight) scroller.scrollLeft += right - viewRight;
    else if (left < view.left) scroller.scrollLeft -= view.left - left;
  }

  const active =
    selectedId !== null && visible.some((row) => row.id === selectedId)
      ? rowId(selectedId)
      : undefined;
  const menuCommit = menu?.commit ?? null;
  const picked =
    pick?.root === snapshot.root
      ? commits.find((commit) => commit.oid === pick.oid)
      : undefined;

  return (
    <section
      className="history"
      aria-label="Commit history"
      aria-busy={busy}
      hidden={hidden}
    >
      {search && (
        <HistorySearch
          inputRef={searchInput}
          query={query}
          count={matchCount(query, matches, selectedOid)}
          canStep={searching}
          onQuery={(next) => setSearch({ root: snapshot.root, query: next })}
          onStep={step}
          onClose={closeSearch}
        />
      )}
      <div className="history-scroll" ref={scrollRef}>
        <table
          ref={tableRef}
          className={`history-table${highlight || searching ? " highlighting" : ""}`}
          style={{ minWidth: layout.minWidth }}
          role="grid"
          tabIndex={0}
          aria-label="Commits"
          aria-rowcount={rows.length + 1}
          aria-activedescendant={active}
          onKeyDown={(event) => {
            const action = historyAction(event.nativeEvent);
            if (action === null) return;
            event.preventDefault();
            run(action);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              onCancelOpen();
          }}
        >
          <thead ref={headRef} onContextMenu={openColumnMenu}>
            <tr
              role="row"
              style={{ gridTemplateColumns: layout.template }}
              aria-rowindex={1}
            >
              <th role="columnheader" scope="col">
                Branch / Tag
              </th>
              <th role="columnheader" scope="col">
                Graph
              </th>
              <th role="columnheader" scope="col">
                Commit message
              </th>
              {layout.columns.map((column) => (
                <th
                  key={column.id}
                  role="columnheader"
                  scope="col"
                  className={
                    column.id === "changes" ? "changes-header" : undefined
                  }
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true" style={{ height: first * ROW_HEIGHT }} />
            )}
            {visible.map((entry, offset) => {
              const row = graph.rows.get(entry.id);
              const selected = selectedId === entry.id;
              const ring: Ring = selected
                ? "selected"
                : comparedId === entry.id
                  ? "compared"
                  : null;
              const isPick = picked?.oid === entry.id;
              const note =
                ring === "compared"
                  ? "Compared with the selected row"
                  : isPick
                    ? "Picked for comparison"
                    : null;
              const lit = searching
                ? entry.kind === "commit" && matches.has(entry.id)
                : highlight?.commits.has(entry.id);
              const rowProps = {
                id: rowId(entry.id),
                role: "row",
                className:
                  [
                    entry.kind === "worktree" && "worktree-row",
                    ring,
                    lit && "lit",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined,
                style: { gridTemplateColumns: layout.template },
                "aria-rowindex": first + offset + 2,
                "aria-selected": selected,
                onClick: (event: MouseEvent) => clickRow(event, entry),
                onContextMenu: (event: MouseEvent) => {
                  event.preventDefault();
                  if (!selected || compare) onSelect(rowSelection(entry));
                  setMenu({
                    x: event.clientX,
                    y: event.clientY,
                    commit: entry.kind === "commit" ? entry.commit.oid : null,
                  });
                },
              };
              const edges = searching
                ? NO_EDGES
                : highlight?.rows.get(entry.id);
              if (entry.kind === "worktree")
                return (
                  <tr key={entry.id} {...rowProps}>
                    <td role="gridcell" className="ref-cell">
                      {note && <span className="visually-hidden">{note}</span>}
                      <span className="ref-badges">
                        <span
                          className="ref-badge worktree"
                          style={{ background: color(row?.lane ?? 0) }}
                          title={entry.worktree.root}
                        >
                          <FolderGit2 size={11} />
                          <span className="ref-name">
                            {entry.worktree.name}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td role="gridcell">
                      {row && (
                        <GraphCell
                          row={row}
                          width={graphWidth}
                          known={known}
                          lit={edges}
                          parentDash={WORKTREE_DASH}
                        >
                          <WorktreeNode lane={row.lane} ring={ring} />
                        </GraphCell>
                      )}
                    </td>
                    <td role="gridcell">
                      <WorktreeDescription row={entry} />
                    </td>
                    {layout.columns.map((column) => (
                      <td
                        key={column.id}
                        role="gridcell"
                        className={
                          column.id === "changes" ? "changes-cell" : "text-cell"
                        }
                      />
                    ))}
                  </tr>
                );
              const commit = entry.commit;
              const [label, ...more] = labels.get(commit.oid) ?? [];
              return (
                <tr key={commit.oid} {...rowProps}>
                  <td role="gridcell" className="ref-cell">
                    {note && <span className="visually-hidden">{note}</span>}
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
                  <td role="gridcell">
                    {row && (
                      <GraphCell
                        row={row}
                        width={graphWidth}
                        known={known}
                        lit={edges}
                      >
                        <CommitNode
                          commit={commit}
                          lane={row.lane}
                          ring={ring}
                        />
                      </GraphCell>
                    )}
                  </td>
                  <td role="gridcell">
                    <button
                      className="commit-description"
                      tabIndex={-1}
                      aria-label={`${commit.subject}, ${commit.author}, ${commit.oid.slice(0, 7)}`}
                    >
                      {isPick && (
                        <Pin
                          className="pick-mark"
                          size={12}
                          aria-hidden="true"
                        />
                      )}
                      <span className="commit-subject" title={commit.subject}>
                        {commit.subject || "(no subject)"}
                      </span>
                    </button>
                  </td>
                  {layout.columns.map((column) => (
                    <Fragment key={column.id}>
                      {cells[column.id](commit, {
                        stats: lineStats.get(commit.oid),
                        shortOid: short.get(commit.oid) ?? commit.oid,
                        now,
                      })}
                    </Fragment>
                  ))}
                </tr>
              );
            })}
            {last < rows.length && (
              <tr
                aria-hidden="true"
                style={{ height: (rows.length - last) * ROW_HEIGHT }}
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menuCommit ? "Commit" : "History columns"}
          ignoreScrollIn={scrollRef}
          onClose={({ returnFocus }) => {
            closeMenu();
            if (returnFocus) tableRef.current?.focus({ preventScroll: true });
          }}
        >
          {menuCommit && (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  compareWithWorkingCopy(menuCommit);
                  closeMenu();
                  tableRef.current?.focus({ preventScroll: true });
                }}
              >
                <GitCompareArrows size={14} />
                <span>Compare with working copy</span>
              </button>
              {picked && picked.oid !== menuCommit && (
                <button
                  role="menuitem"
                  title={picked.subject}
                  onClick={() => {
                    compareWithPick(menuCommit);
                    closeMenu();
                    tableRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <GitCompareArrows size={14} />
                  <span>Compare with {picked.oid.slice(0, 7)}</span>
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  setPick(
                    picked?.oid === menuCommit
                      ? null
                      : { root: snapshot.root, oid: menuCommit },
                  );
                  closeMenu();
                  tableRef.current?.focus({ preventScroll: true });
                }}
              >
                <Pin size={14} />
                <span>
                  {picked?.oid === menuCommit
                    ? "Clear pick"
                    : "Pick for comparison"}
                </span>
              </button>
              <div className="menu-heading" role="presentation">
                Columns
              </div>
            </>
          )}
          {historyColumns.map((column) => {
            const checked = visibleColumns.has(column.id);
            return (
              <button
                key={column.id}
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => {
                  if (!checked) revealOnClose.current = column.id;
                  onToggleColumn(column.id);
                }}
              >
                <Check size={14} visibility={checked ? "visible" : "hidden"} />
                <span>{column.label}</span>
              </button>
            );
          })}
        </ContextMenu>
      )}
    </section>
  );
}

/** Worktree roots can hold spaces, which an `aria-activedescendant` ID cannot. */
function rowId(id: RowId): string {
  return `history-row-${encodeURIComponent(id)}`;
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
