use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct RepositoryActivity(Mutex<Admission>);

#[derive(Default)]
struct Admission {
    active: usize,
    installing: bool,
}

pub struct RepositoryPermit(Arc<RepositoryActivity>);
pub struct InstallPermit(Arc<RepositoryActivity>);

impl RepositoryActivity {
    pub fn admit(self: &Arc<Self>) -> Result<RepositoryPermit, &'static str> {
        let mut admission = self.0.lock().unwrap();
        if admission.installing {
            return Err("L1 Git is installing an update. Try again after restart.");
        }
        admission.active += 1;
        Ok(RepositoryPermit(Arc::clone(self)))
    }

    pub fn begin_install(self: &Arc<Self>) -> Result<InstallPermit, &'static str> {
        let mut admission = self.0.lock().unwrap();
        if admission.installing || admission.active != 0 {
            return Err("Repository work is still running. Wait for it to finish, then try again.");
        }
        admission.installing = true;
        Ok(InstallPermit(Arc::clone(self)))
    }
}

impl Drop for RepositoryPermit {
    fn drop(&mut self) {
        self.0.0.lock().unwrap().active -= 1;
    }
}

impl Drop for InstallPermit {
    fn drop(&mut self) {
        self.0.0.lock().unwrap().installing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn any_request_blocks_install_and_failed_install_reopens_admission() {
        let activity = Arc::new(RepositoryActivity::default());
        let first_root = activity.admit().unwrap();
        let hidden_root = activity.admit().unwrap();
        drop(first_root);
        assert!(activity.begin_install().is_err());
        drop(hidden_root);
        let install = activity.begin_install().unwrap();
        assert!(activity.admit().is_err());
        assert!(activity.begin_install().is_err());
        drop(install);
        assert!(activity.admit().is_ok());
    }

    #[test]
    fn admission_and_install_are_atomic() {
        for _ in 0..100 {
            let activity = Arc::new(RepositoryActivity::default());
            let start = Arc::new(Barrier::new(2));
            let finish = Arc::new(Barrier::new(2));
            std::thread::scope(|scope| {
                let worker = scope.spawn(|| {
                    start.wait();
                    let admitted = activity.admit();
                    finish.wait();
                    admitted
                });
                start.wait();
                let install = activity.begin_install();
                finish.wait();
                let admitted = worker.join().unwrap();
                assert_ne!(install.is_ok(), admitted.is_ok());
            });
        }
    }

    #[test]
    fn permit_belongs_to_worker_even_after_caller_is_cancelled_or_worker_panics() {
        tauri::async_runtime::block_on(async {
            let activity = Arc::new(RepositoryActivity::default());
            let permit = activity.admit().unwrap();
            let (started, start) = std::sync::mpsc::channel();
            let (finish, finishing) = std::sync::mpsc::channel();
            let (completed, completion) = std::sync::mpsc::channel();
            struct Completion(std::sync::mpsc::Sender<()>);
            impl Drop for Completion {
                fn drop(&mut self) {
                    let _ = self.0.send(());
                }
            }
            let worker = tauri::async_runtime::spawn_blocking(move || {
                let _completion = Completion(completed);
                let _permit = permit;
                started.send(()).unwrap();
                finishing.recv().unwrap();
                panic!("worker failure");
            });
            start.recv().unwrap();
            drop(worker);
            assert!(activity.begin_install().is_err());
            finish.send(()).unwrap();
            completion
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(activity.begin_install().is_ok());
        });
    }
}
