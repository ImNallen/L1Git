# Change appearance

## Sub-features

Floating settings dialog, section navigation, System, Light, and Dark modes, saved appearance, live operating system changes, nested theme dialogs, and returning to the current repository view.

## How to get to it (user POV)

Click **Settings** at the bottom of the repository sidebar. A centered dialog opens over the visible repository, with **Appearance**, **Fetching**, and **Updates** navigation, a **Settings / Appearance** header, and **Close settings**. Settings also works before adding a repository. With the sidebar hidden, open Settings through the command palette.

## Driving it with T3 preview

1. Open Settings. Confirm Appearance is selected and Color scheme offers System, Light, and Dark. A fresh preference defaults to System. Confirm the island has rounded corners, a compact header, and a blurred backdrop over the repository. Tab through the dialog and confirm focus stays inside it. Select Fetching and Updates, then return to Appearance. Confirm the selected navigation entry and breadcrumb follow each section.
2. Select Light. Confirm the entire page changes immediately. Return to the repository and inspect the toolbar, history, graph, inspector, file tree, and Add dialog. Read a text diff in Unified and Split layouts. Both the diff and the tree must use light colors.
3. Repeat with Dark. Confirm the dark palette covers the same controls and views.
4. Select System. Use `preview_set_appearance` with Light, then Dark. Confirm the page follows each change while System remains selected. Choose Light explicitly, emulate Dark, and confirm the explicit choice wins. Repeat with explicit Dark against an emulated Light system.
5. Reload with each preference. Reopen Settings and confirm the saved choice. System must resolve against the current emulated system appearance. Restore the preview's appearance override to System after the check.
6. With a loaded repository, set both search fields, collapse a branch section, and open a file diff. Enter Settings, change the theme, then click **Close settings**. Confirm the searches, collapsed section, selected commit, open diff, diff layout, and pane sizes survive.
7. Enter Settings again and press Escape. Confirm the dialog closes, the open diff remains open, and focus returns to Settings. Cmd/Ctrl+F, Cmd/Ctrl+P, and repository action shortcuts in Settings must not focus or change the repository behind it. Reopen Settings and click the backdrop to close it. Reopen and drag from inside the island onto the backdrop; confirm this does not dismiss it.
8. Hide the sidebar. Confirm the main toolbar has a sidebar toggle and no Settings button. Use the command palette to open Settings, then press Escape. Confirm focus returns to the repository toolbar toggle. At a narrow viewport, confirm section navigation becomes horizontal, all theme controls fit, and settings content scrolls while the header remains visible.
9. In Appearance, open **Add theme** and press Escape. Confirm only the import dialog closes and Settings remains open. Open **Create theme**, confirm the editor fits inside the island, then press Escape from its name input. Confirm only the editor closes and focus returns to its opener. Duplicate a theme and repeat. Delete a disposable custom theme, cancel its confirmation with Escape, and confirm Settings stays open. Then press Escape again to close Settings. Follow the updates journey to verify restart confirmation stacks above Settings and the installation blocker takes focus above both.

## Native checks

Choose Light, Dark, then System in the packaged Tauri app. Confirm the titlebar and window background follow the selected mode, with no native appearance error. Confirm System returns to the current OS appearance. Quit and reopen to check the saved preference. Verify that the traffic lights, window dragging, and native repository picker still work.

## Gotchas

The browser and native app save separate preferences. Do not clear the user's storage to test a fresh choice. Use a fresh origin or profile. Pierre's diff and file tree render inside shadow roots, so use screenshots, accessible tree items, or read the host's `shadowRoot` to inspect their colors and text.
