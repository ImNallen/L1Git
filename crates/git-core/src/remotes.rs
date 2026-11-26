use crate::{
    GitHubRepository, Remote, RepositoryError,
    git::{self, Deadline},
};
use std::path::Path;
use url::Url;

pub(crate) fn names(path: &Path, deadline: Deadline) -> Result<Vec<String>, RepositoryError> {
    let names = git::read(path, &["remote"], deadline)?;
    Ok(git::text(&names).lines().map(str::to_owned).collect())
}

pub(crate) fn read(path: &Path, deadline: Deadline) -> Result<Vec<Remote>, RepositoryError> {
    names(path, deadline)?
        .into_iter()
        .map(|name| {
            let (url, github) = display_url(&raw_url(path, &name, deadline)?);
            Ok(Remote { name, url, github })
        })
        .collect()
}

/// `remote.<name>.url` as the config holds it, credentials and all.
pub(crate) fn raw_url(
    path: &Path,
    name: &str,
    deadline: Deadline,
) -> Result<String, RepositoryError> {
    let output = git::run(
        path,
        &["config", "--null", "--get", &format!("remote.{name}.url")],
        deadline,
    )?;
    Ok(git::text(
        output.stdout.strip_suffix(&[0]).unwrap_or(&output.stdout),
    ))
}

/// A fork's pull requests are opened in its `upstream`, and a clone without one
/// opens them in its `origin`.
pub(crate) fn github(remotes: Vec<Remote>) -> Option<GitHubRepository> {
    preferred(remotes, |_| true)?.github
}

/// The remote that is `github`, by the same preference.
pub(crate) fn of_github(remotes: Vec<Remote>, github: &GitHubRepository) -> Option<String> {
    Some(preferred(remotes, |remote| remote.is(github))?.name)
}

fn preferred(remotes: Vec<Remote>, matches: impl Fn(&GitHubRepository) -> bool) -> Option<Remote> {
    remotes
        .into_iter()
        .filter(|remote| remote.github.as_ref().is_some_and(&matches))
        .min_by_key(|remote| match remote.name.as_str() {
            "upstream" => 0,
            "origin" => 1,
            _ => 2,
        })
}

pub(crate) fn display_url(raw: &str) -> (String, Option<GitHubRepository>) {
    if !raw.contains("://") {
        if let Some((host, path)) = raw.split_once(':') {
            let hostname = host.rsplit('@').next().unwrap_or(host);
            if !hostname.is_empty()
                && hostname
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
            {
                let github = if hostname == "github.com" {
                    github_path(path)
                } else {
                    None
                };
                return (format!("{hostname}:{path}"), github);
            }
        }
        return ("Local or unrecognized remote".into(), None);
    }
    if let Ok(mut url) = Url::parse(raw) {
        let recognized = url.scheme() == "https" && url.port().is_none()
            || url.scheme() == "ssh" && matches!(url.port(), None | Some(22));
        let github = if recognized && url.host_str() == Some("github.com") {
            github_path(url.path())
        } else {
            None
        };
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        return (url.to_string(), github);
    }
    ("Local or unrecognized remote".into(), None)
}

/// `raw`, the URL of a remote on GitHub, pointed at `repository` instead, so
/// SSH stays SSH. Credentials, a query, and a fragment are dropped.
pub(crate) fn sibling_url(raw: &str, repository: &GitHubRepository) -> Option<String> {
    display_url(raw).1?;
    let path = |git: bool| {
        let suffix = if git { ".git" } else { "" };
        format!("{}/{}{suffix}", repository.owner, repository.repo)
    };
    if !raw.contains("://") {
        let (host, old) = raw.split_once(':')?;
        return Some(format!("{host}:{}", path(old.ends_with(".git"))));
    }
    let mut url = Url::parse(raw).ok()?;
    if url.scheme() == "https" {
        url.set_username("").ok()?;
    }
    url.set_password(None).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    let git = url.path().trim_end_matches('/').ends_with(".git");
    url.set_path(&format!("/{}", path(git)));
    Some(url.to_string())
}

fn github_path(path: &str) -> Option<GitHubRepository> {
    let mut parts = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
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
            "ssh://git@github.com:22/alice/project.git",
            "github.com:alice/project.git",
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

    #[test]
    fn a_sibling_url_keeps_the_transport_and_drops_credentials() {
        let fork = GitHubRepository {
            owner: "maja".into(),
            repo: "app".into(),
        };
        for (raw, sibling) in [
            (
                "git@github.com:octo/l1git.git",
                "git@github.com:maja/app.git",
            ),
            ("github.com:octo/l1git", "github.com:maja/app"),
            (
                "ssh://git@github.com/octo/l1git.git",
                "ssh://git@github.com/maja/app.git",
            ),
            (
                "https://token:secret@github.com/octo/l1git.git?x=1#y",
                "https://github.com/maja/app.git",
            ),
            (
                "https://github.com/octo/l1git/",
                "https://github.com/maja/app",
            ),
        ] {
            assert_eq!(sibling_url(raw, &fork).as_deref(), Some(sibling), "{raw}");
        }
        assert_eq!(sibling_url("/srv/octo/l1git.git", &fork), None);
        assert_eq!(sibling_url("https://example.com/octo/l1git", &fork), None);
    }
}
