import { createContext } from "react";
import type { Appearance } from "../themes/palette";

/** What text written on GitHub needs to know about where it is shown. */
export type Surroundings = {
  /** What a relative link is relative to. */
  base: string;
  theme: Appearance;
  painted: boolean;
};
export const SurroundingsContext = createContext<Surroundings>({
  base: "https://github.com/",
  theme: "dark",
  painted: false,
});
