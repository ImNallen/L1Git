# Repository instructions

Keep `README.md` for humans and `AGENTS.md` for AI agent instructions.

Use `pstack:poteto-mode` and follow its routing to the appropriate pstack skills for each task.

Always monitor PRs you create or work on for CI results, review comments, and merge conflicts. Address failures and actionable feedback until the PR is ready to merge.

## Diffs and file trees

Render code, diffs, and patches with [`@pierre/diffs`](https://diffs.com/). Render file trees with [`@pierre/trees`](https://trees.software/). Do not hand-roll a diff view or a path tree, and do not add another diff or tree library. Before you write code against either package, read its skill in `.agents/skills/diffs/SKILL.md` or `.agents/skills/trees/SKILL.md`, then load only the reference that matches the task.

The skills are copies of Pierre's upstream skills, pinned in `skills-lock.json`. Refresh them with `npx skills update -p -y` when you upgrade either package. If a skill reference disagrees with the installed package, trust the package's type declarations in `node_modules`.

## Desktop

A virtual XFCE desktop runs on DISPLAY=:1. When I ask to see the desktop, or when you launch a GUI app, open http://localhost:6080/vnc.html?autoconnect=true&resize=scale in the T3 preview pane.
