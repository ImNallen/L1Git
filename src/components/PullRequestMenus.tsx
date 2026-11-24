import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  checksFilters,
  reviewFilters,
  sortLabel,
  sorts,
} from "../domain/pullRequestList";
import type { Choices } from "../domain/pullRequestList";
import { ContextMenu } from "./ContextMenu";

type Option = { label: string; chosen: boolean; run: () => void };

const MENU_WIDTH = 220;

function MenuButton({
  name,
  value,
  narrowed = false,
  heading,
  end = false,
  options,
  children,
}: {
  name: string;
  value: string;
  narrowed?: boolean;
  heading?: string;
  /** Lines the menu up with the button's right edge. */
  end?: boolean;
  options: readonly Option[];
  children?: (close: () => void) => ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const close = () => {
    setOpen(null);
    button.current?.focus();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`pull-menu-button ${narrowed ? "narrowed" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          if (rect)
            setOpen({
              x: end ? rect.right - MENU_WIDTH : rect.left,
              y: rect.bottom + 4,
            });
        }}
      >
        <span className="pull-menu-name">{name}</span>
        <span className="pull-menu-value">{value}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <ContextMenu
          className="pull-menu"
          x={open.x}
          y={open.y}
          label={name}
          ignoreScrollIn={items}
          onClose={({ returnFocus }) => (returnFocus ? close() : setOpen(null))}
        >
          {heading && (
            <div className="menu-heading" role="presentation">
              {heading}
            </div>
          )}
          <div
            ref={items}
            className="pull-menu-items"
            role="group"
            aria-label={name}
          >
            {options.map(({ label, chosen, run }) => (
              <button
                key={label}
                role="menuitemradio"
                aria-checked={chosen}
                onClick={() => {
                  close();
                  run();
                }}
              >
                <Check size={14} visibility={chosen ? "visible" : "hidden"} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          {children?.(close)}
        </ContextMenu>
      )}
    </>
  );
}

function filterOptions<Key extends string>(
  any: string,
  labels: readonly (readonly [Key, string])[],
  chosen: Key | null,
  choose: (key: Key | null) => void,
): Option[] {
  return [
    { label: any, chosen: chosen === null, run: () => choose(null) },
    ...labels.map(([key, label]) => ({
      label,
      chosen: chosen === key,
      run: () => choose(key),
    })),
  ];
}

const entries = <Key extends string>(labels: Record<Key, string>) =>
  Object.entries(labels) as [Key, string][];

/** Author, Review and Checks on the left, Sort on the right. */
export function PullRequestMenus({
  choices,
  authors,
  onChoose,
}: {
  choices: Choices;
  authors: readonly string[];
  onChoose: (choices: Partial<Choices>) => void;
}) {
  const { author, review, checks, sort, grouped, view } = choices;
  return (
    <div className="pull-controls">
      <MenuButton
        name="Author"
        value={author ?? "Anyone"}
        narrowed={author !== null}
        options={filterOptions(
          "Anyone",
          authors.map((name) => [name, name] as const),
          author,
          (author) => onChoose({ author }),
        )}
      />
      <MenuButton
        name="Review"
        value={review === null ? "Any" : reviewFilters[review]}
        narrowed={review !== null}
        options={filterOptions(
          "Any",
          entries(reviewFilters),
          review,
          (review) => onChoose({ review }),
        )}
      />
      <MenuButton
        name="Checks"
        value={checks === null ? "Any" : checksFilters[checks]}
        narrowed={checks !== null}
        options={filterOptions(
          "Any",
          entries(checksFilters),
          checks,
          (checks) => onChoose({ checks }),
        )}
      />
      <span className="pull-controls-space" />
      <MenuButton
        name="Sort"
        heading="Sort by"
        value={sortLabel(sort, view)}
        end
        options={sorts.map((each) => ({
          label: sortLabel(each, view),
          chosen: sort === each,
          run: () => onChoose({ sort: each }),
        }))}
      >
        {(close) => (
          <>
            <div className="menu-separator" role="separator" />
            <button
              role="menuitemcheckbox"
              aria-checked={grouped}
              onClick={() => {
                close();
                onChoose({ grouped: !grouped });
              }}
            >
              <Check size={14} visibility={grouped ? "visible" : "hidden"} />
              <span>Group by repository</span>
            </button>
          </>
        )}
      </MenuButton>
    </div>
  );
}
