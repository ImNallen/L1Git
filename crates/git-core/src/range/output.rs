use super::RangeStatus;
use crate::{
    FilePatch, Oid, RepositoryError, git,
    repository::{PATCH_LIMIT, text_patch},
};
use std::io::{self, BufRead, Read};

const PIECE: u64 = 64 * 1024;
const BLOCK: &[u8] = b"diff --git ";

pub(super) struct Change {
    pub(super) path: Vec<u8>,
    /// A renamed file's old path and similarity.
    pub(super) from: Option<(Vec<u8>, u8)>,
    pub(super) status: RangeStatus,
    pub(super) old: Side,
    pub(super) new: Side,
}

/// One side of a change, with a mode of zeros when it has no file.
pub(super) struct Side {
    pub(super) mode: Vec<u8>,
    oid: Vec<u8>,
}

impl Side {
    pub(super) fn exists(&self) -> bool {
        self.mode.iter().any(|digit| *digit != b'0')
    }

    pub(super) fn blob(&self) -> Result<Option<Oid>, RepositoryError> {
        self.exists()
            .then(|| Oid::try_from(git::text(&self.oid)).map_err(|_| git::malformed()))
            .transpose()
    }
}

impl Change {
    /// Git shows a change of type as a deletion and an addition.
    fn blocks(&self) -> usize {
        match self.status {
            RangeStatus::TypeChanged => 2,
            _ => 1,
        }
    }
}

fn malformed() -> io::Error {
    io::ErrorKind::InvalidData.into()
}

pub(super) fn unreadable(error: io::Error) -> RepositoryError {
    if error.kind() == io::ErrorKind::InvalidData {
        git::malformed()
    } else {
        git::read_failed()
    }
}

fn field(output: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut field = Vec::new();
    output.read_until(0, &mut field)?;
    if field.pop() != Some(0) {
        return Err(malformed());
    }
    Ok(field)
}

/// Reads `--raw -z` records up to the first byte that starts none.
pub(super) fn changes(output: &mut impl BufRead) -> io::Result<Vec<Change>> {
    let mut changes = Vec::new();
    while output.fill_buf()?.first() == Some(&b':') {
        let record = field(output)?;
        let columns: Vec<_> = record[1..].split(|byte| *byte == b' ').collect();
        let [old_mode, new_mode, old_oid, new_oid, status] = columns[..] else {
            return Err(malformed());
        };
        let side = |mode: &[u8], oid: &[u8]| Side {
            mode: mode.to_vec(),
            oid: oid.to_vec(),
        };
        let (status, from) = match status {
            b"A" => (RangeStatus::Added, None),
            b"D" => (RangeStatus::Deleted, None),
            b"M" => (RangeStatus::Modified, None),
            b"T" => (RangeStatus::TypeChanged, None),
            [b'R', similarity @ ..] => {
                let similarity = number(similarity)?;
                (RangeStatus::Renamed, Some((field(output)?, similarity)))
            }
            _ => return Err(malformed()),
        };
        changes.push(Change {
            path: field(output)?,
            from,
            status,
            old: side(old_mode, old_oid),
            new: side(new_mode, new_oid),
        });
    }
    Ok(changes)
}

/// Reads the `--numstat -z` record of `change`, which has no counts for a
/// binary file.
pub(super) fn counts(output: &mut impl BufRead, change: &Change) -> io::Result<Option<(u64, u64)>> {
    let record = field(output)?;
    let mut columns = record.splitn(3, |byte| *byte == b'\t');
    let (Some(added), Some(deleted), Some(path)) = (columns.next(), columns.next(), columns.next())
    else {
        return Err(malformed());
    };
    let path = match &change.from {
        None => path.to_vec(),
        Some((from, _)) if path.is_empty() && field(output)? == *from => field(output)?,
        Some(_) => return Err(malformed()),
    };
    if path != change.path {
        return Err(malformed());
    }
    Ok(match (added, deleted) {
        (b"-", b"-") => None,
        _ => Some((number(added)?, number(deleted)?)),
    })
}

fn number<T: std::str::FromStr>(digits: &[u8]) -> io::Result<T> {
    std::str::from_utf8(digits)
        .ok()
        .and_then(|digits| digits.parse().ok())
        .ok_or_else(malformed)
}

pub(super) struct Patches {
    pub(super) changes: Vec<Change>,
    /// Of the first changes, up to the limit.
    pub(super) patches: Vec<FilePatch>,
}

/// Where to stop reading patches.
#[derive(Clone, Copy)]
pub(super) struct Limit {
    /// Of all texts together.
    pub(super) bytes: usize,
    pub(super) files: usize,
}

/// Every line of a hunk starts with a space, a sign, or a backslash, and a
/// header quotes a path's newlines, so only a block's first line starts with
/// `BLOCK`. A line can be longer than memory allows, so it arrives in pieces.
pub(super) fn read_patches(output: &mut impl BufRead, limit: Limit) -> io::Result<Patches> {
    let changes = changes(output)?;
    if !changes.is_empty() && !field(output)?.is_empty() {
        return Err(malformed());
    }
    let mut patches = Vec::with_capacity(changes.len());
    let mut kept = 0;
    let mut open: Option<Open> = None;
    let mut piece = Vec::new();
    let mut line_start = true;
    loop {
        piece.clear();
        output.take(PIECE).read_until(b'\n', &mut piece)?;
        let first = line_start && piece.starts_with(BLOCK);
        match &mut open {
            Some(open) if first && open.blocks_left > 0 => open.next_block(),
            _ if first || piece.is_empty() => {
                if let Some(open) = open.take() {
                    let patch = open.finish()?;
                    if let FilePatch::Text { patch, .. } = &patch {
                        kept += patch.len();
                    }
                    if kept > limit.bytes {
                        break;
                    }
                    patches.push(patch);
                    if patches.len() == limit.files {
                        break;
                    }
                }
                if piece.is_empty() {
                    if patches.len() != changes.len() {
                        return Err(malformed());
                    }
                    break;
                }
                let change = changes.get(patches.len()).ok_or_else(malformed)?;
                open = Some(Open::new(change.blocks()));
            }
            _ => {}
        }
        open.as_mut().ok_or_else(malformed)?.add(&piece, line_start);
        line_start = piece.ends_with(b"\n");
    }
    Ok(Patches { changes, patches })
}

/// The patch being read.
struct Open {
    blocks_left: usize,
    in_header: bool,
    binary: bool,
    bytes: u64,
    /// Empty once `bytes` passes the limit.
    kept: Vec<u8>,
}

impl Open {
    fn new(blocks: usize) -> Self {
        Self {
            blocks_left: blocks - 1,
            in_header: true,
            binary: false,
            bytes: 0,
            kept: Vec::new(),
        }
    }

    fn next_block(&mut self) {
        self.blocks_left -= 1;
        self.in_header = true;
    }

    fn add(&mut self, piece: &[u8], line_start: bool) {
        if self.in_header && line_start {
            self.in_header = !piece.starts_with(b"@@ ");
            self.binary |= self.in_header && piece.starts_with(b"Binary files ");
        }
        self.bytes += piece.len() as u64;
        if self.bytes <= PATCH_LIMIT as u64 {
            self.kept.extend_from_slice(piece);
        } else {
            self.kept = Vec::new();
        }
    }

    fn finish(self) -> io::Result<FilePatch> {
        if self.blocks_left > 0 {
            return Err(malformed());
        }
        Ok(if self.binary {
            FilePatch::Binary
        } else if self.bytes > PATCH_LIMIT as u64 {
            FilePatch::TooLarge { bytes: self.bytes }
        } else {
            text_patch(&self.kept)
        })
    }
}
