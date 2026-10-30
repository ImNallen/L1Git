use std::{
    io,
    mem::size_of,
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command},
};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
        },
    },
};

pub(super) struct Job(OwnedHandle);

impl Job {
    pub(super) fn new() -> io::Result<Self> {
        // SAFETY: null attributes create a non-inheritable, unnamed job.
        let job = Self(owned(unsafe {
            CreateJobObjectW(std::ptr::null(), std::ptr::null())
        })?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the handle is owned and limits has the requested layout and size.
        if unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub(super) fn spawn(&self, command: &mut Command) -> io::Result<Child> {
        let mut child = command
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .spawn()?;
        let prepared = (|| {
            // SAFETY: both handles remain owned throughout assignment.
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            resume(&child)
        })();
        if let Err(error) = prepared {
            self.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(child)
    }

    pub(super) fn terminate(&self) {
        // SAFETY: this job is owned, and is never addressed by a reused process ID.
        unsafe {
            TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful API call transferred a new handle to this caller.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn resume(child: &Child) -> io::Result<()> {
    // SAFETY: the snapshot has no pointer arguments and is returned owned.
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: entry is initialized to the required size and is writable.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == child.id() {
            // SAFETY: the child is suspended before user code, so its initial thread
            // cannot exit or create another thread before this call.
            let thread =
                owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) })?;
            // SAFETY: thread owns the suspended child's initial thread handle.
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        // SAFETY: snapshot and entry remain valid for enumeration.
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "Git's suspended thread was not found",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ErrorKind,
        git::{Deadline, LocalRead, execute},
    };
    use std::{
        env, fs,
        path::Path,
        thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };

    fn helper(mode: &str, marker: &Path) -> Command {
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "git::windows::tests::process_helper",
                "--nocapture",
            ])
            .env("L1GIT_PROCESS_TEST_MODE", mode)
            .env("L1GIT_PROCESS_TEST_MARKER", marker);
        command
    }

    fn wait_for_marker(marker: &Path) {
        let start = Instant::now();
        while !fs::read_to_string(marker).is_ok_and(|text| text.parse::<u32>().is_ok()) {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "descendant did not start"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn process_helper() {
        let Ok(mode) = env::var("L1GIT_PROCESS_TEST_MODE") else {
            return;
        };
        let marker = env::var_os("L1GIT_PROCESS_TEST_MARKER").unwrap();
        let marker = Path::new(&marker);
        if mode == "descendant" {
            fs::write(marker, std::process::id().to_string()).unwrap();
        } else {
            let mut child = helper("descendant", marker).spawn().unwrap();
            thread::spawn(move || child.wait());
            wait_for_marker(marker);
            if mode == "exit" {
                return;
            }
        }
        thread::sleep(Duration::from_secs(30));
    }

    fn descendant_stopped(marker: &Path) {
        let pid = fs::read_to_string(marker).unwrap().parse().unwrap();
        // SAFETY: opening by ID is only an observation. It never terminates a process.
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            return;
        }
        let process = owned(process).unwrap();
        // SAFETY: the handle stays owned throughout this bounded wait.
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) },
            WAIT_OBJECT_0,
            "descendant survived its job"
        );
    }

    #[test]
    fn normal_exit_closes_descendant_held_stdout_and_stops_the_descendant() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("pid");
        let result = execute(
            helper("exit", &marker),
            Deadline::start(LocalRead::Snapshot, Duration::from_secs(5)),
            None,
            None,
        )
        .unwrap();
        assert!(result.status.success());
        descendant_stopped(&marker);
    }

    #[test]
    fn deadline_stops_the_whole_process_tree() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("pid");
        let result = execute(
            helper("hang", &marker),
            Deadline::start(LocalRead::Snapshot, Duration::from_secs(3)),
            None,
            None,
        );
        assert!(matches!(result, Err(error) if error.kind == ErrorKind::TimedOut));
        descendant_stopped(&marker);
    }
}
