import { initials } from "../domain/author";
import { relativeTime } from "../domain/time";

const plainName = (login: string) => login.replace(/\[bot\]$/, "");

export function Avatar({ login }: { login: string | null }) {
  return (
    <span className="pull-avatar" aria-hidden="true">
      {initials(plainName(login ?? "ghost"))}
    </span>
  );
}

export const Bars = ({ count }: { count: number }) =>
  Array.from({ length: count }, (_, index) => (
    <i className="pull-bone" key={index} aria-hidden="true" />
  ));

export function Ago({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time dateTime={at} title={date.toLocaleString()}>
      {relativeTime(date.getTime() / 1_000)}
    </time>
  );
}

export function OnGitHub({
  url,
  children = "Open on GitHub",
}: {
  url: string;
  children?: string;
}) {
  return (
    <a className="pull-link" href={url} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
