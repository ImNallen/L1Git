#![cfg(unix)]

use l1_git_core::{
    BranchRef, BranchState, Changes, Coordinator, ErrorKind, FetchMode, GitHubRepository, HeadFrom,
    Limits, NoPush, Oid, PublishOptions, PullCheckout, PullHead, PullKey, PushAvailability,
    PushUnavailable, Pushes, Relation, RepositoryError, StaleReason,
};
use std::{
    fs,
    num::{NonZeroU32, NonZeroUsize},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

const BASE_URL: &str = "https://github.com/octo/app.git";
const FORK_URL: &str = "https://github.com/maja/app.git";

fn run_git(path: &Path, args: &[&str]) -> (bool, String, String) {
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
    (
        output.status.success(),
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn git(path: &Path, args: &[&str]) -> String {
    let (ok, stdout, stderr) = run_git(path, args);
    assert!(ok, "git {args:?}: {stderr}");
    stdout
}

fn oid(text: &str) -> Oid {
    Oid::try_from(text.to_owned()).unwrap()
}

fn branch(name: &str) -> BranchRef {
    BranchRef::try_from(format!("refs/heads/{name}")).unwrap()
}

fn github(owner: &str) -> GitHubRepository {
    GitHubRepository {
        owner: owner.into(),
        repo: "app".into(),
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Main {
    head: String,
    index: String,
    changed: String,
}

struct World {
    _directory: TempDir,
    top: PathBuf,
    base: PathBuf,
    fork: PathBuf,
    author: PathBuf,
    root: PathBuf,
    core: Coordinator,
    main: Main,
}

impl World {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let top = directory.path().canonicalize().unwrap();
        let (base, fork, author, root) = (
            top.join("base.git"),
            top.join("fork.git"),
            top.join("author"),
            top.join("repo"),
        );
        git(&top, &["init", "-q", "--bare", "-b", "main", "base.git"]);
        git(&top, &["init", "-q", "--bare", "-b", "main", "fork.git"]);
        git(&top, &["init", "-q", "-b", "main", "author"]);
        fs::write(author.join("shared.txt"), "shared\n").unwrap();
        git(&author, &["add", "shared.txt"]);
        git(&author, &["commit", "-q", "-m", "base"]);
        for bare in [&base, &fork] {
            git(&author, &["push", "-q", bare.to_str().unwrap(), "main"]);
        }
        git(&top, &["clone", "-q", base.to_str().unwrap(), "repo"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
            ("remote.origin.url", BASE_URL),
        ] {
            git(&root, &["config", key, value]);
        }
        for (bare, url) in [(&base, BASE_URL), (&fork, FORK_URL)] {
            let key = format!("url.{}.insteadOf", bare.display());
            git(&root, &["config", &key, url]);
        }
        fs::write(root.join("staged.txt"), "staged\n").unwrap();
        git(&root, &["add", "staged.txt"]);
        fs::write(root.join("shared.txt"), "mine\n").unwrap();
        let mut world = Self {
            core: Coordinator::new(Limits::default(), top.join("undo")),
            _directory: directory,
            top,
            base,
            fork,
            author,
            root,
            main: Default::default(),
        };
        world.main = world.main_state();
        world
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn key(number: u32) -> PullKey {
        PullKey {
            github: github("octo"),
            number: NonZeroU32::new(number).unwrap(),
        }
    }

    fn main_state(&self) -> Main {
        Main {
            head: git(&self.root, &["symbolic-ref", "HEAD"]),
            index: git(&self.root, &["ls-files", "--stage"]),
            changed: fs::read_to_string(self.root.join("shared.txt")).unwrap(),
        }
    }

    fn assert_main_untouched(&self) {
        assert_eq!(self.main_state(), self.main, "the main worktree changed");
    }

    fn commit(&self, branch: &str, file: &str) -> Oid {
        let exists = run_git(
            &self.author,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .0;
        if exists {
            git(&self.author, &["switch", "-q", branch]);
        } else {
            git(&self.author, &["switch", "-q", "-c", branch, "main"]);
        }
        fs::write(self.author.join(file), format!("{file}\n")).unwrap();
        git(&self.author, &["add", file]);
        git(&self.author, &["commit", "-q", "-m", file]);
        oid(&git(&self.author, &["rev-parse", "HEAD"]))
    }

    fn rewrite(&self, branch: &str, file: &str) -> Oid {
        git(&self.author, &["switch", "-q", "-C", branch, "main"]);
        self.commit(branch, file)
    }

    /// Forced, as GitHub moves `refs/pull/<number>/head` after the head branch.
    fn publish(&self, to: &[(&Path, String)]) {
        for (bare, reference) in to {
            let refspec = format!("+HEAD:{reference}");
            git(
                &self.author,
                &["push", "-q", bare.to_str().unwrap(), &refspec],
            );
        }
    }

    fn same(&self, number: u32, name: &str, file: &str) -> PullHead {
        let head = self.commit(name, file);
        self.publish(&[
            (&self.base, format!("refs/heads/{name}")),
            (&self.base, format!("refs/pull/{number}/head")),
        ]);
        PullHead {
            reference: branch(name),
            oid: head,
            from: HeadFrom::Same { edits: true },
        }
    }

    fn forked(&self, number: u32, name: &str, file: &str, edits: bool) -> PullHead {
        let head = self.commit(name, file);
        self.publish(&[
            (&self.fork, format!("refs/heads/{name}")),
            (&self.base, format!("refs/pull/{number}/head")),
        ]);
        PullHead {
            reference: branch(name),
            oid: head,
            from: HeadFrom::Fork {
                repository: github("maja"),
                edits,
            },
        }
    }

    fn read(&self, number: u32, head: &PullHead) -> PullCheckout {
        self.core
            .pull_request_checkout(self.path(), &Self::key(number), head)
            .unwrap()
    }

    fn folder(&self, number: u32) -> PathBuf {
        self.top
            .join(".worktrees")
            .join(format!("repo-pr-{number}"))
    }

    fn try_at(
        &self,
        number: u32,
        head: &PullHead,
        folder: &Path,
    ) -> Result<PullCheckout, RepositoryError> {
        self.core
            .try_pull_request(self.path(), &Self::key(number), head, folder)
    }

    fn tried(&self, number: u32, head: &PullHead) -> PullCheckout {
        self.try_at(number, head, &self.folder(number)).unwrap()
    }

    fn update(
        &self,
        number: u32,
        head: &PullHead,
        seen: &Oid,
        replace: bool,
    ) -> Result<PullCheckout, RepositoryError> {
        self.core
            .update_pull_request(self.path(), &Self::key(number), head, seen, replace)
    }

    fn remove(&self, number: u32, head: &PullHead, seen: &Oid) -> PullCheckout {
        self.core
            .remove_pull_request(self.path(), &Self::key(number), head, seen)
            .unwrap()
    }

    fn tip(&self, name: &str) -> Option<Oid> {
        let (ok, tip, _) = run_git(
            &self.root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
        );
        ok.then(|| oid(&tip))
    }

    fn config(&self, key: &str) -> Option<String> {
        let (ok, value, _) = run_git(&self.root, &["config", "--get", key]);
        ok.then_some(value)
    }

    fn upstream(&self, name: &str) -> String {
        git(
            &self.root,
            &[
                "for-each-ref",
                "--format=%(upstream)",
                &format!("refs/heads/{name}"),
            ],
        )
    }

    fn worktrees(&self) -> usize {
        git(&self.root, &["worktree", "list", "--porcelain"])
            .lines()
            .filter(|line| line.starts_with("worktree "))
            .count()
    }

    fn fetch_heads(&self) {
        git(
            &self.root,
            &["fetch", "-q", "origin", "+refs/pull/*:refs/l1test/*"],
        );
    }
}

fn ready(checkout: &PullCheckout) -> (&Oid, &Relation, &Path, &Changes) {
    match checkout {
        PullCheckout::Ready {
            tip,
            relation,
            worktree,
            ..
        } => (tip, relation, Path::new(&worktree.root), &worktree.changes),
        other => panic!("not ready: {other:?}"),
    }
}

#[test]
fn an_untried_pull_request_plans_pr_n_beside_the_main_worktree_and_where_pushes_go() {
    let world = World::new();
    let refs = git(&world.root, &["for-each-ref"]);
    let cases = [
        (
            1,
            world.same(1, "feat", "feat.txt"),
            Pushes::ToPullRequest {
                remote: "origin".into(),
                destination: branch("feat"),
                adds_remote: false,
            },
        ),
        (
            2,
            world.forked(2, "fix", "fix.txt", true),
            Pushes::ToPullRequest {
                remote: "maja".into(),
                destination: branch("fix"),
                adds_remote: true,
            },
        ),
        (
            3,
            world.forked(3, "ro", "ro.txt", false),
            Pushes::Nowhere {
                why: NoPush::NoEdits,
            },
        ),
        (
            6,
            PullHead {
                from: HeadFrom::Same { edits: false },
                ..world.same(6, "read", "read.txt")
            },
            Pushes::Nowhere {
                why: NoPush::ReadOnly,
            },
        ),
    ];
    for (number, head, pushes) in cases {
        match world.read(number, &head) {
            PullCheckout::Absent { branch: pr, plan } => {
                assert_eq!(pr, branch(&format!("pr/{number}")));
                assert_eq!(Path::new(&plan.folder), world.folder(number));
                assert_eq!(plan.pushes, pushes, "#{number}");
            }
            other => panic!("#{number} is not absent: {other:?}"),
        }
    }
    let gone = PullHead {
        from: HeadFrom::Gone,
        ..world.forked(4, "old", "old.txt", true)
    };
    let PullCheckout::Absent { plan, .. } = world.read(4, &gone) else {
        panic!("#4 is not absent");
    };
    assert_eq!(
        plan.pushes,
        Pushes::Nowhere {
            why: NoPush::ForkGone
        }
    );
    git(
        &world.root,
        &[
            "remote",
            "add",
            "maja",
            "https://example.com/maja/other.git",
        ],
    );
    let fork = world.forked(5, "other", "other.txt", true);
    let PullCheckout::Absent { plan, .. } = world.read(5, &fork) else {
        panic!("#5 is not absent");
    };
    assert_eq!(
        plan.pushes,
        Pushes::ToPullRequest {
            remote: "maja-app".into(),
            destination: branch("other"),
            adds_remote: true,
        }
    );
    git(&world.root, &["remote", "remove", "maja"]);
    assert_eq!(
        git(&world.root, &["for-each-ref"]),
        refs,
        "a read moved a ref"
    );
    world.assert_main_untouched();
}

#[test]
fn a_same_repository_pull_request_tracks_its_branch_on_the_base_remote() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    let tried = world.tried(1, &head);
    let (tip, relation, root, changes) = ready(&tried);
    assert_eq!((tip, relation), (&head.oid, &Relation::UpToDate));
    assert_eq!(
        (root, changes),
        (world.folder(1).as_path(), &Changes::Clean)
    );
    let PullCheckout::Ready { worktree, .. } = &tried else {
        unreachable!()
    };
    assert!(!worktree.main && worktree.trouble.is_none());
    assert_eq!(git(root, &["symbolic-ref", "HEAD"]), "refs/heads/pr/1");
    assert_eq!(world.upstream("pr/1"), "refs/remotes/origin/feat");
    assert_eq!(
        world.config("branch.pr/1.remote").as_deref(),
        Some("origin")
    );
    assert_eq!(
        world.config("branch.pr/1.merge").as_deref(),
        Some("refs/heads/feat")
    );
    assert!(
        world
            .core
            .undo_history(world.path())
            .unwrap()
            .undo
            .is_none()
    );
    world.assert_main_untouched();
}

#[test]
fn a_same_repository_pull_request_you_cannot_push_to_still_tracks_its_branch() {
    let world = World::new();
    let head = PullHead {
        from: HeadFrom::Same { edits: false },
        ..world.same(1, "feat", "feat.txt")
    };
    world.tried(1, &head);
    assert_eq!(world.upstream("pr/1"), "refs/remotes/origin/feat");
    let pushed = PullHead {
        oid: world.commit("feat", "more.txt"),
        ..head.clone()
    };
    world.publish(&[(&world.base, "refs/heads/feat".into())]);
    let updated = world.update(1, &pushed, &head.oid, false).unwrap();
    assert_eq!(ready(&updated).0, &pushed.oid);
    assert!(matches!(
        world
            .core
            .prepare_push(world.folder(1).to_str().unwrap())
            .unwrap(),
        PushAvailability::Ready { .. }
    ));
    world.assert_main_untouched();
}

#[test]
fn a_fork_that_takes_edits_gets_a_remote_named_for_its_owner() {
    let world = World::new();
    let head = world.forked(2, "fix", "fix.txt", true);
    let tried = world.tried(2, &head);
    assert_eq!(ready(&tried).1, &Relation::UpToDate);
    assert_eq!(world.config("remote.maja.url").as_deref(), Some(FORK_URL));
    assert_eq!(
        world.config("remote.maja.fetch").as_deref(),
        Some("+refs/heads/*:refs/remotes/maja/*")
    );
    assert_eq!(world.upstream("pr/2"), "refs/remotes/maja/fix");
    let PullCheckout::Ready { .. } = world.read(2, &head) else {
        panic!("not ready");
    };
    let Ok(PushAvailability::Ready { intent }) =
        world.core.prepare_push(world.folder(2).to_str().unwrap())
    else {
        panic!("Push is not ready for pr/2");
    };
    assert_eq!(
        (intent.remote.as_str(), &intent.destination),
        ("maja", &branch("fix"))
    );
    world.assert_main_untouched();
}

#[test]
fn a_read_only_fork_follows_the_pull_ref_and_push_refuses_it() {
    let world = World::new();
    let head = world.forked(3, "ro", "ro.txt", false);
    let remotes = git(&world.root, &["remote"]);
    let tried = world.tried(3, &head);
    assert_eq!(ready(&tried).1, &Relation::UpToDate);
    assert_eq!(git(&world.root, &["remote"]), remotes);
    assert_eq!(
        world.config("branch.pr/3.remote").as_deref(),
        Some("origin")
    );
    assert_eq!(
        world.config("branch.pr/3.merge").as_deref(),
        Some("refs/pull/3/head")
    );
    let overview = world.core.overview(world.path(), FetchMode::Local).unwrap();
    let row = overview
        .branches
        .iter()
        .find(|row| row.reference == branch("pr/3"))
        .unwrap();
    assert!(
        matches!(row.state, BranchState::Untracked),
        "{:?}",
        row.state
    );
    assert_eq!(
        world
            .core
            .prepare_push(world.folder(3).to_str().unwrap())
            .unwrap(),
        PushAvailability::Unavailable {
            reason: PushUnavailable::PullRequestHead
        }
    );
    assert!(matches!(
        world
            .core
            .publish_options(world.folder(3).to_str().unwrap())
            .unwrap(),
        PublishOptions::Unavailable { .. }
    ));
    world.assert_main_untouched();
}

#[test]
fn a_gone_fork_is_fetched_by_id_from_the_base_and_moves_no_remote_ref() {
    let world = World::new();
    let head = PullHead {
        from: HeadFrom::Gone,
        ..world.forked(4, "old", "old.txt", true)
    };
    fs::remove_dir_all(&world.fork).unwrap();
    let remote_refs = || git(&world.root, &["for-each-ref", "refs/remotes/"]);
    let before = remote_refs();
    let tried = world.tried(4, &head);
    assert_eq!(ready(&tried).0, &head.oid);
    assert_eq!(remote_refs(), before);
    assert_eq!(
        world.config("branch.pr/4.merge").as_deref(),
        Some("refs/pull/4/head")
    );
    world.assert_main_untouched();
}

#[test]
fn a_try_refused_for_its_folder_adds_no_remote() {
    let world = World::new();
    let head = world.forked(2, "fix", "fix.txt", true);
    let folder = world.folder(2);
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("here.txt"), "here\n").unwrap();
    let config = fs::read_to_string(world.root.join(".git/config")).unwrap();
    let refused = world.try_at(2, &head, &folder).unwrap_err();
    assert_ne!(refused.kind, ErrorKind::GitFailed, "{refused:?}");
    assert_eq!(
        fs::read_to_string(world.root.join(".git/config")).unwrap(),
        config
    );
    let worktree = world.top.join("other");
    git(
        &world.root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "other",
            worktree.to_str().unwrap(),
        ],
    );
    let config = fs::read_to_string(world.root.join(".git/config")).unwrap();
    world.try_at(2, &head, &worktree).unwrap_err();
    assert_eq!(
        fs::read_to_string(world.root.join(".git/config")).unwrap(),
        config
    );
    assert_eq!(world.tip("pr/2"), None);
}

#[test]
fn trying_twice_answers_the_same_copy() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    world.tried(1, &head);
    let again = world
        .try_at(1, &head, &world.top.join("elsewhere"))
        .unwrap();
    assert_eq!(ready(&again).2, world.folder(1));
    assert_eq!(world.worktrees(), 2);
    assert!(!world.top.join("elsewhere").exists());
}

#[test]
fn a_kept_branch_is_checked_out_again_at_its_own_tip() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    let folder = world.folder(1);
    world.tried(1, &head);
    fs::write(folder.join("mine.txt"), "mine\n").unwrap();
    git(&folder, &["add", "mine.txt"]);
    git(&folder, &["commit", "-q", "-m", "mine"]);
    let mine = world.tip("pr/1").unwrap();
    let PullCheckout::Parked { relation, tip, .. } = world.remove(1, &head, &mine) else {
        panic!("not parked");
    };
    assert_eq!((relation, &tip), (Relation::Ahead { commits: 1 }, &mine));
    assert!(!folder.exists());
    let again = world.tried(1, &head);
    assert_eq!(ready(&again).0, &mine);
    assert_eq!(world.upstream("pr/1"), "refs/remotes/origin/feat");
    world.assert_main_untouched();
}

#[test]
fn the_authors_push_fast_forwards_the_copy_and_keeps_an_unrelated_change() {
    let world = World::new();
    let first = world.same(1, "feat", "feat.txt");
    let folder = world.folder(1);
    world.tried(1, &first);
    fs::write(folder.join("shared.txt"), "edited in the copy\n").unwrap();
    let pushed = world.same(1, "feat", "more.txt");
    assert_eq!(
        ready(&world.read(1, &pushed)).1,
        &Relation::Unfetched,
        "a read fetches nothing"
    );
    let updated = world.update(1, &pushed, &first.oid, false).unwrap();
    let (tip, relation, _, changes) = ready(&updated);
    assert_eq!((tip, relation), (&pushed.oid, &Relation::UpToDate));
    assert_eq!(changes, &Changes::Uncommitted);
    assert_eq!(
        fs::read_to_string(folder.join("shared.txt")).unwrap(),
        "edited in the copy\n"
    );
    assert!(folder.join("more.txt").exists());
    world.assert_main_untouched();
}

#[test]
fn a_force_push_moves_the_copy_only_with_replace_and_the_tip_the_user_saw() {
    let world = World::new();
    let first = world.same(1, "feat", "feat.txt");
    let folder = world.folder(1);
    world.tried(1, &first);
    fs::write(folder.join("notes.txt"), "untracked\n").unwrap();
    let rewritten = world.rewrite("feat", "again.txt");
    world.publish(&[
        (&world.base, "refs/heads/feat".into()),
        (&world.base, "refs/pull/1/head".into()),
    ]);
    let head = PullHead {
        oid: rewritten,
        ..first.clone()
    };
    let refused = world.update(1, &head, &first.oid, false).unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Conflict, "{refused:?}");
    assert_eq!(
        ready(&world.read(1, &head)).1,
        &Relation::Diverged {
            ahead: 1,
            behind: 1
        }
    );
    let stale = world.update(1, &head, &head.oid, true).unwrap_err();
    assert_eq!(
        stale.kind,
        ErrorKind::StaleView {
            reason: StaleReason::BranchChanged
        }
    );
    assert_eq!(world.tip("pr/1").as_ref(), Some(&first.oid));
    let replaced = world.update(1, &head, &first.oid, true).unwrap();
    assert_eq!(ready(&replaced).0, &head.oid);
    assert_eq!(
        fs::read_to_string(folder.join("notes.txt")).unwrap(),
        "untracked\n"
    );
    world.assert_main_untouched();
}

#[test]
fn replace_onto_an_untracked_file_the_pull_request_adds_names_it() {
    let world = World::new();
    let first = world.same(1, "feat", "feat.txt");
    let folder = world.folder(1);
    world.tried(1, &first);
    let rewritten = PullHead {
        oid: world.rewrite("feat", "collide.txt"),
        ..first.clone()
    };
    world.publish(&[
        (&world.base, "refs/heads/feat".into()),
        (&world.base, "refs/pull/1/head".into()),
    ]);
    fs::write(folder.join("collide.txt"), "mine\n").unwrap();
    let refused = world.update(1, &rewritten, &first.oid, true).unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Conflict, "{refused:?}");
    assert!(refused.message.contains("collide.txt"), "{refused:?}");
    assert_eq!(world.tip("pr/1"), Some(first.oid));
    assert_eq!(
        fs::read_to_string(folder.join("collide.txt")).unwrap(),
        "mine\n"
    );
}

#[test]
fn replace_during_a_merge_in_the_copy_says_to_finish_it_and_moves_nothing() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    world.tried(1, &head);
    let folder = world.folder(1);
    fs::write(folder.join("shared.txt"), "mine\n").unwrap();
    git(&folder, &["commit", "-q", "-am", "mine"]);
    let mine = world.tip("pr/1").unwrap();
    git(&folder, &["switch", "-q", "-c", "theirs", "main"]);
    fs::write(folder.join("shared.txt"), "theirs\n").unwrap();
    git(&folder, &["commit", "-q", "-am", "theirs"]);
    git(&folder, &["switch", "-q", "pr/1"]);
    assert!(
        !run_git(&folder, &["merge", "-q", "theirs"]).0,
        "the merge conflicts"
    );
    let refused = world.update(1, &head, &mine, true).unwrap_err();
    assert_eq!(
        refused.message,
        "A merge is in progress in repo-pr-1. Finish or abort it there, then try again."
    );
    assert_eq!(world.tip("pr/1"), Some(mine));
}

#[test]
fn a_kept_branch_behind_the_head_moves_by_update_ref() {
    let world = World::new();
    let first = world.same(1, "feat", "feat.txt");
    world.tried(1, &first);
    git(
        &world.root,
        &["worktree", "remove", world.folder(1).to_str().unwrap()],
    );
    let pushed = world.same(1, "feat", "more.txt");
    let PullCheckout::Parked { tip, relation, .. } =
        world.update(1, &pushed, &first.oid, false).unwrap()
    else {
        panic!("not parked");
    };
    assert_eq!((tip, relation), (pushed.oid, Relation::UpToDate));
    world.assert_main_untouched();
}

#[test]
fn remove_deletes_a_branch_the_pull_request_holds_all_of() {
    let world = World::new();
    let first = world.same(1, "feat", "feat.txt");
    world.tried(1, &first);
    let PullCheckout::Absent { .. } = world.remove(1, &first, &first.oid) else {
        panic!("not absent");
    };
    assert_eq!(world.tip("pr/1"), None);
    assert_eq!(world.config("branch.pr/1.remote"), None);
    assert_eq!(world.worktrees(), 1);
    let PullCheckout::Absent { .. } = world.remove(1, &first, &first.oid) else {
        panic!("a second remove is not absent");
    };

    world.tried(1, &first);
    let pushed = world.same(1, "feat", "more.txt");
    world.fetch_heads();
    assert_eq!(
        ready(&world.read(1, &pushed)).1,
        &Relation::Behind { commits: 1 }
    );
    let PullCheckout::Absent { .. } = world.remove(1, &pushed, &first.oid) else {
        panic!("behind is not absent after remove");
    };
    assert_eq!(world.tip("pr/1"), None);
    world.assert_main_untouched();
}

#[test]
fn remove_asked_from_the_copy_itself_runs_from_the_main_worktree() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    world.tried(1, &head);
    let folder = world.folder(1);
    let removed = world
        .core
        .remove_pull_request(folder.to_str().unwrap(), &World::key(1), &head, &head.oid)
        .unwrap();
    assert!(
        matches!(removed, PullCheckout::Absent { .. }),
        "{removed:?}"
    );
    assert!(!folder.exists());
    world.assert_main_untouched();
}

#[test]
fn remove_runs_from_the_opened_worktree_when_the_main_one_is_bare() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    let hub = world.top.join("hub.git");
    git(
        &world.top,
        &[
            "clone",
            "-q",
            "--bare",
            world.base.to_str().unwrap(),
            "hub.git",
        ],
    );
    let insteadof = format!("url.{}.insteadOf", world.base.display());
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("core.hooksPath", "/dev/null"),
        ("remote.origin.url", BASE_URL),
        ("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"),
        (insteadof.as_str(), BASE_URL),
    ] {
        git(&hub, &["config", key, value]);
    }
    let opened = world.top.join("hub-main");
    git(
        &hub,
        &["worktree", "add", "-q", opened.to_str().unwrap(), "main"],
    );
    let path = opened.to_str().unwrap();
    let folder = world.top.join("hub-pr-1");
    world
        .core
        .try_pull_request(path, &World::key(1), &head, &folder)
        .unwrap();
    let removed = world
        .core
        .remove_pull_request(path, &World::key(1), &head, &head.oid)
        .unwrap();
    assert!(
        matches!(removed, PullCheckout::Absent { .. }),
        "{removed:?}"
    );
    assert!(!folder.exists());
    assert!(
        !run_git(
            &hub,
            &["rev-parse", "--verify", "--quiet", "refs/heads/pr/1"]
        )
        .0
    );
}

#[test]
fn remove_fetches_the_head_first_and_deletes_a_branch_the_push_holds_all_of() {
    let world = World::new();
    for (number, first) in [
        (1, world.same(1, "feat", "feat.txt")),
        (3, world.forked(3, "ro", "ro.txt", false)),
    ] {
        world.tried(number, &first);
        let name = first.reference.name().to_owned();
        let pushed = PullHead {
            oid: world.commit(&name, &format!("more-{number}.txt")),
            ..first.clone()
        };
        let home = if number == 1 {
            &world.base
        } else {
            &world.fork
        };
        world.publish(&[
            (home, format!("refs/heads/{name}")),
            (&world.base, format!("refs/pull/{number}/head")),
        ]);
        let removed = world.remove(number, &pushed, &first.oid);
        assert!(
            matches!(removed, PullCheckout::Absent { .. }),
            "#{number}: {removed:?}"
        );
        assert_eq!(world.tip(&format!("pr/{number}")), None, "#{number}");
    }
    world.assert_main_untouched();
}

#[test]
fn remove_offline_still_removes_the_worktree_and_keeps_only_a_branch_it_cannot_compare() {
    let world = World::new();
    let first = world.same(1, "feat", "feat.txt");
    world.tried(1, &first);
    let second = world.same(2, "two", "two.txt");
    world.tried(2, &second);
    let pushed = world.same(1, "feat", "more.txt");
    let offline = world.top.join("offline.git");
    fs::rename(&world.base, &offline).unwrap();
    let PullCheckout::Parked { tip, relation, .. } = world.remove(1, &pushed, &first.oid) else {
        panic!("not parked");
    };
    assert_eq!((tip, relation), (first.oid, Relation::Unfetched));
    assert!(!world.folder(1).exists());
    let removed = world.remove(2, &second, &second.oid);
    assert!(
        matches!(removed, PullCheckout::Absent { .. }),
        "{removed:?}"
    );
    assert!(!world.folder(2).exists());
    assert_eq!(world.tip("pr/2"), None);
    world.assert_main_untouched();
}

#[test]
fn remove_waits_for_a_remote_that_never_answers_only_as_long_as_a_fetch_it_can_do_without() {
    let world = World::new();
    let first = world.same(1, "feat", "feat.txt");
    world.tried(1, &first);
    let pushed = world.same(1, "feat", "more.txt");
    git(
        &world.root,
        &[
            "config",
            "remote.origin.url",
            "ssh://git@github.com/octo/app.git",
        ],
    );
    git(&world.root, &["config", "core.sshCommand", "sleep 30;:"]);
    let core = Coordinator::new(
        Limits {
            optional_fetch_deadline: Duration::from_secs(1),
            ..Limits::default()
        },
        world.top.join("undo"),
    );
    let started = Instant::now();
    let removed = core
        .remove_pull_request(world.path(), &World::key(1), &pushed, &first.oid)
        .unwrap();
    let took = started.elapsed();
    assert!(took < Duration::from_secs(10), "Remove took {took:?}");
    let PullCheckout::Parked { tip, relation, .. } = removed else {
        panic!("not parked: {removed:?}");
    };
    assert_eq!((tip, relation), (first.oid, Relation::Unfetched));
    assert!(!world.folder(1).exists());
    world.assert_main_untouched();
}

#[test]
fn remove_skips_the_fetch_when_a_fetch_it_would_wait_for_holds_the_repository_or_the_last_slot() {
    let busy = World::new();
    let other = World::new();
    let first = busy.same(1, "feat", "feat.txt");
    busy.tried(1, &first);
    let pushed = busy.same(1, "feat", "more.txt");
    for world in [&busy, &other] {
        git(
            &world.root,
            &[
                "config",
                "remote.origin.url",
                "ssh://git@github.com/octo/app.git",
            ],
        );
        git(&world.root, &["config", "core.sshCommand", "sleep 4;:"]);
    }
    let core = Coordinator::new(
        Limits {
            optional_fetch_deadline: Duration::from_secs(1),
            network_slots: NonZeroUsize::new(1).unwrap(),
            ..Limits::default()
        },
        busy.top.join("undo"),
    );
    let folder = busy.folder(1);
    for fetching in [&busy, &other] {
        thread::scope(|scope| {
            scope.spawn(|| core.overview(fetching.path(), FetchMode::Remote));
            thread::sleep(Duration::from_millis(500));
            let started = Instant::now();
            let removed = core
                .remove_pull_request(busy.path(), &World::key(1), &pushed, &first.oid)
                .unwrap();
            let took = started.elapsed();
            assert!(took < Duration::from_millis(2500), "Remove took {took:?}");
            let PullCheckout::Parked { relation, .. } = removed else {
                panic!("not parked: {removed:?}");
            };
            assert_eq!(relation, Relation::Unfetched);
            assert!(!folder.exists());
        });
        git(
            &busy.root,
            &["worktree", "add", "-q", folder.to_str().unwrap(), "pr/1"],
        );
    }
}

#[test]
fn with_no_remote_for_the_pull_requests_repository_the_copy_still_reads_and_removes() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    world.tried(1, &head);
    let other = world.same(2, "two", "two.txt");
    git(
        &world.root,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/someone/else.git",
        ],
    );
    let no_remote = Pushes::Nowhere {
        why: NoPush::NoRemote,
    };
    let PullCheckout::Absent { plan, .. } = world.read(2, &other) else {
        panic!("#2 is not absent");
    };
    assert_eq!(plan.pushes, no_remote);
    let tried = world.try_at(2, &other, &world.folder(2)).unwrap_err();
    assert!(
        tried
            .message
            .contains("No remote of this repository is github.com/octo/app"),
        "{tried:?}"
    );
    let PullCheckout::Absent { plan, .. } = world.remove(1, &head, &head.oid) else {
        panic!("#1 is not absent");
    };
    assert_eq!(plan.pushes, no_remote);
    assert!(!world.folder(1).exists());
    assert_eq!(world.tip("pr/1"), None);
    world.assert_main_untouched();
}

#[test]
fn remove_refuses_a_worktree_with_uncommitted_files_and_keeps_everything() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    let folder = world.folder(1);
    world.tried(1, &head);
    fs::write(folder.join("notes.txt"), "mine\n").unwrap();
    let refused = world
        .core
        .remove_pull_request(world.path(), &World::key(1), &head, &head.oid)
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Conflict, "{refused:?}");
    assert!(folder.join("notes.txt").exists());
    assert_eq!(world.tip("pr/1"), Some(head.oid));
}

#[test]
fn a_worktree_git_cannot_make_leaves_no_branch_behind() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    let parent = world.top.join(".worktrees");
    fs::create_dir(&parent).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
    let refused = world.try_at(1, &head, &world.folder(1));
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(world.tip("pr/1"), None);
    assert_eq!(world.config("branch.pr/1.merge"), None);
    let PullCheckout::Absent { .. } = world.read(1, &head) else {
        panic!("not absent");
    };
}

#[test]
fn a_try_git_cannot_make_puts_a_kept_branchs_settings_back() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    world.tried(1, &head);
    let folder = world.folder(1);
    fs::write(folder.join("mine.txt"), "mine\n").unwrap();
    git(&folder, &["add", "mine.txt"]);
    git(&folder, &["commit", "-q", "-m", "mine"]);
    let mine = world.tip("pr/1").unwrap();
    world.remove(1, &head, &mine);
    git(
        &world.root,
        &["config", "branch.pr/1.merge", "refs/heads/mine"],
    );
    let parent = world.top.join(".worktrees");
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
    let refused = world.try_at(1, &head, &folder);
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(world.tip("pr/1"), Some(mine));
    assert_eq!(
        world.config("branch.pr/1.merge").as_deref(),
        Some("refs/heads/mine")
    );
    assert_eq!(
        world.config("branch.pr/1.remote").as_deref(),
        Some("origin")
    );
}

#[test]
fn a_branch_remove_cannot_delete_after_the_worktree_went_answers_it_kept() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    world.tried(1, &head);
    let lock = world.root.join(".git/refs/heads/pr/1.lock");
    fs::write(&lock, "").unwrap();
    let removed = world
        .core
        .remove_pull_request(world.path(), &World::key(1), &head, &head.oid);
    fs::remove_file(&lock).unwrap();
    let Ok(PullCheckout::Parked { tip, relation, .. }) = removed else {
        panic!("not parked: {removed:?}");
    };
    assert_eq!((tip, relation), (head.oid.clone(), Relation::UpToDate));
    assert!(!world.folder(1).exists());
    assert_eq!(world.worktrees(), 1);
    let PullCheckout::Absent { .. } = world.remove(1, &head, &head.oid) else {
        panic!("a second remove is not absent");
    };
    assert_eq!(world.tip("pr/1"), None);
}

#[test]
fn a_failing_post_checkout_hook_still_answers_the_copy_with_its_trouble() {
    let world = World::new();
    let head = world.same(1, "feat", "feat.txt");
    let hooks = world.top.join("hooks");
    fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("post-checkout");
    fs::write(&hook, "#!/bin/sh\necho no >&2\nexit 1\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &world.root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let PullCheckout::Ready { worktree, .. } = world.tried(1, &head) else {
        panic!("not ready");
    };
    let trouble = worktree.trouble.unwrap();
    assert!(
        matches!(trouble.kind, ErrorKind::AfterHookFailed { ref output } if output.contains("no")),
        "{trouble:?}"
    );
}
