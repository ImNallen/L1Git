use l1_git_core::{BranchRef, ErrorKind, Oid};

#[test]
fn accepts_only_local_branches_and_full_object_ids() {
    for valid in [
        "refs/heads/main",
        "refs/heads/feat/x-1.2",
        "refs/heads/ünïcode",
    ] {
        assert_eq!(
            BranchRef::try_from(valid.to_owned()).unwrap().as_str(),
            valid
        );
    }
    for invalid in [
        "refs/remotes/origin/main",
        "refs/tags/v1",
        "HEAD",
        "refs/heads/",
        "refs/heads/a..b",
        "refs/heads/.hidden",
        "refs/heads/x.lock",
        "refs/heads/a b",
        "refs/heads/a:b",
        "refs/heads/-x/",
        "refs/heads/@",
        "refs/heads/a@{1}",
    ] {
        let error = BranchRef::try_from(invalid.to_owned()).unwrap_err();
        assert!(matches!(error.kind, ErrorKind::InvalidRef), "{invalid}");
    }
    assert!(Oid::try_from("a".repeat(64)).is_ok());
    for invalid in ["A".repeat(40), "a".repeat(39), "g".repeat(40)] {
        let error = Oid::try_from(invalid).unwrap_err();
        assert!(matches!(error.kind, ErrorKind::InvalidOid));
    }
}
