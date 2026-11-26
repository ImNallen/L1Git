use serde_json::json;

use super::{Write, Written};
use crate::github::{Endpoints, Verified};
use crate::support::{FakeGh, FakeGitHub};
use crate::vault::MemoryVault;
use crate::wire::Access;
use crate::{GhChoice, Host, Request, run};

fn signed_in(api: &str, gh: &FakeGh) -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::with_vault(
        dir.path().to_owned(),
        Endpoints::loopback(api).unwrap(),
        GhChoice::At(gh.path()),
        Box::<MemoryVault>::default(),
    );
    host.commit(
        &host.lock_writes(),
        Verified::assume("gho_one", "octo", 1, Access::Private),
    )
    .unwrap();
    (dir, host)
}

fn comment() -> Write {
    serde_json::from_value(json!({"kind": "comment", "pull": "PR_1", "body": "Hi"})).unwrap()
}

#[test]
fn a_write_never_leaves_once_its_connection_ended() {
    let github = FakeGitHub::start();
    let gh = FakeGh::new("signed-in");
    let (_dir, host) = signed_in(&github.url(), &gh);
    let (generation, _) = host.connection().unwrap();
    let written = host
        .as_connection(generation, |github| {
            drop(run(&host, Request::Disconnect {}).unwrap());
            github.write(comment())
        })
        .unwrap();
    assert!(matches!(written, Written::NotSent { .. }), "{written:?}");
    assert!(github.questions().is_empty());
}

#[test]
fn a_github_nobody_listens_on_is_not_sent() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let gh = FakeGh::new("signed-in");
    let (_dir, host) = signed_in(&format!("http://127.0.0.1:{port}/"), &gh);
    let login = host.connection().unwrap().1;
    assert!(matches!(
        host.write(&login, comment()),
        Written::NotSent { .. }
    ));
}
