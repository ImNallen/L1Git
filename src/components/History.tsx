import {
  Fragment,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, MouseEvent, ReactNode, Ref } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Check,
  Cherry,
  CircleCheck,
  Cloud,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCompareArrows,
  PencilLine,
  Pin,
  RotateCcw,
  Tag,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { mac } from "../repositories";
import { compareRows, comparedRowId } from "../domain/comparison";
import { replayEntry } from "../domain/merge";
import type { Compare } from "../domain/comparison";
import { diffstatBlocks } from "../domain/diffstat";
import type { GraphRow, RowId } from "../domain/graph";
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
import { changeSummary } from "../domain/worktree";
import type { HistoryRow, WorktreeRow } from "../domain/worktree";
import {
  SHORT_OID_MIN_LENGTH,
  shortOid,
  uniqueShortOids,
} from "../domain/shortOid";
import { shortRelativeTime } from "../domain/time";
import { branchVisibility } from "../domain/visibility";
import type {
  Commit,
  LineStats,
  Oid,
  RepositoryRoot,
} from "../domain/repository";
import { columnLayout, historyColumns } from "../historyColumns";
import type { ColumnId } from "../historyColumns";
import type { UserSelection } from "../shell/navigation";
import type {
  HistoryColumnsGroup,
  HistoryModel,
} from "../shell/useHistoryPane";
import type { CommitActions } from "../shell/useRefWrites";
import type { CommitReplay } from "../shell/useMergePanel";
import { useLineStats } from "../useLineStats";
import { ContextMenu } from "./ContextMenu";
import { HistorySearch } from "./HistorySearch";
import { MotionBoundary } from "./MotionBoundary";
import { useHistoryMotion } from "./historyMotion";

const ROW_HEIGHT = Math.round((838 / 22) * 64) / 64;
const ROW_CENTER = ROW_HEIGHT / 2;
const OVERSCAN = 10;
const HIGHLIGHT_DELAY = 400;
const color = (lane: number) => `var(--graph-lane-${(lane % 6) + 1})`;
const x = (lane: number) => 24 + lane * 24;
// Rows are separate SVGs at fractional offsets, so lane ends overlap the row edge to avoid antialiased seams.
const SEAM = 0.5;
const ROW_BOTTOM = ROW_HEIGHT + SEAM;
const continuation = (from: number, to: number) =>
  `M ${x(from)} ${-SEAM} V 0 C ${x(from)} ${ROW_CENTER}, ${x(to)} ${ROW_CENTER}, ${x(to)} ${ROW_HEIGHT} V ${ROW_BOTTOM}`;
const QUARTER_CIRCLE = 0.5523;
// A cubic, not an arc: history motion interpolates every number in a path, and arc flags are discrete.
const parent = (from: number, to: number) => {
  const turn = Math.sign(to - from) * ROW_CENTER;
  const handle = QUARTER_CIRCLE * ROW_CENTER;
  return `M ${x(from)} ${ROW_CENTER} H ${x(to) - turn} C ${x(to) - turn + Math.sign(turn) * handle} ${ROW_CENTER}, ${x(to)} ${ROW_HEIGHT - handle}, ${x(to)} ${ROW_HEIGHT} V ${ROW_BOTTOM}`;
};
const NO_COMMITS: readonly Commit[] = [];
const viewportOf = (scroller: HTMLElement) => ({
  top: scroller.scrollTop,
  height: scroller.clientHeight,
});
const indexOfRow = (rows: readonly { id: RowId }[], id: RowId | null) =>
  rows.findIndex((row) => row.id === id);
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
          data-graph-key={`continue:${edge.oid}`}
          data-graph-lane={edge.from}
          className={dim(lit?.continuations[index])}
          d={continuation(edge.from, edge.to)}
          color={color(edge.from)}
          stroke="currentColor"
        />
      ))}
      {row.incoming && (
        <path
          data-graph-key="incoming"
          data-graph-lane={row.lane}
          className={dim(lit?.incoming)}
          d={`M ${x(row.lane)} ${-SEAM} V ${ROW_CENTER}`}
          color={color(row.lane)}
          stroke="currentColor"
        />
      )}
      {row.parents.map((edge, index) => (
        <path
          key={edge.oid}
          data-graph-key={`parent:${edge.oid}`}
          data-graph-lane={edge.to}
          className={dim(lit?.parents[index])}
          d={parent(edge.from, edge.to)}
          color={color(edge.to)}
          stroke="currentColor"
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
      data-graph-key="ring"
      className="graph-selection-ring"
      cx={x(lane)}
      cy={ROW_CENTER}
      r={radius + 4}
      fill="none"
      stroke={color(lane)}
      strokeWidth={2}
      strokeDasharray={ring === "compared" ? "3 2" : undefined}
    />
  );
}

function WorktreeNode({ lane, ring }: { lane: number; ring: Ring }) {
  return (
    <g className="graph-node">
      <RowRing lane={lane} radius={5} ring={ring} />
      <circle
        data-graph-key="node"
        cx={x(lane)}
        cy={ROW_CENTER}
        r={5}
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
  const radius = merge ? 4 : 3;
  return (
    <g className="graph-node">
      <title>{`${commit.author} <${commit.email}>`}</title>
      <RowRing lane={lane} radius={radius} ring={ring} />
      {merge ? (
        <circle
          data-graph-key="node"
          cx={x(lane)}
          cy={ROW_CENTER}
          r={radius}
          fill="var(--canvas)"
          stroke={color(lane)}
          strokeWidth={2}
        />
      ) : (
        <circle
          data-graph-key="node"
          cx={x(lane)}
          cy={ROW_CENTER}
          r={radius}
          fill="var(--canvas)"
          stroke={color(lane)}
          strokeWidth={1.5}
        />
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
      className="commit-cell"
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
      <span className={`change-stat deleted${deleted === 0 ? " zero" : ""}`}>
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
    <TextCell
      className="author-cell"
      title={`${commit.author} <${commit.email}>`}
    >
      {commit.author}
    </TextCell>
  ),
  date: (commit, { now }) => (
    <TextCell
      className="date-cell"
      title={new Date(commit.timestamp * 1000).toLocaleString()}
    >
      {shortRelativeTime(commit.timestamp, now)}
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
      style={
        lane === null
          ? undefined
          : ({
              color: color(lane),
              "--badge-lane": color(lane),
            } as CSSProperties)
      }
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
        style={
          { color: color(lane), "--badge-lane": color(lane) } as CSSProperties
        }
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
  model: HistoryModel;
  selecting: UserSelection;
  revealSeq: number;
  columns: HistoryColumnsGroup;
  commitActions: CommitActions;
  commitReplay: CommitReplay;
  onOpenFirstFile: () => void;
  onCancelOpen: () => void;
  /** Where the history of `root` was scrolled when it was last shown. */
  scrollTopOf: (root: RepositoryRoot) => number;
  onScroll: (root: RepositoryRoot, scrollTop: number) => void;
  busy: boolean;
  hidden: boolean;
  onShowHistory: () => void;
  searchSlot: HTMLElement | null;
};

export function History({
  ref,
  model,
  selecting,
  revealSeq,
  columns,
  commitActions,
  commitReplay,
  onOpenFirstFile,
  onCancelOpen,
  scrollTopOf,
  onScroll,
  busy,
  hidden,
  onShowHistory,
  searchSlot,
}: Props) {
  const {
    snapshot,
    visibleCommits: commits,
    visibleOids: known,
    rows,
    graph,
    rule,
    trunk,
  } = model;
  const {
    selection,
    compare,
    select: onSelect,
    compareWith: onCompare,
    endCompare: onEndCompare,
  } = selecting;
  const { visible: visibleColumns, toggle: onToggleColumn } = columns;
  const { editableHead, onEditMessage, onNewBranch, onCreateTag, onCheckout } =
    commitActions;
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
    const measure = () => setViewport(viewportOf(scroller));
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

  const bodyHeight = (scroller: HTMLElement) =>
    scroller.clientHeight - (headRef.current?.offsetHeight ?? 0);

  function rowShown(index: number): boolean {
    const scroller = scrollRef.current;
    if (!scroller) return false;
    const height = bodyHeight(scroller);
    const rowTop = index * ROW_HEIGHT;
    return (
      rowTop + ROW_HEIGHT > scroller.scrollTop &&
      rowTop < scroller.scrollTop + height
    );
  }

  function revealCentered(index: number) {
    const scroller = scrollRef.current;
    if (index < 0 || !scroller || rowShown(index)) return;
    const height = bodyHeight(scroller);
    scroller.scrollTop = index * ROW_HEIGHT + ROW_HEIGHT / 2 - height / 2;
    setViewport(viewportOf(scroller));
  }
  const revealFromEffect = useEffectEvent(revealCentered);

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
      setViewport(viewportOf(scroller));
      return;
    }
    if (
      selectedId === null ||
      (last.id === selectedId && last.seq === revealSeq)
    )
      return;
    revealFromEffect(indexOfRow(rowsRef.current, selectedId));
  }, [snapshot.root, scrollTopOf, selectedId, revealSeq, hidden]);

  const ruleShown = useRef({ root: snapshot.root, rule });
  useLayoutEffect(() => {
    const last = ruleShown.current;
    ruleShown.current = { root: snapshot.root, rule };
    if (last.root === snapshot.root && last.rule !== rule)
      revealFromEffect(indexOfRow(rows, selectedId));
  }, [snapshot.root, rule, rows, selectedId]);

  useLayoutEffect(
    function refocusWhenDiffCloses() {
      const shown = wasHidden.current && !hidden;
      wasHidden.current = hidden;
      if (
        shown &&
        !document.activeElement?.closest(".sidebar, dialog, .history-search")
      )
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
      const selectedRow = indexOfRow(rows, selectedId);
      const selectedShown = selectedRow >= 0 && rowShown(selectedRow);
      flushSync(() => {
        onShowHistory();
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
            bodyHeight(scroller),
          );
        setViewport(viewportOf(scroller));
      }
      searchInput.current?.focus();
      searchInput.current?.select();
    },
  }));

  function closeSearch() {
    setSearch(null);
    if (!hidden) tableRef.current?.focus({ preventScroll: true });
  }

  function step(by: 1 | -1) {
    flushSync(onShowHistory);
    const oid = stepMatch(snapshot.commits, matches, selectedOid, by);
    if (oid === null) return;
    revealCentered(indexOfRow(rows, oid));
    onSelect({ kind: "commit", oid });
  }

  function closeMenu() {
    setMenu(null);
    revealColumn(revealOnClose.current);
    revealOnClose.current = null;
  }

  function returnToTable() {
    closeMenu();
    tableRef.current?.focus({ preventScroll: true });
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
    const index = indexOfRow(rows, next.id);
    const row = rows[index];
    if (row === undefined || !scroller) return;
    scroller.scrollTop = revealRow(
      index,
      ROW_HEIGHT,
      scroller.scrollTop,
      bodyHeight(scroller),
    );
    setViewport(viewportOf(scroller));
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
  const graphWidth = Math.max(80, graph.lanes * 24 + 24);
  const layout = columnLayout(graphWidth, visibleColumns, shaLength);
  const selectionPaint = useRef<HTMLDivElement>(null);
  const rowMotion = useHistoryMotion(
    {
      root: snapshot.root,
      rows,
      graph,
      selected: selectedId,
      template: layout.template,
      hidden,
    },
    scrollRef,
    selectionPaint,
  );
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
      {searchSlot &&
        createPortal(
          <HistorySearch
            inputRef={searchInput}
            query={query}
            count={matchCount(query, matches, selectedOid)}
            canStep={searching}
            onQuery={(next) => {
              flushSync(onShowHistory);
              setSearch({ root: snapshot.root, query: next });
            }}
            onStep={step}
            onClose={closeSearch}
          />,
          searchSlot,
        )}
      <h2 className="history-heading">{snapshot.name} commits</h2>
      <div className="history-scroll" ref={scrollRef}>
        <MotionBoundary {...rowMotion} />
        <div
          ref={selectionPaint}
          className="history-selection"
          aria-hidden="true"
          hidden
        />
        <table
          ref={tableRef}
          className={`history-table${highlight || searching ? " highlighting" : ""}`}
          style={
            {
              minWidth: layout.minWidth + 48,
              "--history-row-height": `${ROW_HEIGHT}px`,
            } as CSSProperties
          }
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
                Graph
              </th>
              <th role="columnheader" scope="col">
                Commit
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
                "data-motion-row": entry.id,
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
                    <td role="gridcell" className="graph-column">
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
                    <td role="gridcell" className="message-cell">
                      {note && <span className="visually-hidden">{note}</span>}
                      <span className="ref-badges">
                        <span
                          className="ref-badge worktree"
                          style={{ color: color(row?.lane ?? 0) }}
                          title={entry.worktree.root}
                        >
                          <FolderGit2 size={11} />
                          <span className="ref-name">
                            {entry.worktree.name}
                          </span>
                        </span>
                      </span>

                      <WorktreeDescription row={entry} />
                    </td>
                    {layout.columns.map((column) => (
                      <td
                        key={column.id}
                        role="gridcell"
                        className={
                          column.id === "changes"
                            ? "changes-cell"
                            : `text-cell ${column.id}-cell`
                        }
                      />
                    ))}
                  </tr>
                );
              const commit = entry.commit;
              const [label, ...more] = labels.get(commit.oid) ?? [];
              return (
                <tr key={commit.oid} {...rowProps}>
                  <td role="gridcell" className="graph-column">
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
                  <td role="gridcell" className="message-cell">
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

                    <button
                      className="commit-cell"
                      tabIndex={-1}
                      aria-label={`${commit.subject}, ${commit.author}, ${shortOid(commit.oid)}`}
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
              This repository has no commit history yet. Select its worktree,
              stage files, and commit them in the inspector.
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
                  returnToTable();
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
                    returnToTable();
                  }}
                >
                  <GitCompareArrows size={14} />
                  <span>Compare with {shortOid(picked.oid)}</span>
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
                  returnToTable();
                }}
              >
                <Pin size={14} />
                <span>
                  {picked?.oid === menuCommit
                    ? "Clear pick"
                    : "Pick for comparison"}
                </span>
              </button>
              {!(
                snapshot.head.kind === "detached" &&
                snapshot.head.oid === menuCommit
              ) && (
                <button
                  role="menuitem"
                  onClick={() => {
                    returnToTable();
                    onCheckout(menuCommit);
                  }}
                >
                  <GitCommitHorizontal size={14} />
                  <span>Check out this commit…</span>
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  returnToTable();
                  onNewBranch(menuCommit);
                }}
              >
                <GitBranchPlus size={14} />
                <span>New branch…</span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  returnToTable();
                  onCreateTag(menuCommit);
                }}
              >
                <Tag size={14} />
                <span>Create tag…</span>
              </button>
              {(
                [
                  ["cherryPick", Cherry],
                  ["revert", RotateCcw],
                ] as const
              ).map(([kind, Icon]) => (
                <button
                  key={kind}
                  role="menuitem"
                  aria-disabled={commitReplay.disabled}
                  onClick={() => {
                    if (commitReplay.disabled) return;
                    returnToTable();
                    commitReplay.onReview({ kind, commit: menuCommit });
                  }}
                >
                  <Icon size={14} />
                  <span>{replayEntry(kind, commitReplay.branch)}</span>
                  {commitReplay.disabled && (
                    <small className="menu-reason">
                      Wait for pending work, and finish any operation in this
                      worktree.
                    </small>
                  )}
                </button>
              ))}
              {menuCommit === editableHead && (
                <button
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    onEditMessage();
                  }}
                >
                  <PencilLine size={14} />
                  <span>Edit message…</span>
                </button>
              )}
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
