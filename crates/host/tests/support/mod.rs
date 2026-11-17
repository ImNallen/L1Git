use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// A gh that replays recorded `auth status` output and hands over the tokens a
/// test gives it, only with `--user`. It is a symlink to one checked-in
/// script, so no test ever executes a file it just wrote.
pub struct FakeGh {
    dir: tempfile::TempDir,
}

impl FakeGh {
    pub fn new(recording: &str) -> FakeGh {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(fixture("fake-gh"), dir.path().join("gh")).unwrap();
        fs::copy(
            fixture("gh/env-token.stdout"),
            dir.path().join("env-token.stdout"),
        )
        .unwrap();
        let fake = FakeGh { dir };
        fake.replay(recording);
        fake
    }

    pub fn path(&self) -> PathBuf {
        self.dir.path().join("gh")
    }

    pub fn replay(&self, recording: &str) {
        for extension in ["stdout", "stderr", "exit"] {
            let recorded = fixture(&format!("gh/{recording}.{extension}"));
            let replayed = self.dir.path().join(format!("status.{extension}"));
            if recorded.exists() {
                fs::copy(recorded, replayed).unwrap();
            } else {
                let _ = fs::remove_file(replayed);
            }
        }
    }

    pub fn signed_in_as(&self, login: &str) {
        self.replay("signed-in");
        let recorded = fs::read_to_string(fixture("gh/signed-in.stdout")).unwrap();
        fs::write(
            self.dir.path().join("status.stdout"),
            recorded.replace(r#""login":"octo""#, &format!(r#""login":"{login}""#)),
        )
        .unwrap();
    }

    pub fn token(&self, login: &str, token: &str) {
        fs::write(
            self.dir.path().join(format!("token-{login}")),
            format!("{token}\n"),
        )
        .unwrap();
    }

    pub fn forget(&self, login: &str) {
        fs::remove_file(self.dir.path().join(format!("token-{login}"))).unwrap();
    }

    pub fn serial_slow_tokens(&self) {
        fs::write(self.dir.path().join("slow"), "").unwrap();
    }

    pub fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

#[derive(Clone)]
pub struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: String,
}

impl Reply {
    pub fn user(login: &str, id: u64, scopes: Option<&str>) -> Reply {
        let mut headers = vec![
            ("Content-Type", "application/json; charset=utf-8".to_owned()),
            ("X-RateLimit-Remaining", "4999".to_owned()),
            ("X-GitHub-Media-Type", "github.v3; format=json".to_owned()),
        ];
        headers.extend(scopes.map(|scopes| ("X-OAuth-Scopes", scopes.to_owned())));
        Reply {
            status: 200,
            headers,
            body: format!(
                r#"{{"login":"{login}","id":{id},"node_id":"MDQ6VXNlcjE=","type":"User","site_admin":false,"name":"The Octocat"}}"#
            ),
        }
    }

    pub fn bad_credentials() -> Reply {
        Reply {
            status: 401,
            headers: vec![("Content-Type", "application/json; charset=utf-8".to_owned())],
            body: r#"{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}"#.to_owned(),
        }
    }

    pub fn rate_limited(reset: u64) -> Reply {
        Reply {
            status: 403,
            headers: vec![
                ("Content-Type", "application/json; charset=utf-8".to_owned()),
                ("X-RateLimit-Remaining", "0".to_owned()),
                ("X-RateLimit-Reset", reset.to_string()),
            ],
            body: r#"{"message":"API rate limit exceeded for user ID 1.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api","status":"403"}"#.to_owned(),
        }
    }

    pub fn redirect(location: &str) -> Reply {
        Reply {
            status: 302,
            headers: vec![("Location", location.to_owned())],
            body: String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Seen {
    pub path: String,
    pub authorization: Option<String>,
}

#[derive(Default)]
struct World {
    replies: HashMap<String, Reply>,
    seen: Vec<Seen>,
}

pub struct FakeGitHub {
    server: Arc<tiny_http::Server>,
    world: Arc<Mutex<World>>,
    worker: Option<JoinHandle<()>>,
}

impl FakeGitHub {
    pub fn start() -> FakeGitHub {
        let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let world = Arc::new(Mutex::new(World::default()));
        let worker = {
            let (server, world) = (Arc::clone(&server), Arc::clone(&world));
            thread::spawn(move || {
                for request in server.incoming_requests() {
                    answer(request, &world);
                }
            })
        };
        FakeGitHub {
            server,
            world,
            worker: Some(worker),
        }
    }

    pub fn url(&self) -> String {
        let port = self.server.server_addr().to_ip().unwrap().port();
        format!("http://127.0.0.1:{port}/")
    }

    pub fn answer(&self, token: &str, reply: Reply) {
        lock(&self.world)
            .replies
            .insert(format!("Bearer {token}"), reply);
    }

    pub fn seen(&self) -> Vec<Seen> {
        lock(&self.world).seen.clone()
    }
}

impl Drop for FakeGitHub {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn lock(world: &Mutex<World>) -> MutexGuard<'_, World> {
    world.lock().unwrap_or_else(PoisonError::into_inner)
}

fn answer(request: tiny_http::Request, world: &Mutex<World>) {
    let authorization = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .map(|header| header.value.as_str().to_owned());
    let reply = {
        let mut world = lock(world);
        world.seen.push(Seen {
            path: request.url().to_owned(),
            authorization: authorization.clone(),
        });
        authorization
            .and_then(|authorization| world.replies.get(&authorization).cloned())
            .unwrap_or_else(Reply::bad_credentials)
    };
    let mut response = tiny_http::Response::from_string(reply.body)
        .with_status_code(tiny_http::StatusCode(reply.status));
    for (name, value) in reply.headers {
        response.add_header(tiny_http::Header::from_bytes(name, value).unwrap());
    }
    let _ = request.respond(response);
}
