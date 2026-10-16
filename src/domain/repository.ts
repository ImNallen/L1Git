import { z } from "zod";

export const rootSchema = z
  .string()
  .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/)
  .brand<"RepositoryRoot">();
export const oidSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .brand<"Oid">();
export const refSchema = z
  .string()
  .regex(/^refs\/.+\/.+$/)
  .brand<"FullRef">();
export const headSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attached"),
    reference: refSchema,
    oid: oidSchema,
  }),
  z.object({ kind: z.literal("unborn"), reference: refSchema }),
  z.object({ kind: z.literal("detached"), oid: oidSchema }),
]);
export const branchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    reference: refSchema,
    name: z.string(),
    oid: oidSchema,
    upstream: refSchema.nullable(),
  }),
  z.object({
    kind: z.literal("remote"),
    reference: refSchema,
    name: z.string(),
    oid: oidSchema,
    remote: z.string(),
  }),
]);
export const commitSchema = z.object({
  oid: oidSchema,
  parents: z.array(oidSchema),
  subject: z.string(),
  author: z.string(),
  email: z.string(),
  timestamp: z.number().int(),
});
export const snapshotSchema = z.object({
  root: rootSchema,
  name: z.string(),
  head: headSchema,
  branches: z.array(branchSchema),
  remotes: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      github: z.object({ owner: z.string(), repo: z.string() }).nullable(),
    }),
  ),
  commits: z.array(commitSchema),
  historyTruncated: z.boolean(),
  observedAt: z.number().int().nonnegative(),
});
export const changeStatusSchema = z.enum(["A", "D", "M", "T"]);
export const detailSchema = z.object({
  commit: commitSchema,
  message: z.string(),
  files: z.array(z.object({ path: z.string(), status: changeStatusSchema })),
  diffBase: z.enum(["emptyTree", "firstParent"]),
});
export const filePatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), patch: z.string() }),
  z.object({ kind: z.literal("binary") }),
  z.object({ kind: z.literal("tooLarge"), bytes: z.number().int().positive() }),
]);
export const repositoryErrorSchema = z.object({
  kind: z.enum([
    "missingPath",
    "notRepository",
    "bareRepository",
    "gitMissing",
    "gitFailed",
    "invalidRef",
    "invalidOid",
    "unchangedPath",
    "unsupportedPath",
  ]),
  message: z.string(),
});

export type RepositoryRoot = z.infer<typeof rootSchema>;
export type Oid = z.infer<typeof oidSchema>;
export type FullRef = z.infer<typeof refSchema>;
export type Head = z.infer<typeof headSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type Commit = z.infer<typeof commitSchema>;
export type RepositorySnapshot = z.infer<typeof snapshotSchema>;
export type ChangeStatus = z.infer<typeof changeStatusSchema>;
export type CommitDetail = z.infer<typeof detailSchema>;
export type ChangedFile = CommitDetail["files"][number];
export type FilePatch = z.infer<typeof filePatchSchema>;
export type Problem =
  | z.infer<typeof repositoryErrorSchema>
  | { kind: "transport" | "persistence"; message: string };

export function problemFrom(error: unknown): Problem {
  const repositoryError = repositoryErrorSchema.safeParse(error);
  if (repositoryError.success) return repositoryError.data;
  return {
    kind: "transport",
    message:
      error instanceof Error
        ? error.message
        : "The repository reader is unavailable. Try again.",
  };
}

export function headLabel(head: Head): string {
  switch (head.kind) {
    case "attached":
      return head.reference.replace(/^refs\/heads\//, "");
    case "unborn":
      return `${head.reference.replace(/^refs\/heads\//, "")} · no commits`;
    case "detached":
      return `Detached at ${head.oid.slice(0, 7)}`;
    default: {
      const exhaustive: never = head;
      return exhaustive;
    }
  }
}
