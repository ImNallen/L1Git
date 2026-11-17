import { z } from "zod";
import type { Route } from "../transport";

const accessSchema = z.enum(["private", "publicOnly", "perRepository"]);

const hostStatusSchema = z.object({
  revision: z.number().int().nonnegative(),
  github: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("notConnected"),
      ended: z
        .object({
          login: z.string().nullable(),
          reason: z.enum(["revoked", "tokenMissing", "unreadable"]),
        })
        .nullable(),
    }),
    z.object({
      kind: z.literal("connected"),
      login: z.string(),
      api: z.string(),
      method: z.literal("gh"),
      access: accessSchema,
      connectedAt: z.number().int().nonnegative(),
    }),
  ]),
});

const ghProbeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("outdated") }),
  z.object({ kind: z.literal("signedOut") }),
  z.object({ kind: z.literal("broken"), login: z.string() }),
  z.object({ kind: z.literal("failed"), detail: z.string() }),
  z.object({
    kind: z.literal("ready"),
    login: z.string(),
    access: accessSchema,
    path: z.string(),
  }),
]);

const failure = { message: z.string(), status: hostStatusSchema };
export const hostErrorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ghMissing"), ...failure }),
  z.object({ kind: z.literal("ghOutdated"), ...failure }),
  z.object({ kind: z.literal("ghSignedOut"), ...failure }),
  z.object({
    kind: z.literal("ghAccountChanged"),
    expected: z.string(),
    found: z.string(),
    ...failure,
  }),
  z.object({ kind: z.literal("ghFailed"), ...failure }),
  z.object({ kind: z.literal("rejected"), ...failure }),
  z.object({ kind: z.literal("signedOut"), ...failure }),
  z.object({ kind: z.literal("notConnected"), ...failure }),
  z.object({
    kind: z.literal("rateLimited"),
    resetAt: z.number().int().nullable(),
    ...failure,
  }),
  z.object({ kind: z.literal("unreachable"), ...failure }),
  z.object({
    kind: z.literal("gitHubFailed"),
    httpStatus: z.number().int(),
    ...failure,
  }),
  z.object({
    kind: z.literal("keychain"),
    problem: z.enum(["locked", "unavailable"]),
    ...failure,
  }),
  z.object({ kind: z.literal("storage"), ...failure }),
  z.object({ kind: z.literal("interrupted"), ...failure }),
]);

export const hostResponseSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), status: hostStatusSchema }),
  z.object({
    op: z.literal("probeGh"),
    data: ghProbeSchema,
    status: hostStatusSchema,
  }),
  z.object({ op: z.literal("connectGh"), status: hostStatusSchema }),
  z.object({ op: z.literal("disconnect"), status: hostStatusSchema }),
  z.object({ op: z.literal("verify"), status: hostStatusSchema }),
]);

export type HostRequest =
  | { op: "status" | "probeGh" | "disconnect" | "verify" }
  | { op: "connectGh"; login: string };

export const hostRequestOps = hostResponseSchema.options.map(
  (option) => option.shape.op.value,
);

export const hostRoute: Route = {
  command: "host_run",
  path: "/api/host",
  error: hostErrorSchema,
};

export type HostStatus = z.infer<typeof hostStatusSchema>;
export type GhProbe = z.infer<typeof ghProbeSchema>;
export type Access = z.infer<typeof accessSchema>;
