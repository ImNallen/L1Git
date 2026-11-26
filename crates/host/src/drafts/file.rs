use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{fs, io, process};

use serde::{Deserialize, Serialize};

use super::{Book, BookKey};
use crate::github::ApiBase;
use crate::state::unix_millis;
use crate::wire::{ErrorKind, Failure};

const VERSION: u64 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u64,
    pulls: Vec<Book>,
}

/// Read alone first, so a newer build's shape is never parsed as this one's.
#[derive(Deserialize)]
struct Version {
    version: u64,
}

/// `drafts.json` while this process holds its lock. The system lets go of the
/// lock when the process ends, however it ends.
pub(super) struct Shelf {
    dir: PathBuf,
    pulls: Vec<Book>,
    /// Where an unreadable `drafts.json` went, when opening moved it.
    pub(super) set_aside: Option<String>,
    _lock: fs::File,
}

impl Shelf {
    /// Held from the read to the save, so another L1 Git on this folder never
    /// saves over a change it didn't read.
    pub(super) fn open(dir: &Path) -> Result<Shelf, Failure> {
        let open = || -> io::Result<fs::File> {
            fs::create_dir_all(dir)?;
            let file = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(dir.join("drafts.lock"))?;
            file.lock()?;
            Ok(file)
        };
        let lock = open().map_err(|_| unwritable())?;
        let (pulls, set_aside) = load(dir)?;
        Ok(Shelf {
            dir: dir.to_owned(),
            pulls,
            set_aside,
            _lock: lock,
        })
    }

    /// Takes out one pull request's book, or a new empty one, and says
    /// whether there is room to keep a new one.
    pub(super) fn take(&mut self, api: &ApiBase, key: &BookKey) -> (Book, bool) {
        let found = self.pulls.iter().position(|book| {
            &book.api == api
                && book.login == key.login
                && book.repository == key.repository
                && book.number == key.number
        });
        match found {
            Some(index) => (self.pulls.remove(index), true),
            None => (
                Book {
                    api: api.clone(),
                    login: key.login.clone(),
                    repository: key.repository.clone(),
                    number: key.number,
                    drafts: Vec::new(),
                    sent: Vec::new(),
                },
                self.pulls.len() < super::MOST_PULLS,
            ),
        }
    }

    /// Fails only when `drafts.json` still holds what it held before. A book
    /// with nothing in it is left out.
    pub(super) fn save(mut self, book: Book) -> Result<(), Failure> {
        if !book.drafts.is_empty() || !book.sent.is_empty() {
            self.pulls.push(book);
        }
        save(&self.dir, self.pulls)
    }
}

/// An unreadable file, such as one a power loss emptied, would refuse every
/// save after it. It moves aside instead, kept for whoever wants to look,
/// and the drafts start again.
fn load(dir: &Path) -> Result<(Vec<Book>, Option<String>), Failure> {
    let path = dir.join("drafts.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), None)),
        Err(_) => return Err(unreadable()),
    };
    match serde_json::from_slice::<Version>(&bytes) {
        Ok(Version { version }) if version > VERSION => {
            return Err(Failure::new(
                ErrorKind::Storage,
                "A newer version of L1 Git saved the drafts on this computer. L1 Git left them as they are; update it to see them.",
            ));
        }
        Ok(Version { version: VERSION }) => {
            if let Ok(file) = serde_json::from_slice::<File>(&bytes) {
                return Ok((file.pulls, None));
            }
        }
        _ => {}
    }
    let aside = dir.join(format!("drafts.corrupt-{}.json", unix_millis()));
    fs::rename(&path, &aside).map_err(|_| unreadable())?;
    Ok((Vec::new(), Some(aside.display().to_string())))
}

fn unreadable() -> Failure {
    Failure::new(
        ErrorKind::Storage,
        "L1 Git can't read the drafts saved on this computer, so it left them as they are and saved nothing.",
    )
}

fn unwritable() -> Failure {
    Failure::new(
        ErrorKind::Storage,
        "L1 Git could not save this draft. Check that its configuration folder is writable.",
    )
}

/// Every save writes a file of its own, so no other save can rename it away.
static SAVES: AtomicU64 = AtomicU64::new(0);

fn save(dir: &Path, pulls: Vec<Book>) -> Result<(), Failure> {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("drafts.") && name.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
        }
    }
    let temporary = dir.join(format!(
        "drafts.{}.{}.tmp",
        process::id(),
        SAVES.fetch_add(1, Ordering::Relaxed)
    ));
    let write = || -> io::Result<()> {
        let bytes = serde_json::to_vec(&File {
            version: VERSION,
            pulls,
        })?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, dir.join("drafts.json"))
    };
    if write().is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(unwritable());
    }
    // The rename saved it. Syncing the folder keeps the rename through a
    // power loss, and failing to doesn't undo it.
    #[cfg(unix)]
    let _ = fs::File::open(dir).and_then(|folder| folder.sync_all());
    Ok(())
}
