import focusStyles from "../styles/focus.css?inline";
import patchStyles from "../styles/filePatch.css?inline";
import defaultPatchStyles from "../styles/defaultFilePatch.css?inline";
import { pierreThemeOptions } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
import { keyExpanders } from "./expanders";

/** How every patch is painted, in the app's theme. */
export const patchOptions = (theme: Appearance, painted: boolean) => ({
  ...pierreThemeOptions(theme, painted),
  onPostRender: keyExpanders,
  unsafeCSS: `${focusStyles}
${patchStyles}
${theme === "dark" && !painted ? defaultPatchStyles : ""}`,
});
