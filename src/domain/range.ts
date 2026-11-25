import { z } from "zod";
import { fetchFailureSchema } from "./overview";
import { filePatchSchema, oidSchema } from "./repository";

const count = z.number().int().nonnegative();
const rangeFileSchema = z.strictObject({
  path: z.string(),
  status: z.enum(["A", "D", "M", "T", "R"]),
  /** Where a renamed file was, and how much of it is the same, in percent. */
  from: z.string().nullable(),
  similarity: z.number().int().min(0).max(100).nullable(),
  /** Null for a binary file, and for every file when `contentMissing`. */
  added: count.nullable(),
  deleted: count.nullable(),
  /** Null on the side that does not have the file. A submodule's is the commit it is at. */
  oldBlob: oidSchema.nullable(),
  newBlob: oidSchema.nullable(),
  submodule: z.boolean(),
});
export const rangeFilesSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ready"),
    mergeBase: oidSchema,
    files: z.array(rangeFileSchema),
    /** Git could not read every file's contents, as in a partial clone. No file has line counts, and one that was renamed and edited is a deletion and an addition. */
    contentMissing: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("missing"), oids: z.array(oidSchema) }),
  z.strictObject({ kind: z.literal("unrelated"), shallow: z.boolean() }),
]);
/** A null `patch` is one to read by itself. */
export const rangePatchesSchema = z.array(
  z.strictObject({ path: z.string(), patch: filePatchSchema.nullable() }),
);
export const commitsFetchSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("done") }),
  z.strictObject({ kind: z.literal("noRemote") }),
  z.strictObject({
    kind: z.literal("failed"),
    failure: fetchFailureSchema,
    message: z.string(),
  }),
]);
