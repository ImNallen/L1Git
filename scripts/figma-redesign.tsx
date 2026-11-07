import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/variable.css";
import "@fontsource/ibm-plex-mono/400.css";
import "../src/theme.css";
import { SettingsDialog } from "../src/components/SettingsDialog";
import { GeneralSettings } from "../src/components/GeneralSettings";
import { UpdateAffordance } from "../src/components/UpdatesSettings";
import { useUpdateRestart } from "../src/components/UpdateRestart";
import { createUpdatesClient, parseUpdateSnapshot } from "../src/updates";
import { fetchIntervals } from "../src/fetchSettings";
import type { FetchInterval } from "../src/fetchSettings";

const parameters = new URLSearchParams(location.search);
const candidate = {
  id: "1",
  version: "0.1.1-nightly.20261106.213",
  notes:
    "* Keep repository selection when returning from a diff (#184)\n* Flush queued frames before teardown (#181)\n* Polish the reset controls in Settings (#176)",
};
const states = {
  current: { kind: "current" },
  checking: { kind: "checking" },
  available: { kind: "available", candidate, message: null },
  downloading: { kind: "downloading", candidate, received: 42, total: 100 },
  downloaded: { kind: "downloaded", candidate, message: null },
  installing: { kind: "installing", candidate },
};
const stateName = parameters.get("state") ?? "current";
const state = Object.entries(states).find(([name]) => name === stateName)?.[1];
if (!state) throw new Error(`Unknown fixture state ${stateName}`);
const initial = parseUpdateSnapshot({
  revision: 1,
  installedVersion: "0.1.1-nightly.20261106.212",
  track: parameters.get("track") ?? "nightly",
  preferenceError: null,
  state,
});
document.documentElement.dataset.theme = "dark";

function Fixture() {
  const [interval, setInterval] = useState<FetchInterval>(() => {
    const value = Number(parameters.get("interval") ?? 15);
    return fetchIntervals.find((interval) => interval === value) ?? 15;
  });
  const [client] = useState(() => {
    let snapshot = initial;
    return createUpdatesClient({
      listen: async () => () => {},
      invoke: async (command) => {
        if (command.name === "updater_select_track")
          snapshot = {
            ...snapshot,
            revision: snapshot.revision + 1,
            track: command.args.track,
          };
        return snapshot;
      },
    });
  });
  const current = useSyncExternalStore(
    client.subscribe,
    client.read,
    client.read,
  );
  const updates = { ...current, ...client };
  const restart = useUpdateRestart(updates);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let disposed = false;
    void client.connect().then((unsubscribe) => {
      if (disposed) unsubscribe();
      else stop = unsubscribe;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [client]);
  return parameters.get("screen") === "update" ? (
    <aside
      className="sidebar"
      style={{
        width: Number(parameters.get("width") ?? 280),
        height: "100dvh",
      }}
    >
      <footer className="sidebar-bottom" style={{ marginTop: "auto" }}>
        <UpdateAffordance updates={updates} restart={restart} />
      </footer>
    </aside>
  ) : (
    <SettingsDialog
      section="general"
      onSectionChange={() => {}}
      onClose={() => {}}
      restore={{
        disabled: interval === 15 && updates.snapshot.track === "stable",
        run: () => {
          setInterval(15);
          void updates.selectTrack("stable");
        },
      }}
    >
      <GeneralSettings
        fetching={{
          intervalMinutes: interval,
          onIntervalChange: setInterval,
          persistenceError: null,
        }}
        updates={updates}
        restart={restart}
      />
    </SettingsDialog>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
