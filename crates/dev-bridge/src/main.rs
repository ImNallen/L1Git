use l1_git_core::{Advance, Coordinator, FetchMode, commit_detail, file_patch, refs, snapshot};
use serde::Deserialize;
use serde_json::json;
use std::{io::Read, sync::Arc, thread};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const BODY_LIMIT: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotRequest {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DetailRequest {
    path: String,
    oid: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePatchRequest {
    path: String,
    oid: String,
    file: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OverviewRequest {
    path: String,
    mode: FetchMode,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FastForwardRequest {
    path: String,
    advances: Vec<Advance>,
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
    let coordinator = Arc::new(Coordinator::default());
    let server = Server::http((std::net::Ipv4Addr::LOCALHOST, port))?;
    eprintln!("L1 Git development bridge on http://127.0.0.1:{port}");
    for request in server.incoming_requests() {
        let (origins, coordinator) = (Arc::clone(&origins), Arc::clone(&coordinator));
        thread::spawn(move || handle(request, &origins, &coordinator));
    }
    Ok(())
}

fn handle(mut request: Request, origins: &[String], coordinator: &Coordinator) {
    let origin = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str());
    let content_type = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Content-Type"))
        .map(|h| h.value.as_str());
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
        || bytes.len() as u64 > BODY_LIMIT
    {
        respond(
            request,
            400,
            json!({"error": "Request body is unreadable or too large."}),
        );
        return;
    }
    let result = match request.url() {
        "/api/snapshot" => serde_json::from_slice::<SnapshotRequest>(&bytes)
            .map(|input| snapshot(&input.path).map(|data| json!(data))),
        "/api/refs" => serde_json::from_slice::<SnapshotRequest>(&bytes)
            .map(|input| refs(&input.path).map(|data| json!(data))),
        "/api/commit-detail" => serde_json::from_slice::<DetailRequest>(&bytes)
            .map(|input| commit_detail(&input.path, &input.oid).map(|data| json!(data))),
        "/api/file-patch" => serde_json::from_slice::<FilePatchRequest>(&bytes)
            .map(|input| file_patch(&input.path, &input.oid, &input.file).map(|data| json!(data))),
        "/api/overview" => serde_json::from_slice::<OverviewRequest>(&bytes).map(|input| {
            coordinator
                .overview(&input.path, input.mode)
                .map(|data| json!(data))
        }),
        "/api/fast-forward" => serde_json::from_slice::<FastForwardRequest>(&bytes).map(|input| {
            coordinator
                .fast_forward(&input.path, &input.advances)
                .map(|data| json!(data))
        }),
        _ => {
            respond(request, 404, json!({"error": "Unknown operation."}));
            return;
        }
    };
    match result {
        Ok(Ok(data)) => respond(request, 200, json!({"ok": true, "data": data})),
        Ok(Err(error)) => respond(request, 200, json!({"ok": false, "error": error})),
        Err(_) => respond(request, 400, json!({"error": "Invalid request."})),
    }
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
