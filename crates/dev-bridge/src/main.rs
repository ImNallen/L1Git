use l1_git_core::{commit_detail, snapshot};
use serde::Deserialize;
use serde_json::json;
use std::io::Read;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotRequest {
    path: String,
    reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DetailRequest {
    path: String,
    oid: String,
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let port: u16 = std::env::var("L1GIT_BRIDGE_PORT")
        .unwrap_or_else(|_| "9417".into())
        .parse()?;
    let dev_port: u16 = std::env::var("L1GIT_DEV_PORT")
        .unwrap_or_else(|_| "1422".into())
        .parse()?;
    let origins = [
        format!("http://127.0.0.1:{dev_port}"),
        format!("http://localhost:{dev_port}"),
    ];
    let server = Server::http((std::net::Ipv4Addr::LOCALHOST, port))?;
    eprintln!("L1 Git development bridge on http://127.0.0.1:{port}");
    for request in server.incoming_requests() {
        handle(request, &origins);
    }
    Ok(())
}

fn handle(mut request: Request, origins: &[String]) {
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
        .take(16_385)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 16_384
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
            .map(|input| snapshot(&input.path, input.reference.as_deref()).map(|data| json!(data))),
        "/api/commit-detail" => serde_json::from_slice::<DetailRequest>(&bytes)
            .map(|input| commit_detail(&input.path, &input.oid).map(|data| json!(data))),
        _ => {
            respond(request, 404, json!({"error": "Unknown read operation."}));
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
