use l1_git_core::{Coordinator, run};
use serde_json::json;
use std::{io::Read, sync::Arc, thread, time::Duration};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const BODY_LIMIT: u64 = 64 * 1024;

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    l1_git_core::stop_git_on_exit_signals()?;
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
    let coordinator = match std::env::var("L1GIT_READ_DEADLINE_MS") {
        Ok(cap) => Coordinator::default().cap_reads(Duration::from_millis(cap.parse()?)),
        Err(_) => Coordinator::default(),
    };
    let coordinator = Arc::new(coordinator);
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
    if request.url() != "/api/run" {
        respond(request, 404, json!({"error": "Unknown route."}));
        return;
    }
    match serde_json::from_slice::<l1_git_core::Request>(&bytes)
        .map(|input| run(coordinator, input))
    {
        Ok(Ok(response)) => {
            let mut body = json!(response);
            body["ok"] = json!(true);
            respond(request, 200, body)
        }
        Ok(Err(error)) => respond(request, 200, json!({"ok": false, "error": error})),
        Err(error) => respond(request, 400, json!({"error": error.to_string()})),
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
