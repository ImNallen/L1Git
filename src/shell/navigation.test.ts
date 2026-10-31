import { describe, expect, it } from "vitest";
import type { FullRef, Oid } from "../domain/repository";
import { C3, C4, C5, OLD, PIN, pinSnapshot } from "../test/fixtures";
import { jumpView } from "./navigation";

const snapshot = pinSnapshot();
const all = new Set(snapshot.commits.map((commit) => commit.oid));
const feature = "refs/heads/feature" as FullRef;
const base = {
  snapshot,
  jump: null,
  lastBranch: new Map([[PIN, feature]]),
  sidebarJump: { root: PIN, reference: feature },
  selection: { kind: "commit" as const, oid: C5 },
  loaded: all,
  visibleOids: all,
};

describe("jumpView", () => {
  it("highlights the last jumped branch once it is selected and rules it", () => {
    const view = jumpView(base);
    expect(view.jumped?.reference).toBe(feature);
    expect(view.highlighted).toBe(true);
    expect(view.ruledBranch?.reference).toBe(feature);
    expect(view.hiddenJump).toBeNull();
    expect(view.sidebarTag).toBeNull();
  });

  it("suppresses the jumped ref while a jump to this repository is pending", () => {
    const view = jumpView({
      ...base,
      jump: { root: PIN, reference: feature, seq: 1, pending: true },
    });
    expect(view.jumped).toBeNull();
    expect(view.ruledBranch).toBeNull();
  });

  it("calls a loaded ref outside the visible commits hidden, and an older one unloaded", () => {
    const hidden = jumpView({
      ...base,
      selection: null,
      visibleOids: new Set<Oid>([C4]),
    });
    expect(hidden.hiddenJump?.reference).toBe(feature);
    expect(hidden.jumpedUnloaded).toBe(false);
    expect(hidden.ruledBranch?.reference).toBe(feature);

    const old = "refs/heads/old" as FullRef;
    const unloaded = jumpView({
      ...base,
      lastBranch: new Map([[PIN, old]]),
      sidebarJump: { root: PIN, reference: old },
      selection: { kind: "commit", oid: OLD },
    });
    expect(unloaded.jumpedUnloaded).toBe(true);
    expect(unloaded.hiddenJump).toBeNull();
  });

  it("rules a branch only while it is highlighted or hidden", () => {
    const view = jumpView({
      ...base,
      selection: { kind: "commit", oid: C4 },
      sidebarJump: null,
    });
    expect(view.jumped?.reference).toBe(feature);
    expect(view.highlighted).toBe(false);
    expect(view.ruledBranch).toBeNull();
  });

  it("a jumped tag is the sidebar tag and never the ruled branch", () => {
    const v1 = "refs/tags/v1" as FullRef;
    const view = jumpView({
      ...base,
      lastBranch: new Map([[PIN, v1]]),
      sidebarJump: { root: PIN, reference: v1 },
      selection: { kind: "commit", oid: C3 },
    });
    expect(view.sidebarTag?.reference).toBe(v1);
    expect(view.highlighted).toBe(true);
    expect(view.ruledBranch).toBeNull();
  });
});
