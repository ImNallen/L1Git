use l1_git_core::{Coordinator, Limits, run};
use l1_git_host::{ClientId, Endpoints, GhChoice, Host, HostConfig, VaultChoice};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use std::{env, io::Read, path::PathBuf, sync::Arc, thread, time::Duration};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const BODY_LIMIT: u64 = 4 * 1024 * 1024;

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    l1_git_core::stop_git_on_exit_signals(l1_git_core::OnQuit::Raise)?;
    let port: u16 = std::env::var("L1GIT_BRIDGE_PORT")
        .unwrap_or_else(|_| "9417".into())
        .parse()?;
    let dev_port: u16 = std::env::var("L1GIT_DEV_PORT")
        .unwrap_or_else(|_| "1422".into())
        .parse()?;
    let origins: Arc<[String]> = Arc::new([
        format!("http://127.0.0.1:{dev_port}"),
        format!("http://localhost:{dev_port}"),
    ]);
    let undo_dir = std::env::var_os("L1GIT_UNDO_DIR")
        .map_or_else(|| std::env::temp_dir().join("l1git-undo"), PathBuf::from);
    let coordinator = Coordinator::new(Limits::default(), undo_dir);
    let coordinator = match std::env::var("L1GIT_READ_DEADLINE_MS") {
        Ok(cap) => coordinator.cap_reads(Duration::from_millis(cap.parse()?)),
        Err(_) => coordinator,
    };
    let coordinator = Arc::new(coordinator);
    let host = Arc::new(Host::new(host_config()?));
    let server = Server::http((std::net::Ipv4Addr::LOCALHOST, port))?;
    eprintln!("L1 Git development bridge on http://127.0.0.1:{port}");
    for request in server.incoming_requests() {
        let (origins, coordinator, host) = (
            Arc::clone(&origins),
            Arc::clone(&coordinator),
            Arc::clone(&host),
        );
        thread::spawn(move || handle(request, &origins, &coordinator, &host));
    }
    Ok(())
}

fn host_config() -> Result<HostConfig, String> {
    Ok(HostConfig {
        dir: env::var_os("L1GIT_HOST_DIR")
            .map_or_else(|| env::temp_dir().join("l1git-host"), PathBuf::from),
        vault: match env::var("L1GIT_HOST_VAULT").as_deref() {
            Ok("memory") => VaultChoice::Memory,
            Ok(other) => return Err(format!("L1GIT_HOST_VAULT must be memory, not {other}.")),
            Err(_) => VaultChoice::System {
                service: "dev.l1.git.dev-bridge".into(),
            },
        },
        gh: env::var_os("L1GIT_GH").map_or(GhChoice::Search, |path| GhChoice::At(path.into())),
        github: match env::var("L1GIT_GITHUB_API") {
            Ok(api) => Endpoints::loopback(&api)?,
            Err(_) => Endpoints::github_com(),
        },
        client_id: ClientId::compiled(),
    })
}

fn handle(mut request: Request, origins: &[String], coordinator: &Coordinator, host: &Host) {
    let origin = header(&request, "Origin");
    let content_type = header(&request, "Content-Type");
    if request.method() != &Method::Post
        || !origin.is_some_and(|origin| origins.iter().any(|allowed| origin == allowed))
        || content_type != Some("application/json")
    {
        respond(
            request,
            403,
            json!({"error": "Only same-origin development JSON requests are allowed."}),
        );
        return;
    }
    let mut bytes = Vec::new();
    if request
        .as_reader()
        .take(BODY_LIMIT + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        respond(
            request,
            400,
            json!({"error": "The request body is unreadable."}),
        );
        return;
    }
    if bytes.len() as u64 > BODY_LIMIT {
        let error = match request.body_length() {
            Some(length) => {
                format!("The request body is {length} bytes, over the {BODY_LIMIT}-byte limit.")
            }
            None => format!("The request body is over the {BODY_LIMIT}-byte limit."),
        };
        respond(request, 400, json!({ "error": error }));
        return;
    }
    match request.url() {
        "/api/run" => serve(request, &bytes, |input| run(coordinator, input)),
        "/api/host" => serve(request, &bytes, |input| l1_git_host::run(host, input)),
        _ => respond(request, 404, json!({"error": "Unknown route."})),
    }
}

fn serve<Q: DeserializeOwned, A: Serialize, E: Serialize>(
    request: Request,
    bytes: &[u8],
    answer: impl FnOnce(Q) -> Result<A, E>,
) {
    match serde_json::from_slice::<Q>(bytes).map(answer) {
        Ok(Ok(response)) => {
            let mut body = json!(response);
            body["ok"] = json!(true);
            respond(request, 200, body)
        }
        Ok(Err(error)) => respond(request, 200, json!({"ok": false, "error": error})),
        Err(error) => respond(request, 400, json!({"error": error.to_string()})),
    }
}

fn header<'a>(request: &'a Request, field: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(field))
        .map(|h| h.value.as_str())
}

fn respond(request: Request, status: u16, data: serde_json::Value) {
    let mut response = Response::from_string(data.to_string()).with_status_code(StatusCode(status));
    if let Ok(header) = Header::from_bytes("Content-Type", "application/json") {
        response.add_header(header);
    }
    if let Ok(header) = Header::from_bytes("Cache-Control", "no-store") {
        response.add_header(header);
    }
    let _ = request.respond(response);
}
