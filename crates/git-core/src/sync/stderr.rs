use crate::{FetchFailure, remotes::display_url};

const SUMMARY_LINES: usize = 2;
const SUMMARY_CHARS: usize = 300;

/// Sorts a failed fetch by what the user can do about it. Git writes these
/// messages in English because every command runs with `LC_ALL=C`.
pub(super) fn classify(stderr: &str) -> FetchFailure {
    let has = |needles: &[&str]| needles.iter().any(|needle| stderr.contains(needle));
    if has(&["cannot lock ref", ".lock': File exists", "Unable to create"]) {
        FetchFailure::Busy
    } else if has(&[
        "Permission denied (",
        "Authentication failed",
        "could not read Username",
        "could not read Password",
        "terminal prompts disabled",
        "Host key verification failed",
        "Repository not found",
        "returned error: 401",
        "returned error: 403",
    ]) {
        FetchFailure::Auth
    } else if has(&[
        "Could not resolve host",
        "Connection refused",
        "Connection timed out",
        "Operation timed out",
        "Network is unreachable",
        "No route to host",
        "Connection reset",
        "Connection closed by",
        "Failed to connect",
    ]) {
        FetchFailure::Network
    } else {
        FetchFailure::Other
    }
}

/// The first lines of Git's message, with credentials removed from any URL.
pub(super) fn summarize(stderr: &str) -> String {
    let summary = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(SUMMARY_LINES)
        .map(redact)
        .collect::<Vec<_>>()
        .join(" ");
    if summary.is_empty() {
        return "Git failed without a message.".into();
    }
    match summary.char_indices().nth(SUMMARY_CHARS) {
        Some((end, _)) => format!("{}…", &summary[..end]),
        None => summary,
    }
}

fn redact(line: &str) -> String {
    let mut redacted = String::with_capacity(line.len());
    let mut token = String::new();
    for c in line.chars() {
        if c.is_whitespace() || c == '\'' || c == '"' {
            redacted.push_str(&redact_token(&token));
            token.clear();
            redacted.push(c);
        } else {
            token.push(c);
        }
    }
    redacted.push_str(&redact_token(&token));
    redacted
}

fn redact_token(token: &str) -> String {
    if token.contains("://") {
        display_url(token).0
    } else {
        token.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_captured_fetch_errors() {
        let cases = [
            (
                "git@example.invalid: Permission denied (publickey).\nfatal: Could not read from remote repository.\n",
                FetchFailure::Auth,
            ),
            (
                "fatal: could not read Username for 'https://example.test': terminal prompts disabled\n",
                FetchFailure::Auth,
            ),
            (
                "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found\n",
                FetchFailure::Auth,
            ),
            (
                "Host key verification failed.\nfatal: Could not read from remote repository.\n",
                FetchFailure::Auth,
            ),
            (
                "ssh: Could not resolve hostname example.invalid: nodename nor servname provided, or not known\n",
                FetchFailure::Network,
            ),
            (
                "fatal: unable to access 'https://example.test/a.git/': Could not resolve host: example.test\n",
                FetchFailure::Network,
            ),
            (
                "ssh: connect to host 127.0.0.1 port 1: Connection refused\n",
                FetchFailure::Network,
            ),
            (
                "error: cannot lock ref 'refs/remotes/origin/main': is at 1 but expected 2\n",
                FetchFailure::Busy,
            ),
            (
                "fatal: Unable to create '/r/.git/shallow.lock': File exists.\n",
                FetchFailure::Busy,
            ),
            (
                "fatal: '/gone/remote.git' does not appear to be a git repository\n",
                FetchFailure::Other,
            ),
            (
                "error: unable to open /r/.git/objects/pack/tmp_pack_1: Permission denied\n",
                FetchFailure::Other,
            ),
        ];
        for (stderr, expected) in cases {
            assert_eq!(classify(stderr), expected, "{stderr}");
        }
    }

    #[test]
    fn summarizes_two_lines_without_credentials() {
        assert_eq!(
            summarize(
                "\nfatal: unable to access 'https://ada:s3cret@example.test/team/app.git/?token=abc': Could not resolve host: example.test\nhint: one\nhint: two\n"
            ),
            "fatal: unable to access 'https://example.test/team/app.git/': Could not resolve host: example.test hint: one"
        );
        assert_eq!(
            summarize("fatal: repository ssh://ada:pw@example.test:2222/x.git not found"),
            "fatal: repository ssh://example.test:2222/x.git not found"
        );
        assert_eq!(summarize(" \n"), "Git failed without a message.");
        assert_eq!(summarize(&"x".repeat(400)), format!("{}…", "x".repeat(300)));
    }
}
