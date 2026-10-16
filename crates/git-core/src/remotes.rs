use crate::{GitHubRepository, Remote, RepositoryError, git};
use std::path::Path;
use url::Url;

pub(crate) fn read(path: &Path) -> Result<Vec<Remote>, RepositoryError> {
    let names = git::read(path, &["remote"])?;
    git::text(&names)
        .lines()
        .map(|name| {
            let output = git::run(
                path,
                &["config", "--null", "--get", &format!("remote.{name}.url")],
            )?;
            let raw = git::text(output.stdout.strip_suffix(&[0]).unwrap_or(&output.stdout));
            let (url, github) = display_url(&raw);
            Ok(Remote {
                name: name.to_owned(),
                url,
                github,
            })
        })
        .collect()
}

pub(crate) fn display_url(raw: &str) -> (String, Option<GitHubRepository>) {
    if let Ok(mut url) = Url::parse(raw) {
        let github = if matches!(url.scheme(), "https" | "ssh")
            && url.host_str() == Some("github.com")
            && url.port().is_none()
        {
            github_path(url.path())
        } else {
            None
        };
        if url.cannot_be_a_base() {
            return ("Local or unrecognized remote".into(), None);
        }
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        return (url.to_string(), github);
    }
    if let Some((host, path)) = raw.split_once(':') {
        let hostname = host.rsplit('@').next().unwrap_or(host);
        if !hostname.contains('/') && !hostname.is_empty() {
            let github = if hostname == "github.com" {
                github_path(path)
            } else {
                None
            };
            return (format!("{hostname}:{path}"), github);
        }
    }
    ("Local or unrecognized remote".into(), None)
}

fn github_path(path: &str) -> Option<GitHubRepository> {
    let mut parts = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .split('/');
    let owner = parts.next()?;
    let repo = parts
        .next()?
        .strip_suffix(".git")
        .unwrap_or_else(|| path.trim_end_matches('/').rsplit('/').next().unwrap_or(""));
    let valid = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    };
    if parts.next().is_some() || !valid(owner) || !valid(repo) {
        return None;
    }
    Some(GitHubRepository {
        owner: owner.into(),
        repo: repo.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_github_and_redacts_credentials() {
        for raw in [
            "https://token:secret@github.com/alice/project.git?token=secret",
            "ssh://git@github.com/alice/project.git",
            "git@github.com:alice/project.git",
        ] {
            let (display, github) = display_url(raw);
            let github = github.unwrap();
            assert_eq!(github.owner, "alice");
            assert_eq!(github.repo, "project");
            assert!(!display.contains("secret"));
            assert!(!display.contains("token"));
            assert!(!display.contains("@"));
        }
        for raw in [
            "https://github.com.evil/alice/project",
            "https://example.com/a/b",
            "http://github.com/a/b",
            "git@github.com:a/b/c",
            "https://github.com/a/b%2fc",
        ] {
            assert!(display_url(raw).1.is_none(), "{raw}");
        }
    }
}
