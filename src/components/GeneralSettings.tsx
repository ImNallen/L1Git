import { useEffect, useRef } from "react";
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
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <section className="settings-page" aria-labelledby="general-heading">
      <div className="settings-content">
        <h1 id="general-heading" ref={heading} tabIndex={-1}>
          General
        </h1>
        <FetchSettings {...fetching} />
        <UpdatesSettings updates={updates} restart={restart} />
      </div>
    </section>
  );
}
