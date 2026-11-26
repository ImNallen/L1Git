#![cfg(unix)]

use l1_git_core::{
    BranchRef, Coordinator, GitHubRepository, HeadFrom, Limits, Oid, PullCheckout, PullHead,
    PullKey,
};
use std::{
    fs,
    num::NonZeroU32,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

const BASE_URL: &str = "https://github.com/octo/app.git";
const HOOKS: [&str; 4] = [
    "post-checkout",
    "post-merge",
    "reference-transaction",
    "pre-auto-gc",
];

fn git(path: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.test")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.test")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end()
        .to_owned()
}

fn key() -> PullKey {
    PullKey {
        github: GitHubRepository {
            owner: "octo".into(),
            repo: "app".into(),
        },
        number: NonZeroU32::new(1).unwrap(),
    }
}

fn script(marker: &Path, name: &str) -> String {
    format!("#!/bin/sh\necho {name} >> '{}'\n", marker.display())
}

struct World {
    _directory: TempDir,
    base: PathBuf,
    author: PathBuf,
    root: PathBuf,
    copy: PathBuf,
    marker: PathBuf,
    core: Coordinator,
}

impl World {
    /// The author's commits carry `hooks/<name>` for each of [`HOOKS`] when
    /// `tracked_hooks`.
    fn new(tracked_hooks: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let top = directory.path().canonicalize().unwrap();
        let (base, author, root) = (top.join("base.git"), top.join("author"), top.join("repo"));
        git(&top, &["init", "-q", "--bare", "-b", "main", "base.git"]);
        git(&top, &["init", "-q", "-b", "main", "author"]);
        fs::write(author.join("shared.txt"), "shared\n").unwrap();
        git(&author, &["add", "shared.txt"]);
        git(&author, &["commit", "-q", "-m", "base"]);
        git(&author, &["push", "-q", base.to_str().unwrap(), "main"]);
        git(&top, &["clone", "-q", base.to_str().unwrap(), "repo"]);
        let insteadof = format!("url.{}.insteadOf", base.display());
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("remote.origin.url", BASE_URL),
            (&insteadof, BASE_URL),
        ] {
            git(&root, &["config", key, value]);
        }
        let marker = top.join("ran");
        let world = Self {
            core: Coordinator::new(Limits::default(), top.join("undo")),
            copy: top.join("repo-pr-1"),
            _directory: directory,
            base,
            author,
            root,
            marker,
        };
        git(&world.author, &["switch", "-q", "-c", "feat"]);
        if tracked_hooks {
            let hooks = world.author.join("hooks");
            fs::create_dir(&hooks).unwrap();
            for name in HOOKS {
                let hook = hooks.join(name);
                fs::write(&hook, script(&world.marker, name)).unwrap();
                fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
            }
            git(&world.author, &["add", "hooks"]);
        }
        world
    }

    /// Hooks in the repository's own hooks folder, and hooks its config
    /// defines, for `events`. The folder is named in full, so a
    /// `core.hooksPath` in the global config cannot hide it.
    fn untracked_hooks(&self, events: &[&str]) {
        let hooks = self.root.join(".git").join("hooks");
        for name in events {
            let hook = hooks.join(name);
            fs::write(&hook, script(&self.marker, &format!("file {name}"))).unwrap();
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
            git(&self.root, &["config", "--add", "hook.marker.event", name]);
        }
        let command = format!("echo config >> '{}'", self.marker.display());
        git(&self.root, &["config", "hook.marker.command", &command]);
        git(
            &self.root,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
    }

    fn push(&self, file: &str, rewrite: bool) -> PullHead {
        if rewrite {
            git(&self.author, &["reset", "-q", "--soft", "main"]);
        }
        fs::write(self.author.join(file), format!("{file}\n")).unwrap();
        git(&self.author, &["add", file]);
        git(&self.author, &["commit", "-q", "-m", file]);
        for reference in ["refs/heads/feat", "refs/pull/1/head"] {
            let refspec = format!("+HEAD:{reference}");
            git(
                &self.author,
                &["push", "-q", self.base.to_str().unwrap(), &refspec],
            );
        }
        PullHead {
            reference: BranchRef::try_from("refs/heads/feat".to_owned()).unwrap(),
            oid: Oid::try_from(git(&self.author, &["rev-parse", "HEAD"])).unwrap(),
            from: HeadFrom::Same { edits: true },
        }
    }

    fn tried(&self, head: &PullHead) {
        let tried = self
            .core
            .try_pull_request(self.root.to_str().unwrap(), &key(), head, &self.copy)
            .unwrap();
        assert!(matches!(tried, PullCheckout::Ready { .. }), "{tried:?}");
    }

    fn update(&self, from: &Path, head: &PullHead, seen: &Oid, replace: bool) {
        let path = from.to_str().unwrap();
        let updated = self
            .core
            .update_pull_request(path, &key(), head, seen, replace)
            .unwrap();
        assert!(
            matches!(&updated, PullCheckout::Ready { tip, .. } if *tip == head.oid),
            "{updated:?}"
        );
    }

    fn ran(&self) -> String {
        fs::read_to_string(&self.marker).unwrap_or_default()
    }

    /// Git itself finds and runs the hook in the copy, so the hook is live
    /// and only L1 Git left it alone.
    fn assert_live(&self, name: &str, args: &[&str]) {
        let mut all = vec!["hook", "run", name, "--"];
        all.extend(args);
        git(&self.copy, &all);
        assert!(!self.ran().is_empty(), "{name} did not run under plain Git");
        fs::remove_file(&self.marker).unwrap();
    }
}

#[test]
fn try_runs_no_post_checkout_hook_from_the_hooks_folder_or_config() {
    let world = World::new(false);
    world.untracked_hooks(&["post-checkout"]);
    let head = world.push("feat.txt", false);
    world.tried(&head);
    assert_eq!(world.ran(), "", "a hook ran on Try");
    assert!(world.copy.join("feat.txt").exists());
    world.assert_live("post-checkout", &["0", "0", "1"]);
}

#[test]
fn update_runs_no_post_merge_hook_from_the_hooks_folder_or_config() {
    let world = World::new(false);
    let first = world.push("feat.txt", false);
    world.tried(&first);
    world.untracked_hooks(&["post-merge"]);
    let pushed = world.push("more.txt", false);
    world.update(&world.root, &pushed, &first.oid, false);
    assert_eq!(world.ran(), "", "a hook ran on Update");
    assert!(world.copy.join("more.txt").exists());
    world.assert_live("post-merge", &["0"]);
}

#[test]
fn a_hooks_path_into_the_pull_requests_own_files_runs_none_of_them() {
    let world = World::new(true);
    let hooks = world.copy.join("hooks");
    git(
        &world.root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let first = world.push("feat.txt", false);
    world.tried(&first);
    let pushed = world.push("more.txt", false);
    world.update(&world.copy, &pushed, &first.oid, false);
    let rewritten = world.push("again.txt", true);
    world.update(&world.copy, &rewritten, &pushed.oid, true);
    assert_eq!(world.ran(), "", "the pull request's hook ran");
    world.assert_live("post-checkout", &["0", "0", "1"]);
    let removed = world
        .core
        .remove_pull_request(
            world.copy.to_str().unwrap(),
            &key(),
            &rewritten,
            &rewritten.oid,
        )
        .unwrap();
    assert!(
        matches!(removed, PullCheckout::Absent { .. }),
        "{removed:?}"
    );
    assert!(!world.copy.exists());
    assert_eq!(world.ran(), "", "the pull request's hook ran on Remove");
}
