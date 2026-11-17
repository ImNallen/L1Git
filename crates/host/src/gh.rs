use std::collections::HashMap;
use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;

use crate::GhChoice;
use crate::github::Login;
use crate::process::{self, RunError};
use crate::wire::{Access, GhProbe};

const HOSTNAME: &str = "github.com";
/// `auth status` checks each token with GitHub, so it gets network time.
const PROBE_DEADLINE: Duration = Duration::from_secs(20);
const OUTPUT_CAP: usize = 64 * 1024;
const EXE: &str = if cfg!(windows) { "gh.exe" } else { "gh" };

pub(crate) struct Gh(GhChoice);

impl Gh {
    pub(crate) fn new(choice: GhChoice) -> Gh {
        Gh(choice)
    }

    fn locate(&self) -> Option<PathBuf> {
        match &self.0 {
            GhChoice::At(path) => path.is_file().then(|| path.clone()),
            GhChoice::Search => locate_in(env::var_os("PATH").as_deref(), &known_dirs(), |path| {
                path.is_file()
            }),
        }
    }

    pub(crate) fn probe(&self) -> GhProbe {
        let Some(path) = self.locate() else {
            return GhProbe::Missing;
        };
        let mut command = command(&path);
        command.args(["auth", "status", "--hostname", HOSTNAME, "--json", "hosts"]);
        let failed = |detail: String| GhProbe::Failed { detail };
        match process::run(command, PROBE_DEADLINE, OUTPUT_CAP) {
            Ok(ran) => parse_status(&ran.stdout, &ran.stderr_tail, &path),
            Err(RunError::NotFound) => GhProbe::Missing,
            Err(RunError::TimedOut) => {
                failed("The GitHub CLI did not answer within 20 seconds.".to_owned())
            }
            Err(RunError::TooLarge) => {
                failed("The GitHub CLI printed far more than L1 Git expected.".to_owned())
            }
            Err(RunError::Io(error)) => {
                failed(format!("L1 Git could not run the GitHub CLI: {error}."))
            }
        }
    }
}

fn locate_in(
    path_var: Option<&OsStr>,
    known: &[PathBuf],
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    path_var
        .into_iter()
        .flat_map(env::split_paths)
        .chain(known.iter().cloned())
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(EXE))
        .find(|candidate| is_file(candidate))
}

/// Install directories that a launch from Finder or a desktop menu leaves off
/// PATH.
fn known_dirs() -> Vec<PathBuf> {
    let var = |name: &str| {
        env::var_os(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    #[cfg(target_os = "macos")]
    let dirs = [
        Some(PathBuf::from("/opt/homebrew/bin")),
        Some(PathBuf::from("/usr/local/bin")),
        Some(PathBuf::from("/opt/local/bin")),
        var("HOME").map(|home| home.join(".local/bin")),
    ];
    #[cfg(windows)]
    let dirs = [
        var("ProgramFiles").map(|dir| dir.join("GitHub CLI")),
        var("LOCALAPPDATA").map(|dir| dir.join(r"Programs\GitHub CLI")),
        var("USERPROFILE").map(|home| home.join(r"scoop\shims")),
        var("ProgramData").map(|dir| dir.join(r"chocolatey\bin")),
    ];
    #[cfg(all(unix, not(target_os = "macos")))]
    let dirs = [
        Some(PathBuf::from("/usr/bin")),
        Some(PathBuf::from("/usr/local/bin")),
        Some(PathBuf::from("/snap/bin")),
        Some(PathBuf::from("/home/linuxbrew/.linuxbrew/bin")),
        var("HOME").map(|home| home.join(".linuxbrew/bin")),
        var("HOME").map(|home| home.join(".local/bin")),
    ];
    dirs.into_iter().flatten().collect()
}

/// `GH_CONFIG_DIR` stays, because it is where a custom gh keeps the user's login.
fn is_token_or_gh_variable(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    (name.starts_with("GH_") && name != "GH_CONFIG_DIR")
        || name == "GITHUB_TOKEN"
        || name == "GITHUB_ENTERPRISE_TOKEN"
}

fn command(gh: &Path) -> Command {
    let mut command = Command::new(gh);
    for (name, _) in env::vars_os() {
        if is_token_or_gh_variable(&name) {
            command.env_remove(name);
        }
    }
    command.envs([
        ("GH_PROMPT_DISABLED", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
        ("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1"),
        ("GH_SPINNER_DISABLED", "1"),
        ("NO_COLOR", "1"),
        ("CLICOLOR", "0"),
    ]);
    command
}

#[derive(Deserialize)]
struct Report {
    hosts: HashMap<String, Vec<Account>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    state: String,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    login: String,
    #[serde(default)]
    token_source: String,
    scopes: Option<String>,
}

/// Trusts stdout, not the exit code: `--json` exits 0 even when signed out.
fn parse_status(stdout: &[u8], stderr: &str, path: &Path) -> GhProbe {
    let Ok(report) = serde_json::from_slice::<Report>(stdout) else {
        return if stderr.contains("unknown flag") {
            GhProbe::Outdated
        } else if stderr.contains("not logged in") {
            GhProbe::SignedOut
        } else {
            GhProbe::Failed {
                detail: described(stderr),
            }
        };
    };
    let Some(account) = report
        .hosts
        .get(HOSTNAME)
        .into_iter()
        .flatten()
        .find(|account| account.active && !from_environment(&account.token_source))
    else {
        return GhProbe::SignedOut;
    };
    let Ok(login) = Login::try_from(account.login.clone()) else {
        return GhProbe::SignedOut;
    };
    match account.state.as_str() {
        "success" => GhProbe::Ready {
            login,
            access: Access::from_scopes(account.scopes.as_deref()),
            path: path.display().to_string(),
        },
        "error" => GhProbe::Broken { login },
        _ => GhProbe::Failed {
            detail: "The GitHub CLI could not reach GitHub to check its sign-in.".to_owned(),
        },
    }
}

/// gh names an environment variable as the source of an environment token,
/// and a file or `keyring` otherwise.
fn from_environment(token_source: &str) -> bool {
    token_source.starts_with("GH_") || token_source.starts_with("GITHUB_")
}

fn described(stderr: &str) -> String {
    let line = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty());
    match line {
        Some(line) => {
            let line: String = redact(line).chars().take(300).collect();
            format!("The GitHub CLI said: {line}")
        }
        None => "The GitHub CLI stopped without saying why.".to_owned(),
    }
}

fn redact(text: &str) -> String {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut redacted = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(word) {
        redacted.push_str(&rest[..start]);
        let length = rest[start..]
            .find(|c: char| !word(c))
            .unwrap_or(rest.len() - start);
        let candidate = &rest[start..start + length];
        redacted.push_str(if token_shaped(candidate) {
            "[redacted]"
        } else {
            candidate
        });
        rest = &rest[start + length..];
    }
    redacted.push_str(rest);
    redacted
}

fn token_shaped(word: &str) -> bool {
    ["gho_", "ghp_", "ghs_", "ghu_", "ghr_", "github_pat_"]
        .iter()
        .any(|prefix| word.len() > prefix.len() && word.starts_with(prefix))
        || (word.len() == 40 && word.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(stdout: &str, stderr: &str) -> GhProbe {
        parse_status(stdout.as_bytes(), stderr, Path::new("/opt/homebrew/bin/gh"))
    }

    fn recorded(name: &str) -> GhProbe {
        let read = |extension: &str| {
            std::fs::read_to_string(format!(
                "{}/tests/fixtures/gh/{name}.{extension}",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap_or_default()
        };
        probe(&read("stdout"), &read("stderr"))
    }

    fn status_of(accounts: &str) -> GhProbe {
        probe(&format!(r#"{{"hosts":{{"github.com":[{accounts}]}}}}"#), "")
    }

    fn login(raw: &str) -> Login {
        Login::try_from(raw.to_owned()).unwrap()
    }

    #[test]
    fn recorded_gh_states() {
        assert_eq!(
            recorded("signed-in"),
            GhProbe::Ready {
                login: login("octo"),
                access: Access::Private,
                path: "/opt/homebrew/bin/gh".to_owned()
            }
        );
        assert_eq!(recorded("signed-out"), GhProbe::SignedOut);
        assert_eq!(
            recorded("bad-token"),
            GhProbe::Broken {
                login: login("octo")
            }
        );
        assert_eq!(
            recorded("env-token"),
            GhProbe::SignedOut,
            "an account gh reads from GH_TOKEN is never offered"
        );
        assert_eq!(recorded("unknown-flag"), GhProbe::Outdated);
        assert_eq!(
            probe("", "You are not logged into any GitHub hosts."),
            GhProbe::SignedOut
        );
    }

    #[test]
    fn status_picks_the_active_account_and_reads_its_scopes() {
        let account = |login: &str, active: bool, scopes: &str| {
            format!(
                r#"{{"state":"success","active":{active},"host":"github.com","login":"{login}","tokenSource":"keyring","scopes":"{scopes}"}}"#
            )
        };
        let two = format!(
            "{},{}",
            account("hubot", false, "repo"),
            account("octo", true, "read:org")
        );
        assert_eq!(
            status_of(&two),
            GhProbe::Ready {
                login: login("octo"),
                access: Access::PublicOnly,
                path: "/opt/homebrew/bin/gh".to_owned()
            }
        );
        assert!(matches!(
            status_of(&account("octo", true, "")),
            GhProbe::Ready {
                access: Access::PerRepository,
                ..
            }
        ));
        assert_eq!(
            status_of(&account("octo", false, "repo")),
            GhProbe::SignedOut,
            "no active account"
        );
        assert_eq!(
            status_of(&account("octo", true, "repo").replace("keyring", "GITHUB_TOKEN")),
            GhProbe::SignedOut,
            "a valid environment token still names its account, and is still not offered"
        );
    }

    #[test]
    fn unexpected_status_output_fails_without_echoing_tokens() {
        let GhProbe::Failed { detail } = probe("<html>", "error: token gho_abc123 rejected") else {
            panic!("garbage stdout is a failure");
        };
        assert!(!detail.contains("gho_abc123"), "{detail}");
        assert!(detail.contains("rejected"), "{detail}");
    }

    #[test]
    fn access_from_scopes() {
        for (scopes, access) in [
            (Some("gist, read:org, repo, workflow"), Access::Private),
            (Some("repo"), Access::Private),
            (Some("public_repo, read:org"), Access::PublicOnly),
            (Some("repo:status"), Access::PublicOnly),
            (Some(""), Access::PerRepository),
            (None, Access::PerRepository),
        ] {
            assert_eq!(Access::from_scopes(scopes), access, "{scopes:?}");
        }
    }

    #[test]
    fn redact_masks_token_shapes() {
        assert_eq!(
            redact("bad gho_16C7e42F292c6912E7710c838347Ae178B4a, ghp_x and github_pat_11A_b"),
            "bad [redacted], [redacted] and [redacted]"
        );
        assert_eq!(
            redact("sha 0123456789abcdef0123456789abcdef01234567 ok"),
            "sha [redacted] ok"
        );
        assert_eq!(
            redact("You are not logged into any GitHub hosts."),
            "You are not logged into any GitHub hosts."
        );
    }

    #[test]
    fn scrub_list() {
        let removed: Vec<&str> = [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "GH_HOST",
            "GH_DEBUG",
            "GH_FORCE_TTY",
            "GH_CONFIG_DIR",
            "PATH",
            "HOME",
            "GITHUB_ACTIONS",
        ]
        .into_iter()
        .filter(|name| is_token_or_gh_variable(OsStr::new(name)))
        .collect();
        assert_eq!(
            removed,
            [
                "GH_TOKEN",
                "GITHUB_TOKEN",
                "GH_ENTERPRISE_TOKEN",
                "GITHUB_ENTERPRISE_TOKEN",
                "GH_HOST",
                "GH_DEBUG",
                "GH_FORCE_TTY"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn locate_finds_homebrew_from_finder_path() {
        let finder = OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin");
        let known = [PathBuf::from("/opt/homebrew/bin")];
        assert_eq!(
            locate_in(Some(finder), &known, |path| path
                == Path::new("/opt/homebrew/bin/gh")),
            Some(PathBuf::from("/opt/homebrew/bin/gh"))
        );
        assert_eq!(locate_in(None, &known, |_| false), None);
    }

    #[cfg(unix)]
    #[test]
    fn locate_prefers_path_order_and_skips_relative_entries() {
        let path = OsStr::new("bin:/first:/second");
        let known = [PathBuf::from("/known")];
        let everywhere = |_: &Path| true;
        assert_eq!(
            locate_in(Some(path), &known, everywhere),
            Some(PathBuf::from("/first/gh"))
        );
        assert_eq!(
            locate_in(Some(path), &known, |path| path.starts_with("/known")
                || path.starts_with("bin")),
            Some(PathBuf::from("/known/gh")),
            "a relative PATH entry never supplies gh"
        );
    }
}
