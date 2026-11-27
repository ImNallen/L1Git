import { useRef } from "react";
import type { CSSProperties } from "react";
import {
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Square,
  SquareCheck,
  Tag,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { viewLabels, views } from "../domain/pullRequestList";
import type { Choices, ListModel, View } from "../domain/pullRequestList";
import { useRovingRows } from "./useRovingRows";

const viewIcons: Record<View, LucideIcon> = {
  open: GitPullRequest,
  review: Eye,
  mine: Users,
  drafts: GitPullRequestDraft,
  merged: GitMerge,
};

function toggled(set: ReadonlySet<string>, key: string) {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Pulled toward the text color, so no label's own color fades into the sidebar. */
const labelColor = (color: string | null): CSSProperties | undefined =>
  color === null
    ? undefined
    : { color: `color-mix(in srgb, #${color} 70%, var(--text))` };

const Count = ({ of }: { of: number | null }) =>
  of !== null && (
    <span className="pull-filter-count">{of.toLocaleString()}</span>
  );

/** The sidebar of the pull requests, in place of the repository tree. */
export function PullRequestFilters({
  model,
  choices,
  onChoose,
}: {
  model: ListModel;
  choices: Choices;
  onChoose: (choices: Partial<Choices>) => void;
}) {
  const rows = useRef<HTMLDivElement>(null);
  useRovingRows(rows);
  return (
    <>
      <div className="pull-filters-heading" data-tauri-drag-region />
      <div ref={rows} className="pull-filters">
        <nav className="pull-filter-group" aria-label="Pull request views">
          <h3 aria-hidden="true">Views</h3>
          {views.map((view) => {
            const Icon = viewIcons[view];
            return (
              <button
                key={view}
                type="button"
                className="pull-filter"
                aria-current={choices.view === view ? "true" : undefined}
                onClick={() => onChoose({ view })}
              >
                <Icon size={16} />
                <span>{viewLabels[view]}</span>
                <Count of={model.counts[view]} />
              </button>
            );
          })}
        </nav>
        {model.repositories.length > 0 && (
          <div
            className="pull-filter-group"
            role="group"
            aria-labelledby="pull-repositories"
          >
            <h3 id="pull-repositories">Repositories</h3>
            {model.repositories.map(
              ({ repository: { key, name, github }, checked, ...own }) => {
                const Box = checked ? SquareCheck : Square;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`pull-filter ${checked ? "" : "off"}`}
                    role="checkbox"
                    aria-checked={checked}
                    title={`${github.owner}/${github.repo}`}
                    onClick={() =>
                      onChoose({ unchecked: toggled(choices.unchecked, key) })
                    }
                  >
                    <Box size={16} className="pull-filter-box" />
                    <span>{name}</span>
                    {own.noAccess ? (
                      <span className="pull-filter-count">No access</span>
                    ) : (
                      <Count of={own.count} />
                    )}
                  </button>
                );
              },
            )}
          </div>
        )}
        {model.labels.length > 0 && (
          <div
            className="pull-filter-group"
            role="group"
            aria-labelledby="pull-labels"
          >
            <h3 id="pull-labels">Labels</h3>
            {model.labels.map(({ key, name, color, count, chosen }) => (
              <button
                key={key}
                type="button"
                className="pull-filter"
                role="checkbox"
                aria-checked={chosen}
                onClick={() =>
                  onChoose({ labels: toggled(choices.labels, key) })
                }
              >
                <Tag
                  size={16}
                  className="pull-label-icon"
                  style={labelColor(color)}
                />
                <span title={name}>{name}</span>
                <Count of={count} />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
