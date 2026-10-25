#![cfg(unix)]

use l1_git_core::{Coordinator, Expect, Limits, Operation, stop_all_git, worktree_status};
use std::{env, fs, path::Path, process::Command, thread, time::Duration};

const CHILD: &str = "L1GIT_STOP_WRITE_REPOSITORY";
const HELD: &str = "held by another Git process\n";

fn git(path: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    for (key, _) in env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command.arg("-C").arg(path).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}");
}

fn stage(coordinator: &Coordinator, root: &str) -> Result<(), String> {
    let status = worktree_status(root).map_err(|error| error.message)?;
    coordinator
        .write(
            root,
            &Operation::StageFiles {
                entries: status.entries,
            },
            &Expect { head: status.head },
        )
        .map(drop)
        .map_err(|error| format!("{:?}: {}", error.kind, error.message))
}

/// Runs only inside the process that
/// `a_write_that_reaches_the_index_after_quitting_began_leaves_it_alone`
/// starts, because `stop_all_git` stops every Git command in the process.
#[test]
fn quitting_process() {
    let Ok(root) = env::var(CHILD) else {
        return;
    };
    let root = Path::new(&root);
    let undo = root.parent().unwrap().join("undo");
    let coordinator = Coordinator::new(Limits::default(), &undo);
    let path = root.to_str().unwrap().to_owned();
    fs::write(root.join("f"), "first\n").unwrap();
    stage(&coordinator, &path).unwrap();
    fs::write(root.join("f"), "second\n").unwrap();
    let store = fs::read_dir(&undo).unwrap().next().unwrap().unwrap().path();
    let history = fs::File::open(store.join("lock")).unwrap();
    history.lock().unwrap();
    fs::write(root.join(".git/index.lock"), HELD).unwrap();

    let writer = thread::spawn(move || stage(&coordinator, &path));
    thread::sleep(Duration::from_secs(1));
    stop_all_git();
    drop(history);
    let answer = writer.join().unwrap();
    println!("answer: {answer:?}");
    std::process::exit(0);
}

#[test]
fn a_write_that_reaches_the_index_after_quitting_began_leaves_it_alone() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("commit.gpgSign", "false"),
        ("core.hooksPath", "/dev/null"),
    ] {
        git(&root, &["config", key, value]);
    }
    fs::write(root.join("f"), "one\n").unwrap();
    git(&root, &["add", "f"]);
    git(&root, &["commit", "--quiet", "-m", "initial"]);

    let output = Command::new(env::current_exe().unwrap())
        .args(["quitting_process", "--exact", "--nocapture"])
        .env(CHILD, &root)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    let answer = stdout
        .lines()
        .find_map(|line| line.strip_prefix("answer: "))
        .unwrap_or_else(|| panic!("{stdout}"));
    assert!(answer.contains("quitting"), "{answer}");
    assert_eq!(
        fs::read_to_string(root.join(".git/index.lock")).unwrap(),
        HELD
    );
}
