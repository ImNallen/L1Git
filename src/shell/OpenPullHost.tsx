import { OpenPullPopover } from "../components/OpenPullPopover";
import type { BranchStatus } from "../domain/overview";
import type { RepositorySnapshot } from "../domain/repository";
import type { Host } from "../host";
import type { OpenPull } from "./useOpenPull";

export function OpenPullHost({
  openPull,
  snapshot,
  host,
  statuses,
}: {
  openPull: OpenPull;
  snapshot: RepositorySnapshot | null;
  host: Pick<Host, "ask" | "openPull">;
  statuses: readonly BranchStatus[] | undefined;
}) {
  const { asking } = openPull;
  if (!asking || snapshot?.root !== asking.root) return null;
  return (
    <OpenPullPopover
      key={`${asking.root} ${asking.head.name}`}
      ask={asking}
      snapshot={snapshot}
      host={host}
      statuses={statuses ?? []}
      onOpened={openPull.opened}
      onView={(number) => {
        openPull.close();
        openPull.view(asking.github, number);
      }}
      onClose={openPull.close}
    />
  );
}
