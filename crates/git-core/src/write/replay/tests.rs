use super::*;

#[test]
fn cutting_the_conflicts_block_keeps_every_real_line() {
    for (merge_msg, comment, kept) in [
        (
            "theirs\n\nbody\n# real line\n\n# Conflicts:\n#\tf.txt\n#\tg.txt\n",
            "#",
            "theirs\n\nbody\n# real line\n",
        ),
        ("theirs\n\n; Conflicts:\n;\tf.txt\n", ";", "theirs\n"),
        ("theirs\n\n// Conflicts:\n//\tf.txt\n", "//", "theirs\n"),
        (
            "theirs\n\n# Conflicts:\n#\told.txt\n\n# Conflicts:\n#\tf.txt\n",
            "#",
            "theirs\n\n# Conflicts:\n#\told.txt\n",
        ),
        (
            "theirs\n\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\n# Everything below it will be ignored.\n#\n# Conflicts:\n#\tf.txt\n",
            "#",
            "theirs\n",
        ),
    ] {
        assert_eq!(cut_conflicts_block(merge_msg, comment), kept, "{merge_msg}");
    }
}

#[test]
fn cutting_changes_nothing_without_a_trailing_block() {
    for (merge_msg, comment) in [
        ("theirs\n\nbody\n", "#"),
        ("theirs\n\n# Conflicts:\n", "#"),
        ("theirs\n\n# Conflicts:\n#\tf.txt\nmore body\n", "#"),
        ("theirs\n\n# Conflicts:\n#\tf.txt\n", ";"),
        ("# Conflicts:", "#"),
        ("", "#"),
    ] {
        assert_eq!(cut_conflicts_block(merge_msg, comment), merge_msg);
    }
}
