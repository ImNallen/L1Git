use super::{RangeFile, files_between, merge_base, missing};
use crate::{
    Oid, RepositoryError,
    git::{self, Deadline, LocalRead, Merging},
    repository::root,
};
use serde::Serialize;
use std::path::Path;

/// What the author changed since the commit you reviewed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SinceReview {
    Ready {
        /// What `files` start from: `reviewed`, or the reviewed change replayed
        /// onto today's merge base.
        since: Oid,
        from_base: FromBase,
        /// The pull request as you reviewed it, from where `reviewed` forked from
        /// `base`, read as `range_files` reads it.
        reviewed: Vec<RangeFile>,
        /// From `since` to `head`, so `range_patches(since, head)` answers in
        /// this order.
        files: Vec<RangeFile>,
        /// Git could not read every file's contents in one of the two lists, as
        /// in a partial clone, so its files have no line counts.
        content_missing: bool,
    },
    /// A partial clone that does not have the folders of these commits.
    TreesMissing,
    /// This clone does not have these commits.
    Missing { oids: Vec<Oid> },
    /// No commit is in the history of both `base` and `reviewed`, or of both
    /// `base` and `head`. A `shallow` clone may lack it.
    Unrelated { shallow: bool },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FromBase {
    /// The pull request forks where it did when you reviewed it, so `since` is
    /// `reviewed`.
    None,
    /// The base moved under the pull request, and its changes are left out.
    LeftOut,
    /// The base moved, and Git could not tell its changes from the author's, so
    /// `since` is `reviewed` and they show too.
    Untold { why: Untold },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Untold {
    /// A shallow clone's merge bases can be older than the real ones.
    Shallow,
    /// Replaying your review hit a conflict that keeping its side of each hunk
    /// does not settle, such as a file the pull request deleted and the base
    /// changed.
    Conflict,
    /// Git could not read every file the replay needs, as in a partial clone.
    Unreadable,
}

pub fn since_review(
    path: &str,
    base: &Oid,
    reviewed: &Oid,
    head: &Oid,
) -> Result<SinceReview, RepositoryError> {
    since_review_within(
        path,
        base,
        reviewed,
        head,
        Deadline::of(LocalRead::SinceReview),
    )
}

pub(crate) fn since_review_within(
    path: &str,
    base: &Oid,
    reviewed: &Oid,
    head: &Oid,
    deadline: Deadline,
) -> Result<SinceReview, RepositoryError> {
    let root = root(path, deadline)?;
    let oids = missing(&root, &[base, reviewed, head], deadline)?;
    if !oids.is_empty() {
        return Ok(SinceReview::Missing { oids });
    }
    let shallow = git::read(&root, &["rev-parse", "--is-shallow-repository"], deadline)?;
    let shallow = git::line(&shallow) == "true";
    let (Some(old), Some(new)) = (
        merge_base(&root, reviewed, base, deadline)?,
        merge_base(&root, head, base, deadline)?,
    ) else {
        return Ok(SinceReview::Unrelated { shallow });
    };
    let Some(before) = files_between(&root, [&old, reviewed], deadline)? else {
        return Ok(SinceReview::TreesMissing);
    };
    let (since, from_base) = if old == new {
        (reviewed.clone(), FromBase::None)
    } else if shallow {
        untold(reviewed, Untold::Shallow)
    } else {
        match replay(&root, &old, &new, reviewed, deadline)? {
            Ok(tree) => (
                since_commit(&root, &tree, &new, deadline)?,
                FromBase::LeftOut,
            ),
            Err(why) => untold(reviewed, why),
        }
    };
    let Some(after) = files_between(&root, [&since, head], deadline)? else {
        return Ok(SinceReview::TreesMissing);
    };
    Ok(SinceReview::Ready {
        since,
        from_base,
        reviewed: before.files,
        files: after.files,
        content_missing: before.content_missing || after.content_missing,
    })
}

fn untold(reviewed: &Oid, why: Untold) -> (Oid, FromBase) {
    (reviewed.clone(), FromBase::Untold { why })
}

/// The tree of `reviewed`'s change from `old` applied to `new`. Where the base and
/// the pull request changed the same lines, it keeps the reviewed side, so every
/// line the author changed since differs from it.
fn replay(
    root: &Path,
    old: &Oid,
    new: &Oid,
    reviewed: &Oid,
    deadline: Deadline,
) -> Result<Result<Oid, Untold>, RepositoryError> {
    let Some((tree, conflicted)) = git::merge_tree(
        root,
        Some(old.as_str()),
        new.as_str(),
        reviewed.as_str(),
        Merging::PinnedFavoringTheirs,
        deadline,
    )?
    else {
        return Ok(Err(Untold::Unreadable));
    };
    if conflicted.is_empty() {
        return Ok(Ok(tree));
    }
    // A conflict that keeping the reviewed side of each hunk does not settle can
    // still leave the reviewed version in the tree, as when the base deleted a file
    // the pull request changed. Anything else would hide a change from you.
    let mut args = vec![
        "--literal-pathspecs",
        "diff-tree",
        "-r",
        "--quiet",
        "--no-renames",
        tree.as_str(),
        reviewed.as_str(),
        "--",
    ];
    args.extend(conflicted.iter().map(String::as_str));
    let compared = git::run_objects(root, &args, deadline)?;
    Ok(match compared.status.code() {
        Some(0) => Ok(tree),
        Some(1) => Err(Untold::Conflict),
        _ => Err(Untold::Unreadable),
    })
}

/// A commit of `tree` on `parent` whose id depends on nothing else. It needs no
/// identity, nothing signs it, and the same replay names the same commit, so a
/// read writes at most one. Git prunes it with the other loose objects.
fn since_commit(
    root: &Path,
    tree: &Oid,
    parent: &Oid,
    deadline: Deadline,
) -> Result<Oid, RepositoryError> {
    let body = format!(
        "tree {}\nparent {}\nauthor L1 Git <l1git@localhost> 0 +0000\ncommitter L1 Git <l1git@localhost> 0 +0000\n\nYour review, replayed onto the base of today's pull request.\n",
        tree.as_str(),
        parent.as_str()
    );
    let written = git::read_with_input(
        root,
        &["hash-object", "-t", "commit", "-w", "--stdin"],
        body.into_bytes(),
        deadline,
    )?;
    Oid::try_from(git::line(&written))
}
