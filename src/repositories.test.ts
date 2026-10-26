import { afterEach, describe, expect, it, vi } from "vitest";
import { singleCommit } from "./domain/comparison";
import { oidSchema, problemFrom, rootSchema } from "./domain/repository";

const invoke = vi.fn();
const fetch = vi.fn();
const root = rootSchema.parse("/work/l1-demo");
const oid = oidSchema.parse("a".repeat(40));
const stats = [{ oid, added: 4, deleted: 2 }];

async function load(native: boolean) {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ isTauri: () => native, invoke }));
  vi.stubGlobal("fetch", fetch);
  return import("./repositories");
}

function reply(status: number, body: unknown) {
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  invoke.mockReset();
  fetch.mockReset();
  vi.unstubAllGlobals();
});

describe("native transport", () => {
  it("sends one repository_run request and returns the matching data", async () => {
    const { lineStats } = await load(true);
    invoke.mockResolvedValueOnce({ op: "lineStats", data: stats });
    expect(await lineStats(root, [oid])).toEqual(stats);
    expect(invoke).toHaveBeenCalledWith("repository_run", {
      request: { op: "lineStats", path: root, oids: [oid] },
    });
  });

  it("rejects an answer for another operation", async () => {
    const { lineStats } = await load(true);
    invoke.mockResolvedValueOnce({
      op: "refs",
      data: {
        root,
        name: "l1-demo",
        head: { kind: "detached", oid },
        branches: [],
        tags: [],
        stashes: [],
        submodules: [],
      },
    });
    await expect(lineStats(root, [oid])).rejects.toThrow(
      "L1 Git's core answered refs to a lineStats request.",
    );
  });

  it("rejects malformed data", async () => {
    const { lineStats } = await load(true);
    invoke.mockResolvedValueOnce({
      op: "lineStats",
      data: [{ oid: "HEAD", added: 4, deleted: 2 }],
    });
    await expect(lineStats(root, [oid])).rejects.toMatchObject({
      issues: [
        {
          path: ["data", 0, "oid"],
          message:
            "Invalid string: must match pattern /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/",
        },
      ],
    });
  });
});

describe("bridge transport", () => {
  it("posts to /api/run and reads the flat success body", async () => {
    const { lineStats } = await load(false);
    reply(200, { ok: true, op: "lineStats", data: stats });
    expect(await lineStats(root, [oid])).toEqual(stats);
    expect(fetch).toHaveBeenCalledWith("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "lineStats", path: root, oids: [oid] }),
    });
  });

  it("throws the repository error from a failure body", async () => {
    const { refs } = await load(false);
    const error = {
      kind: "bareRepository",
      message: "Bare repositories are not supported yet.",
    };
    reply(200, { ok: false, error });
    await expect(refs(root)).rejects.toEqual(error);
  });

  it("throws a timed-out read as a repository error", async () => {
    const { commitDetail } = await load(false);
    const error = {
      kind: "timedOut",
      message:
        "Reading this commit took longer than 20 s, so L1 Git stopped Git. Retry. If it happens again, check for a slow disk or a Git filter that does not finish.",
    };
    reply(200, { ok: false, error });
    await expect(commitDetail(root, singleCommit(oid))).rejects.toEqual(error);
  });

  it("keeps the core's message for a staleView reason it does not know", async () => {
    const { commitDetail } = await load(false);
    const message = "HEAD went somewhere new. Refresh and try again.";
    reply(200, {
      ok: false,
      error: { kind: "staleView", reason: "headWandered", message },
    });
    const failure = commitDetail(root, singleCommit(oid)).catch(problemFrom);
    await expect(failure).resolves.toEqual({
      kind: "staleView",
      reason: "unknown",
      message,
    });
  });

  it("rejects a staleView that carries a field its reason does not define", async () => {
    const { commitDetail } = await load(false);
    for (const error of [
      { reason: "pathChanged", paths: ["f"] },
      { reason: "pathNotChosen", paths: ["f"], path: "f" },
    ]) {
      reply(200, {
        ok: false,
        error: { kind: "staleView", message: "Refresh.", ...error },
      });
      await expect(
        commitDetail(root, singleCommit(oid)),
      ).rejects.toHaveProperty("issues");
    }
  });

  it("names the bridge's reason for a 400", async () => {
    const { commitDetail } = await load(false);
    reply(400, { error: "missing field `comparison`" });
    await expect(commitDetail(root, singleCommit(oid))).rejects.toThrow(
      "The development bridge rejected the request. missing field `comparison`",
    );
  });

  it("points at pnpm dev for other refusals", async () => {
    const { refs } = await load(false);
    reply(404, { error: "Unknown route." });
    await expect(refs(root)).rejects.toThrow(
      "The development bridge rejected the request. Check that pnpm dev is running on this port.",
    );
  });

  it("points at pnpm dev for a JSON 400 without an error field", async () => {
    const { refs } = await load(false);
    reply(400, { message: "nope" });
    await expect(refs(root)).rejects.toThrow(
      "The development bridge rejected the request. Check that pnpm dev is running on this port.",
    );
  });

  it("points at pnpm dev for a 400 that did not come from the bridge", async () => {
    const { refs } = await load(false);
    fetch.mockResolvedValueOnce(
      new Response("<html>Bad Request</html>", { status: 400 }),
    );
    await expect(refs(root)).rejects.toThrow(
      "The development bridge rejected the request. Check that pnpm dev is running on this port.",
    );
  });
});
