#![cfg(unix)]

#[allow(dead_code)]
mod support;

use l1_git_host::{Endpoints, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use support::{FakeGh, FakeGitHub, Reply};

/// The only test in this binary, because it sets environment tokens that gh
/// would otherwise report and hand over.
#[test]
fn environment_tokens_never_reach_gh() {
    // SAFETY: this binary runs one test, and no other thread exists yet.
    unsafe {
        std::env::set_var("GH_TOKEN", "gho_environment");
        std::env::set_var("GITHUB_TOKEN", "gho_environment");
    }
    let dir = tempfile::tempdir().unwrap();
    let gh = FakeGh::new("signed-in");
    gh.token("octo", "gho_octo");
    let github = FakeGitHub::start();
    github.answer("gho_octo", Reply::user("octo", 1, Some("repo")));
    github.answer("gho_environment", Reply::user("octo", 1, Some("repo")));
    let host = Host::new(HostConfig {
        dir: dir.path().to_owned(),
        vault: VaultChoice::Memory,
        gh: GhChoice::At(gh.path()),
        github: Endpoints::loopback(&github.url()).unwrap(),
    });

    let probe = run(&host, serde_json::from_str(r#"{"op":"probeGh"}"#).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(probe).unwrap()["data"]["kind"],
        "ready",
        "gh reported the environment token's account"
    );
    let request: Request = serde_json::from_str(r#"{"op":"connectGh","login":"octo"}"#).unwrap();
    run(&host, request).unwrap();
    let sent: Vec<_> = github
        .seen()
        .into_iter()
        .filter_map(|seen| seen.authorization)
        .collect();
    assert_eq!(sent, ["Bearer gho_octo"]);
}
