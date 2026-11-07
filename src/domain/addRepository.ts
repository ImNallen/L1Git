import { z } from "zod";

export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  repository: z.boolean(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const directoryListingSchema = z.object({
  entries: z.array(directoryEntrySchema),
});

export const newRepositorySchema = z.object({ path: z.string() });
