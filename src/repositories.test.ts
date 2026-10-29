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

it("sends the prepared push intent unchanged and validates strict push outcomes", async () => {
  const { pushIntentSchema } = await import("./domain/push");
  const intent = pushIntentSchema.parse({
    purpose: "upstream",
    branch: "refs/heads/main",
    source: oid,
    remote: "origin",
    destination: "refs/heads/reviewed",
    endpoint: "Local or unrecognized remote",
    fingerprint: "b".repeat(40),
  });
  const { preparePush, push } = await load(true);
  invoke.mockResolvedValueOnce({
    op: "preparePush",
    data: { kind: "ready", intent },
  });
  expect(await preparePush(root)).toEqual({ kind: "ready", intent });
  const report = {
    outcome: { kind: "pushed" },
    refresh: { kind: "failed", message: "Refresh needed." },
  };
  invoke.mockResolvedValueOnce({ op: "push", data: report });
  expect(await push(root, intent)).toEqual(report);
  expect(invoke).toHaveBeenLastCalledWith("repository_run", {
    request: { op: "push", path: root, intent },
  });
  invoke.mockResolvedValueOnce({
    op: "push",
    data: { ...report, outcome: { kind: "pushed", message: "unexpected" } },
  });
  await expect(push(root, intent)).rejects.toHaveProperty("issues");
});

it.each([true, false])(
  "shares publication options, preparation, and confirmed tracking outcomes across native=%s",
  async (native) => {
    const { publishOptions, preparePublish, push } = await load(native);
    const { publishChoiceSchema, pushIntentSchema } =
      await import("./domain/push");
    const choice = publishChoiceSchema.parse({
      remote: "origin",
      destination: "refs/heads/release",
    });
    const intent = pushIntentSchema.parse({
      purpose: "publish",
      branch: "refs/heads/topic",
      source: oid,
      ...choice,
      endpoint: "/remote.git",
      fingerprint: "b".repeat(40),
    });
    const options = {
      kind: "available",
      branch: intent.branch,
      source: oid,
      remotes: [
        {
          name: "origin",
          availability: { kind: "eligible", endpoint: intent.endpoint },
        },
      ],
    };
    const reply = (op: string, data: unknown) => {
      if (native) invoke.mockResolvedValueOnce({ op, data });
      else fetch.mockResolvedValueOnce(Response.json({ ok: true, op, data }));
    };
    reply("publishOptions", options);
    expect(await publishOptions(root)).toEqual(options);
    reply("preparePublish", { kind: "ready", intent });
    expect(await preparePublish(root, choice)).toEqual({
      kind: "ready",
      intent,
    });
    const report = {
      outcome: { kind: "published", tracking: { kind: "set" } },
      refresh: { kind: "failed", message: "Refresh failed." },
    };
    reply("push", report);
    expect(await push(root, intent)).toEqual(report);
    if (native)
      expect(invoke).toHaveBeenLastCalledWith("repository_run", {
        request: { op: "push", path: root, intent },
      });
    else
      expect(JSON.parse(fetch.mock.calls.at(-1)?.[1]?.body ?? "")).toEqual({
        op: "push",
        path: root,
        intent,
      });
  },
);

it.each([true, false])(
  "adds a remote over native=%s and parses saved refresh failure",
  async (native) => {
    const { addRemote } = await load(native);
    const remote = { name: "origin", url: "../endpoint" };
    const report = {
      name: "origin",
      refresh: { kind: "failed", message: "Added. Reload remotes." },
    };
    if (native) invoke.mockResolvedValueOnce({ op: "addRemote", data: report });
    else
      fetch.mockResolvedValueOnce(
        Response.json({ ok: true, op: "addRemote", data: report }),
      );
    expect(await addRemote(root, remote)).toEqual(report);
    if (native)
      expect(invoke).toHaveBeenLastCalledWith("repository_run", {
        request: { op: "addRemote", path: root, remote },
      });
    else
      expect(JSON.parse(fetch.mock.calls.at(-1)?.[1]?.body ?? "")).toEqual({
        op: "addRemote",
        path: root,
        remote,
      });
    if (native)
      invoke.mockResolvedValueOnce({
        op: "addRemote",
        data: { ...report, url: remote.url },
      });
    else
      fetch.mockResolvedValueOnce(
        Response.json({
          ok: true,
          op: "addRemote",
          data: { ...report, url: remote.url },
        }),
      );
    await expect(addRemote(root, remote)).rejects.toHaveProperty("issues");
  },
);
