# Change appearance

## Sub-features

Settings navigation, System, Light, and Dark modes, saved appearance, live operating system changes, and returning to the current repository view.

## How to get to it (user POV)

Click **Settings** at the bottom of the repository sidebar. The sidebar shows **Appearance** and a **Back** action. The main pane shows **Settings / Appearance** and the Theme choices. Settings also works before adding a repository.

## Driving it with T3 preview

1. Open Settings. Confirm Appearance is selected and the Theme group offers System, Light, and Dark. A fresh preference defaults to System.
2. Select Light. Confirm the entire page changes immediately. Return to the repository and inspect the toolbar, history, graph, inspector, file tree, and Add dialog. Read a text diff in Unified and Split layouts. Both the diff and the tree must use light colors.
3. Repeat with Dark. Confirm the dark palette covers the same controls and views.
4. Select System. Use `preview_set_appearance` with Light, then Dark. Confirm the page follows each change while System remains selected. Choose Light explicitly, emulate Dark, and confirm the explicit choice wins. Repeat with explicit Dark against an emulated Light system.
5. Reload with each preference. Reopen Settings and confirm the saved choice. System must resolve against the current emulated system appearance. Restore the preview's appearance override to System after the check.
6. With a loaded repository, set both search fields, collapse a branch section, and open a file diff. Enter Settings, change the theme, then click Back. Confirm the searches, collapsed section, selected commit, open diff, diff layout, and pane sizes survive.
7. Enter Settings again and press Escape. Confirm the repository returns, the open diff remains open, and focus returns to Settings. Cmd/Ctrl+F in Settings must not focus hidden history.
8. Hide and reopen the sidebar. Confirm Settings remains reachable. At a narrow viewport, confirm the Theme choices fit and the main settings content can scroll.

## Native checks

Choose Light, Dark, then System in the packaged Tauri app. Confirm the titlebar and window background follow the selected mode, with no native appearance error. Confirm System returns to the current OS appearance. Quit and reopen to check the saved preference. Verify that the traffic lights, window dragging, and native repository picker still work.

## Gotchas

The browser and native app save separate preferences. Do not clear the user's storage to test a fresh choice. Use a fresh origin or profile. Pierre's diff and file tree render inside shadow roots, so use screenshots, accessible tree items, or read the host's `shadowRoot` to inspect their colors and text.
