import { FetchSettings } from "./FetchSettings";
import type { FetchSettingsProps } from "./FetchSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import type { Updates } from "../updates";
import type { UpdateRestart } from "./UpdateRestart";

type Props = {
  fetching: FetchSettingsProps;
  updates: Updates;
  restart: UpdateRestart;
};

export function GeneralSettings({ fetching, updates, restart }: Props) {
  return (
    <section className="settings-page" aria-labelledby="general-heading">
      <div className="settings-content">
        <div className="settings-page-heading">
          <h1 id="general-heading" tabIndex={-1}>
            General
          </h1>
          <p>Manage background fetching and app updates.</p>
        </div>
        <FetchSettings {...fetching} />
        <UpdatesSettings updates={updates} restart={restart} />
      </div>
    </section>
  );
}
