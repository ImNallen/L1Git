import { useEffect, useRef, useState } from "react";
import { problemFrom } from "./domain/repository";
import type { Problem } from "./domain/repository";

export type Read<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; error: Problem };

/**
 * Reads again whenever `key` changes and shows only the latest key's answer.
 * `read` must depend only on what `key` names.
 */
export function useRead<T>(
  key: string | null,
  read: () => Promise<T>,
): [Read<T>, () => void] {
  const reader = useRef(read);
  reader.current = read;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; read: Read<T> } | null>(
    null,
  );
  useEffect(() => {
    if (key === null) return;
    let current = true;
    setState({ key, read: { kind: "loading" } });
    reader.current().then(
      (value) => current && setState({ key, read: { kind: "ready", value } }),
      (error: unknown) =>
        current &&
        setState({ key, read: { kind: "error", error: problemFrom(error) } }),
    );
    return () => {
      current = false;
    };
  }, [key, attempt]);
  return [
    state !== null && state.key === key ? state.read : { kind: "loading" },
    () => setAttempt((attempt) => attempt + 1),
  ];
}
