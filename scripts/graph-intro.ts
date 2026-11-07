import {
  act,
  back,
  check,
  command,
  context,
  openCode,
  requireElement,
  rows,
  scroller,
  until,
  wait,
} from "./table-motion";

const SAMPLES = [50, 100, 200, 340, 660, 880, 1000, 1100];
const PAST_RING_APPEAR_MS = 260;

const delayedAnimations = (scope: Document = document) =>
  scope.getAnimations().filter((animation) => {
    const effect = animation.effect as KeyframeEffect | null;
    return (
      Number(effect?.getTiming().delay) > 0 &&
      !!effect?.target?.closest(".history-scroll")
    );
  });
const targets = (animations: readonly Animation[]) =>
  animations.map((item) => (item.effect as KeyframeEffect).target);
const close = (
  actual: number,
  expected: number,
  label: string,
  within = 0.01,
) =>
  check(
    Math.abs(actual - expected) <= within,
    `${label}: expected ${expected}, read ${actual}`,
  );
const opacity = (element: Element) => Number(getComputedStyle(element).opacity);
function easeOut(progress: number) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step++) {
    const t = (low + high) / 2;
    if (3 * (1 - t) * t * t * 0.58 + t * t * t < progress) low = t;
    else high = t;
  }
  return 3 * low * low - 2 * low * low * low;
}
const ramp = (time: number, from: number, start: number, end: number) =>
  from + (1 - from) * easeOut((time - start) / (end - start));

function repository(name: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(".repository-open"),
  ].find((entry) => entry.title.split("/").pop() === name);
  if (!button) throw new Error(`Missing saved repository ${name}`);
  return button;
}
const shown = (name: string) =>
  repository(name).getAttribute("aria-current") === "true";
const select = (name: string) => act(() => repository(name).click());
async function settle() {
  for (const animation of delayedAnimations()) animation.finish();
  await wait(50);
  check(delayedAnimations().length === 0, "No intro left before the next step");
}
async function switchTo(name: string) {
  await settle();
  select(name);
  await until(() => shown(name) && delayedAnimations().length > 0);
  return delayedAnimations();
}
function freeze(animations: readonly Animation[]) {
  for (const animation of animations) animation.pause();
  return (time: number) => {
    for (const animation of animations) animation.currentTime = time;
  };
}
function checkRest(label: string) {
  check(
    delayedAnimations().length === 0,
    `${label}: no intro animations remain`,
  );
  const scroll = scroller();
  check(
    scroll.querySelectorAll(
      '[style*="opacity"],[style*="stroke-dash"],[style*="transform"]',
    ).length === 0,
    `${label}: no inline animation styles remain`,
  );
  for (const cell of scroll.querySelectorAll("td"))
    check(opacity(cell) === 1, `${label}: cells rest at full opacity`);
  for (const node of scroll.querySelectorAll('[data-graph-key="node"]'))
    check(opacity(node) === 1, `${label}: nodes rest at full opacity`);
  for (const path of scroll.querySelectorAll("path[data-graph-lane]")) {
    const style = getComputedStyle(path);
    check(
      Number.parseFloat(style.strokeDashoffset) === 0,
      `${label}: lanes rest fully drawn`,
    );
    if (!path.hasAttribute("stroke-dasharray"))
      check(style.strokeDasharray === "none", `${label}: lanes rest solid`);
  }
  const paint = scroll.querySelector(".history-selection");
  if (paint) check(opacity(paint) === 1, `${label}: selection rests opaque`);
  const ring = scroll.querySelector('[data-graph-key="ring"]');
  if (ring)
    check(
      getComputedStyle(ring).transform === "none",
      `${label}: ring rests untransformed`,
    );
  check(
    !document.querySelector("[data-motion-exit]"),
    `${label}: exit paint expires`,
  );
}
async function rest(label: string) {
  await settle();
  await wait(300);
  checkRest(label);
}

type Segment = { path: SVGPathElement; top: number; bottom: number };
function lanes(tracked: ReadonlySet<EventTarget | null>) {
  const byLane = new Map<number, Segment[]>();
  for (const row of rows()) {
    const rowTop = row.getBoundingClientRect().top;
    for (const path of row.querySelectorAll<SVGPathElement>(
      "path[data-graph-lane]",
    )) {
      if (!tracked.has(path)) continue;
      const box = path.getBBox();
      const lane = Number(path.dataset.graphLane);
      byLane.set(lane, [
        ...(byLane.get(lane) ?? []),
        { path, top: rowTop + box.y, bottom: rowTop + box.y + box.height },
      ]);
    }
  }
  return [...byLane].sort(([a], [b]) => a - b).map(([, segments]) => segments);
}
function drawn(path: SVGPathElement) {
  if (path.hasAttribute("stroke-dasharray")) return opacity(path);
  const style = getComputedStyle(path);
  if (style.strokeDasharray === "none") return 1;
  return 1 - Number.parseFloat(style.strokeDashoffset) / path.getTotalLength();
}

async function checkTimeline(name: string) {
  const animations = await switchTo(name);
  const seek = freeze(animations);
  const tracked = new Set(targets(animations));
  const selected = requireElement<HTMLElement>("tr.selected");
  const ring = requireElement<SVGElement>('[data-graph-key="ring"]', selected);
  seek(50);
  const fresh = ring
    .getAnimations()
    .some((animation) => animation instanceof CSSAnimation);
  close(opacity(ring), 0, "ring is held by the intro over its CSS appear");
  await wait(PAST_RING_APPEAR_MS);
  check(
    delayedAnimations().length === animations.length,
    "A fresh read keeps every track",
  );
  const paint = requireElement<HTMLElement>(".history-selection");
  const nodes = [
    ...scroller().querySelectorAll<SVGElement>('[data-graph-key="node"]'),
  ].filter((node) => tracked.has(node));
  const cells = [
    ...scroller().querySelectorAll<HTMLElement>("tbody td:not(.graph-column)"),
  ].filter((cell) => tracked.has(cell));
  check(
    nodes.length > 0 && cells.length > 0,
    "The intro tracks cells and nodes",
  );
  const graphCell = requireElement<HTMLElement>("tbody td.graph-column");
  const trace: Record<string, number>[] = [];
  const centre = (time: number) => {
    seek(time);
    const box = ring.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const restCentre = centre(1100);
  for (const time of SAMPLES) {
    seek(time);
    close(
      opacity(requireElement("td:not(.graph-column)", selected)),
      ramp(time, 0.65, 100, 320),
      `cell at ${time}`,
    );
    for (const cell of cells)
      close(opacity(cell), ramp(time, 0.65, 100, 320), `every cell at ${time}`);
    check(opacity(graphCell) === 1, "The graph column itself never fades");
    for (const node of nodes)
      close(opacity(node), ramp(time, 0, 100, 280), `every node at ${time}`);
    close(opacity(paint), ramp(time, 0, 700, 880), `selection at ${time}`);
    close(opacity(ring), ramp(time, 0, 700, 880), `ring opacity at ${time}`);
    const scale = new DOMMatrix(getComputedStyle(ring).transform).a;
    const expected =
      time <= 700
        ? 0.75
        : time <= 900
          ? 0.75 + 0.37 * easeOut((time - 700) / 200)
          : time < 1080
            ? 1.12 - 0.12 * easeOut((time - 900) / 180)
            : 1;
    close(scale, expected, `ring scale at ${time}`);
    trace.push({ time, cell: opacity(cells[0] as Element), scale });
  }
  seek(900);
  close(new DOMMatrix(getComputedStyle(ring).transform).a, 1.12, "overshoot");
  seek(899);
  check(
    new DOMMatrix(getComputedStyle(ring).transform).a > 1,
    "The ring overshoots above 1 near 900",
  );
  const overshootCentre = centre(900);
  close(overshootCentre.x, restCentre.x, "ring scales around its x", 0.5);
  close(overshootCentre.y, restCentre.y, "ring scales around its y", 0.5);
  seek(1000);
  check(
    new DOMMatrix(getComputedStyle(ring).transform).a > 1,
    "The ring is still settling at 1000",
  );

  const graph = lanes(tracked);
  const step = graph.length > 1 ? Math.min(80, 160 / (graph.length - 1)) : 0;
  const windows: [number, number][] = [];
  for (const [rank, segments] of graph.entries()) {
    const ordered = [...segments].sort(
      (a, b) => a.top - b.top || a.bottom - b.bottom,
    );
    const first = ordered[0]?.path;
    const last = [...ordered].sort((a, b) => b.bottom - a.bottom)[0]?.path;
    if (!first || !last) continue;
    const start = 100 + rank * step;
    windows.push([start, start + 480]);
    seek(start - 1);
    close(drawn(first), 0, `lane ${rank} holds before ${start}`);
    close(drawn(last), 0, `lane ${rank} end holds before ${start}`);
    seek(start + 12);
    check(drawn(first) > 0, `lane ${rank} starts drawing at ${start}`);
    seek(start + 465);
    check(drawn(last) < 1, `lane ${rank} is still drawing before its end`);
    seek(start + 481);
    close(drawn(last), 1, `lane ${rank} is drawn by ${start + 480}`);
    seek(start + 60);
    for (const a of ordered)
      for (const b of ordered)
        if (a.bottom <= b.top)
          check(
            drawn(a.path) >= drawn(b.path) - 0.001,
            `lane ${rank} draws from its top down`,
          );
    check(
      ordered.length < 3 || drawn(first) > drawn(last),
      `lane ${rank} is part way down its span at ${start + 60}`,
    );
    if (rank > 0) {
      const earlier = graph[rank - 1]?.[0]?.path;
      seek(start - 1);
      if (earlier)
        check(
          drawn(earlier) > drawn(first),
          `lane ${rank} runs behind lane ${rank - 1}`,
        );
    }
  }
  const dashed = [
    ...scroller().querySelectorAll<SVGPathElement>(
      "path[data-graph-lane][stroke-dasharray]",
    ),
  ].filter((path) => tracked.has(path));
  seek(380);
  for (const path of dashed) {
    const pattern = path.getAttribute("stroke-dasharray") ?? "";
    check(
      getComputedStyle(path)
        .strokeDasharray.replaceAll("px", "")
        .replace(",", "") === pattern,
      "A dashed edge keeps its pattern",
    );
  }
  for (const animation of animations) animation.finish();
  await wait(50);
  checkRest(`${name} after its timeline`);
  return {
    name,
    fresh,
    lanes: graph.length,
    windows,
    dashed: dashed.length,
    trace,
  };
}

async function runWithDelayedRead(name: string) {
  const realFetch = window.fetch;
  let landed = 0;
  let requested = false;
  window.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    if (
      typeof init?.body === "string" &&
      JSON.parse(init.body).op === "snapshot"
    ) {
      requested = true;
      await wait(300);
      landed = performance.now();
    }
    return response;
  };
  try {
    const started = performance.now();
    const animations = await switchTo(name);
    const paint = requireElement<HTMLElement>(".history-selection");
    const opacities: number[] = [];
    const end = Promise.allSettled(animations.map((item) => item.finished));
    let done = false;
    void end.then(() => (done = true));
    while (!done) {
      opacities.push(opacity(paint));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const results = await end;
    const finished = performance.now();
    check(requested && landed > 0, "The fresh read really ran");
    check(landed < finished, "The fresh read landed during the intro");
    check(
      results.every((result) => result.status === "fulfilled"),
      `The fresh read must not cancel the intro: ${results.filter((result) => result.status === "rejected").length} of ${results.length} tracks cancelled`,
    );
    check(
      opacities.slice(0, 10).every((value) => value === 0),
      "The selection stays hidden until its window",
    );
    await wait(300);
    checkRest(`${name} after a natural run`);
    return { name, ms: finished - started, landedMs: landed - started };
  } finally {
    window.fetch = realFetch;
  }
}

async function noReplay(label: string, action: () => void | Promise<void>) {
  await settle();
  const history = requireElement<HTMLElement>(".history");
  let played = 0;
  let watching = true;
  const watch = () => {
    played += delayedAnimations().length;
    if (watching) requestAnimationFrame(watch);
  };
  watch();
  await action();
  await wait(400);
  watching = false;
  check(played === 0, `${label} must not replay the intro`);
  check(
    history === document.querySelector(".history"),
    `${label} must keep History mounted`,
  );
  check(delayedAnimations().length === 0, `${label} leaves nothing running`);
}

async function checkNoReplay() {
  const realFetch = window.fetch;
  let snapshots = 0;
  window.fetch = (input, init) => {
    if (
      typeof init?.body === "string" &&
      JSON.parse(init.body).op === "snapshot"
    )
      snapshots++;
    return realFetch(input, init);
  };
  try {
    await wait(1100);
    await noReplay("A same-root refresh", () => {
      window.dispatchEvent(new Event("focus"));
    });
    check(snapshots > 0, "The same-root refresh really read the repository");
  } finally {
    window.fetch = realFetch;
  }
  await noReplay("A selection change", () =>
    act(() => (rows()[2] as HTMLElement).click()),
  );
  await noReplay("A solo rule", async () => {
    context();
    await wait(100);
    command("Solo");
  });
  await noReplay("Clearing the rule", async () => {
    context();
    await wait(100);
    command("Show all branches");
  });
  await noReplay("A column change", async () => {
    const header = requireElement<HTMLElement>(".history-table thead");
    const toggle = () => {
      act(() =>
        header.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: 600,
            clientY: 120,
          }),
        ),
      );
      const author = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemcheckbox"]',
        ),
      ].find((item) => item.textContent?.includes("Author"));
      if (!author) throw new Error("Missing Author column toggle");
      act(() => author.click());
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    };
    toggle();
    await wait(150);
    toggle();
  });
  await noReplay("Returning from a diff", async () => {
    await openCode();
    await wait(300);
    back();
  });
  await noReplay("Opening and closing Settings", async () => {
    act(() =>
      requireElement<HTMLButtonElement>(
        '.sidebar button[aria-label="Settings"]',
      ).click(),
    );
    await until(() => !!document.querySelector("dialog.settings-dialog"));
    await wait(150);
    const dialog = requireElement<HTMLDialogElement>("dialog.settings-dialog");
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    if (document.querySelector("dialog.settings-dialog"))
      dialog.dispatchEvent(new Event("cancel"));
    await until(() => !document.querySelector("dialog.settings-dialog"));
  });
  await wait(300);
  checkRest("After the no-replay journey");
}

async function checkScroll(tall: string, other: string) {
  if (shown(tall)) await switchTo(other);
  await switchTo(tall);
  await settle();
  check(
    scroller().scrollHeight > scroller().clientHeight + 40,
    "Run the scroll checks in a short window",
  );
  scroller().scrollTop = 0;
  await wait(100);
  await switchTo(other);
  const running = await switchTo(tall);
  check(running.length > 0, "The intro is running before the scroll");
  scroller().scrollTop = 30;
  await wait(100);
  check(delayedAnimations().length === 0, "Scrolling cancels the intro");
  await wait(300);
  checkRest("After scrolling");

  scroller().scrollTop = 30;
  await wait(100);
  await switchTo(other);
  const restored = await switchTo(tall);
  const seek = freeze(restored);
  seek(50);
  check(scroller().scrollTop === 30, "The scroll position is restored");
  await wait(200);
  check(
    delayedAnimations().length === restored.length,
    "Restoring the scroll position must not cancel the intro",
  );
  for (const animation of restored) animation.finish();
  await wait(50);
  checkRest("After a restored scroll");
  scroller().scrollTop = 0;
  await wait(100);
}

async function checkResize(name: string, other: string) {
  await switchTo(shown(name) ? other : name);
  window.dispatchEvent(new Event("resize"));
  await wait(50);
  check(delayedAnimations().length === 0, "A window resize stops the intro");
  await wait(300);
  checkRest("After a resize");
}

async function checkRapid(first: string, second: string) {
  await settle();
  let doubled = 0;
  let name = shown(first) ? second : first;
  for (let turn = 0; turn < 8; turn++) {
    select(name);
    name = name === first ? second : first;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const running = targets(delayedAnimations());
    doubled += running.length - new Set(running).size;
  }
  check(doubled === 0, "One element never carries two intros");
  await until(() => delayedAnimations().length > 0);
  await wait(1400);
  checkRest("After rapid switches");
}

async function checkDissolve(from: string, to: string) {
  const seek = freeze(await switchTo(from));
  await wait(PAST_RING_APPEAR_MS);
  seek(300);
  const scroll = scroller();
  const read = (root: Element) => ({
    paths: [...root.querySelectorAll("path")].map((path) => {
      const style = getComputedStyle(path);
      return {
        offset: style.strokeDashoffset,
        dash: style.strokeDasharray,
        opacity: style.opacity,
      };
    }),
    cells: [...root.querySelectorAll("td")].map(
      (cell) => getComputedStyle(cell).opacity,
    ),
    circles: [...root.querySelectorAll("circle")].map(
      (circle) => getComputedStyle(circle).opacity,
    ),
  });
  const before = read(scroll);
  const trimmed = before.paths.filter(
    (path) => Number.parseFloat(path.offset) > 0,
  ).length;
  check(trimmed > 0, "Lanes are part drawn at 300");
  select(to);
  const dissolvingPanes = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-motion-exit="repository"]',
      ),
    ].find((layer) => layer.querySelector("td"));
  await until(() => !!dissolvingPanes());
  const pane = requireElement<HTMLElement>(".workspace-panes");
  const fades = pane
    .getAnimations()
    .filter((animation) => animation.effect?.getTiming().duration === 170);
  const after = read(dissolvingPanes() as HTMLElement);
  check(
    after.paths.length === before.paths.length,
    `The dissolve copies every lane segment: ${after.paths.length} of ${before.paths.length}`,
  );
  const jumped = after.paths.filter(
    (path, index) =>
      path.offset !== before.paths[index]?.offset ||
      path.dash !== before.paths[index]?.dash,
  ).length;
  check(
    jumped === 0,
    `The dissolve must keep part-drawn lanes: ${jumped} of ${after.paths.length} segments jumped to rest`,
  );
  check(
    JSON.stringify(after.cells) === JSON.stringify(before.cells),
    "The dissolve keeps the row opacity",
  );
  check(
    JSON.stringify(after.circles) === JSON.stringify(before.circles),
    "The dissolve keeps the node opacity",
  );
  check(fades.length === 1, "The repository fade runs on the panes");
  await until(() => shown(to) && delayedAnimations().length > 0);
  check(!!dissolvingPanes(), "The new intro plays under the dissolve");
  const composite = {
    pane: opacity(pane),
    cell: opacity(requireElement("tbody td:not(.graph-column)", scroll)),
  };
  await rest("After a switch mid-intro");
  return { trimmed, segments: after.paths.length, composite };
}

async function checkInterrupted(name: string, other: string) {
  if (shown(name)) await switchTo(other);
  freeze(await switchTo(name));
  context();
  await wait(50);
  command("Solo");
  await until(() => delayedAnimations().length === 0);
  await wait(300);
  checkRest("After a rule rewrote the graph mid-intro");
  context();
  await wait(50);
  command("Show all branches");
  await wait(300);

  freeze(await switchTo(other));
  freeze(await switchTo(name));
  await openCode();
  check(delayedAnimations().length === 0, "Opening a diff stops the intro");
  await wait(300);
  await noReplay("Returning from a diff opened mid-intro", back);
  await wait(300);
  checkRest("After a diff opened mid-intro");
}

async function checkUncachedMount(name: string) {
  await settle();
  const old = requireElement<HTMLElement>(".history");
  select(name);
  await until(
    () =>
      shown(name) &&
      document.querySelector(".history") !== old &&
      delayedAnimations().length > 0,
  );
  const tracks = delayedAnimations().length;
  await rest("After mounting History");
  return { tracks };
}

async function clearRules() {
  context();
  await wait(50);
  const reset = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((item) => item.textContent?.trim() === "Show all branches");
  if (reset) act(() => reset.click());
  else
    act(() =>
      requireElement<HTMLElement>('[role="menu"]').dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
  await wait(300);
}

export async function verifyGraphIntro(first: string, second: string) {
  check(
    !matchMedia("(prefers-reduced-motion: reduce)").matches,
    "Run normal motion before reduced-motion checks",
  );
  await clearRules();
  const away = () => (shown(first) ? second : first);
  const timeline = [await checkTimeline(away()), await checkTimeline(away())];
  const natural = [
    await runWithDelayedRead(away()),
    await runWithDelayedRead(away()),
  ];
  await checkNoReplay();
  await checkResize(first, second);
  await checkRapid(first, second);
  await checkInterrupted(first, second);
  const from = away();
  const dissolve = await checkDissolve(from, from === first ? second : first);
  return { timeline, natural, dissolve };
}

export async function verifyGraphIntroScroll(tall: string, other: string) {
  await checkScroll(tall, other);
  return { passed: true };
}

export async function verifyGraphIntroFirstLoad() {
  const frame = document.createElement("iframe");
  frame.style.cssText =
    "position:fixed;left:0;top:0;width:1440px;height:900px;border:0;z-index:99999";
  frame.src = location.href;
  document.body.append(frame);
  try {
    await until(
      () =>
        !!frame.contentDocument &&
        delayedAnimations(frame.contentDocument).length > 0,
    );
    const scope = frame.contentDocument as Document;
    const tracks = delayedAnimations(scope);
    const running = targets(tracks);
    check(
      new Set(running).size === running.length,
      "Strict Mode's second effect run plays one intro",
    );
    const results = await Promise.allSettled(
      tracks.map((item) => item.finished),
    );
    check(
      results.every((result) => result.status === "fulfilled"),
      "The reads that follow a first load must not cancel the intro",
    );
    await wait(100);
    check(
      delayedAnimations(scope).length === 0,
      "Nothing is left after a first load",
    );
    return { tracks: tracks.length };
  } finally {
    frame.remove();
  }
}

export async function verifyGraphIntroMount(first: string, second: string) {
  return await checkUncachedMount(shown(first) ? second : first);
}

export async function verifyReducedGraphIntro(first: string, second: string) {
  check(
    matchMedia("(prefers-reduced-motion: reduce)").matches,
    "Enable reduced motion first",
  );
  let played = 0;
  let watching = true;
  const watch = () => {
    played += delayedAnimations().length;
    if (watching) requestAnimationFrame(watch);
  };
  watch();
  select(shown(first) ? second : first);
  await wait(300);
  select(shown(first) ? second : first);
  await wait(300);
  watching = false;
  check(played === 0, "Reduced motion plays no intro");
  checkRest("Reduced motion");
  return { passed: true };
}

export async function startGraphIntro(first: string, second: string) {
  await switchTo(shown(first) ? second : first);
  return delayedAnimations().length;
}

export function runningGraphIntro() {
  return { running: delayedAnimations().length };
}

export function checkGraphIntroRest() {
  checkRest("After reduced motion turned on");
  return { passed: true };
}
