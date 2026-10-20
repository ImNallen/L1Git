import { afterEach, describe, expect, it, vi } from "vitest";
import { oidSchema, rootSchema } from "./domain/repository";

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

  it("names the bridge's reason for a 400", async () => {
    const { commitDetail } = await load(false);
    reply(400, { error: "missing field `oid`" });
    await expect(commitDetail(root, oid)).rejects.toThrow(
      "The development bridge rejected the request. missing field `oid`",
    );
  });

  it("points at pnpm dev for other refusals", async () => {
    const { refs } = await load(false);
    reply(404, { error: "Unknown route." });
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
