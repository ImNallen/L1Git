import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Unsent, send } from "./transport";

const route = { command: "host_run", path: "/api/host", error: z.unknown() };
afterEach(() => vi.unstubAllGlobals());

it("tells a request that never got to Rust from one that may have", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    send(route, { body: "x".repeat(5 * 1024 * 1024) }),
  ).rejects.toBeInstanceOf(Unsent);
  expect(fetch, "too large to leave").not.toHaveBeenCalled();

  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "unknown variant `mutation`" }), {
      status: 400,
    }),
  );
  const rejected = send(route, { op: "write" });
  await expect(rejected).rejects.toBeInstanceOf(Unsent);
  await expect(rejected).rejects.toThrow("unknown variant `mutation`");

  fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const lost = await send(route, { op: "write" }).catch(
    (error: unknown) => error,
  );
  expect(lost).toBeInstanceOf(Error);
  expect(lost, "it may have reached Rust").not.toBeInstanceOf(Unsent);
});
