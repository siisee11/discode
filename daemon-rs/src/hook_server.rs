use crate::compat;
use crate::runtime_control::{RuntimeControl, RuntimeControlError};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_BODY_BYTES: usize = 256 * 1024;
const RATE_LIMIT_MAX: f64 = 60.0;
const RATE_LIMIT_REFILL_PER_SEC: f64 = 60.0;
const RECENTLY_COMPLETED_TTL: Duration = Duration::from_secs(30);

pub struct HookServer {
    state_dir: PathBuf,
    runtime: Option<Arc<Mutex<RuntimeControl>>>,
    auth_token: Option<String>,
    rate_limit: TokenBucket,
    pending: PendingTracker,
}

impl HookServer {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(state_dir: PathBuf, auth_token: Option<String>) -> Self {
        Self::new_with_runtime(state_dir, auth_token, false)
    }

    pub fn new_with_runtime(
        state_dir: PathBuf,
        auth_token: Option<String>,
        runtime_enabled: bool,
    ) -> Self {
        let runtime = if runtime_enabled {
            Some(Arc::new(Mutex::new(RuntimeControl::new(&state_dir))))
        } else {
            None
        };
        Self {
            state_dir,
            runtime,
            auth_token,
            rate_limit: TokenBucket::new(RATE_LIMIT_MAX, RATE_LIMIT_REFILL_PER_SEC),
            pending: PendingTracker::default(),
        }
    }

    pub fn runtime_handle(&self) -> Option<Arc<Mutex<RuntimeControl>>> {
        self.runtime.as_ref().map(Arc::clone)
    }

    pub fn handle_stream(&mut self, mut stream: TcpStream) -> io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_millis(500)))?;
        let response = match read_http_request(&mut stream, MAX_BODY_BYTES) {
            Ok(Some(request)) => self.handle_request(request),
            Ok(None) => return Ok(()),
            Err(HttpReadError::PayloadTooLarge) => HttpResponse::text(413, "Payload too large"),
            Err(HttpReadError::BadRequest) => HttpResponse::text(400, "Bad request"),
            Err(HttpReadError::Io(error)) => return Err(error),
        };

        write_http_response(&mut stream, &response)
    }

    fn handle_request(&mut self, request: HttpRequest) -> HttpResponse {
        let (path, query) = split_path_and_query(&request.path);

        if request.method == "GET" && path == "/health" {
            return HttpResponse::text(200, "OK");
        }

        if !self.is_authorized(&request) {
            return HttpResponse::text(401, "Unauthorized");
        }

        if !self.rate_limit.allow(Instant::now()) {
            return HttpResponse::text(429, "Too many requests");
        }

        if request.method == "GET" && path == "/runtime/windows" {
            return self.handle_runtime_windows();
        }

        if request.method == "GET" && path == "/runtime/buffer" {
            return self.handle_runtime_buffer(
                query.get("windowId").map(String::as_str),
                query
                    .get("since")
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(0),
            );
        }

        if request.method != "POST" {
            return HttpResponse::text(405, "Method not allowed");
        }

        if path == "/reload" {
            return HttpResponse::text(200, "OK");
        }

        let payload = match serde_json::from_slice::<Value>(request.body.as_bytes()) {
            Ok(value) => value,
            Err(_) => return HttpResponse::text(400, "Invalid JSON"),
        };

        match path.as_str() {
            "/runtime/focus" => self.handle_runtime_focus(&payload),
            "/runtime/input" => self.handle_runtime_input(&payload),
            "/runtime/stop" => self.handle_runtime_stop(&payload),
            "/runtime/ensure" => self.handle_runtime_ensure(&payload),
            "/opencode-event" => {
                if self.handle_opencode_event(&payload) {
                    HttpResponse::text(200, "OK")
                } else {
                    HttpResponse::text(400, "Invalid event payload")
                }
            }
            "/send-files" => self.handle_send_files(&payload),
            _ => HttpResponse::text(404, "Not found"),
        }
    }

    fn is_authorized(&self, request: &HttpRequest) -> bool {
        let Some(token) = &self.auth_token else {
            return true;
        };
        matches!(request.headers.get("authorization"), Some(value) if value == &format!("Bearer {token}"))
    }

    fn handle_runtime_windows(&self) -> HttpResponse {
        match self.with_runtime(|runtime| runtime.list_windows()) {
            Ok(payload) => HttpResponse::json(200, payload),
            Err(RuntimeControlError::Unavailable) => {
                HttpResponse::json(501, json!({ "error": "Runtime control unavailable" }))
            }
            Err(_) => HttpResponse::json(400, json!({ "error": "Runtime operation failed" })),
        }
    }

    fn handle_runtime_buffer(&self, window_id: Option<&str>, since: i64) -> HttpResponse {
        let Some(window_id) = window_id else {
            return HttpResponse::json(400, json!({ "error": "Missing windowId" }));
        };

        match self.with_runtime(|runtime| runtime.get_buffer(window_id, since)) {
            Ok(payload) => HttpResponse::json(200, payload),
            Err(RuntimeControlError::Unavailable) => {
                HttpResponse::json(501, json!({ "error": "Runtime control unavailable" }))
            }
            Err(RuntimeControlError::WindowNotFound | RuntimeControlError::InvalidWindowId) => {
                HttpResponse::json(404, json!({ "error": "Window not found" }))
            }
            Err(_) => HttpResponse::json(400, json!({ "error": "Runtime operation failed" })),
        }
    }

    fn handle_runtime_focus(&self, payload: &Value) -> HttpResponse {
        let Some(window_id) = payload
            .as_object()
            .and_then(|obj| obj.get("windowId"))
            .and_then(Value::as_str)
        else {
            return HttpResponse::text(400, "Missing windowId");
        };

        match self.with_runtime(|runtime| runtime.focus_window(window_id)) {
            Ok(()) => HttpResponse::text(200, "OK"),
            Err(RuntimeControlError::Unavailable) => {
                HttpResponse::text(501, "Runtime control unavailable")
            }
            Err(RuntimeControlError::WindowNotFound | RuntimeControlError::InvalidWindowId) => {
                HttpResponse::text(404, "Window not found")
            }
            Err(_) => HttpResponse::text(400, "Runtime operation failed"),
        }
    }

    fn handle_runtime_input(&self, payload: &Value) -> HttpResponse {
        let Some(obj) = payload.as_object() else {
            return HttpResponse::text(400, "Invalid payload");
        };

        let window_id = obj.get("windowId").and_then(Value::as_str);
        let text = obj.get("text").and_then(Value::as_str);
        let submit = obj.get("submit").and_then(Value::as_bool);

        if text.is_none() && submit == Some(false) {
            return HttpResponse::text(400, "No input to send");
        }

        let needs_window = window_id.is_none()
            && matches!(
                self.with_runtime(|runtime| {
                    Ok::<bool, RuntimeControlError>(runtime.get_active_window_id().is_none())
                }),
                Ok(true)
            );
        if needs_window {
            return HttpResponse::text(400, "Missing windowId");
        }

        match self.with_runtime(|runtime| runtime.send_input(window_id, text, submit)) {
            Ok(_) => HttpResponse::text(200, "OK"),
            Err(RuntimeControlError::Unavailable) => {
                HttpResponse::text(501, "Runtime control unavailable")
            }
            Err(RuntimeControlError::MissingWindowId) => {
                HttpResponse::text(400, "Missing windowId")
            }
            Err(RuntimeControlError::WindowNotFound | RuntimeControlError::InvalidWindowId) => {
                HttpResponse::text(404, "Window not found")
            }
            Err(_) => HttpResponse::text(400, "Runtime operation failed"),
        }
    }

    fn handle_runtime_stop(&self, payload: &Value) -> HttpResponse {
        let Some(window_id) = payload
            .as_object()
            .and_then(|obj| obj.get("windowId"))
            .and_then(Value::as_str)
        else {
            return HttpResponse::text(400, "Missing windowId");
        };

        match self.with_runtime(|runtime| runtime.stop_window(window_id)) {
            Ok(()) => HttpResponse::text(200, "OK"),
            Err(RuntimeControlError::Unavailable) => {
                HttpResponse::text(501, "Runtime stop unavailable")
            }
            Err(RuntimeControlError::WindowNotFound | RuntimeControlError::InvalidWindowId) => {
                HttpResponse::text(404, "Window not found")
            }
            Err(_) => HttpResponse::text(400, "Runtime operation failed"),
        }
    }

    fn handle_runtime_ensure(&self, payload: &Value) -> HttpResponse {
        let Some(obj) = payload.as_object() else {
            return HttpResponse::text(400, "Invalid payload");
        };

        let project_name = match obj.get("projectName").and_then(non_empty_str) {
            Some(value) => value,
            None => return HttpResponse::text(400, "Missing projectName"),
        };
        let requested_instance_id = obj.get("instanceId").and_then(non_empty_str);
        let permission_allow = obj
            .get("permissionAllow")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let state = self.load_state();
        let Some(project) = state.projects.get(project_name) else {
            return HttpResponse::text(404, "Project not found");
        };

        let instance = match requested_instance_id {
            Some(id) => resolve_instance(project, "opencode", Some(id)),
            None => project
                .as_object()
                .and_then(|obj| obj.get("instances"))
                .and_then(Value::as_object)
                .and_then(|instances| {
                    let mut keys: Vec<String> = instances.keys().cloned().collect();
                    keys.sort();
                    keys.into_iter()
                        .find_map(|key| instances.get(&key).cloned())
                }),
        };
        let Some(instance) = instance else {
            return HttpResponse::text(404, "Instance not found");
        };

        let session_name = project
            .as_object()
            .and_then(|obj| obj.get("tmuxSession"))
            .and_then(non_empty_str);
        let window_name = instance
            .as_object()
            .and_then(|obj| obj.get("tmuxWindow"))
            .and_then(non_empty_str);
        let project_path = project
            .as_object()
            .and_then(|obj| obj.get("projectPath"))
            .and_then(non_empty_str);
        let agent_type = instance
            .as_object()
            .and_then(|obj| obj.get("agentType"))
            .and_then(non_empty_str)
            .unwrap_or("opencode");
        let instance_id = instance
            .as_object()
            .and_then(|obj| obj.get("instanceId"))
            .and_then(non_empty_str)
            .or(requested_instance_id)
            .unwrap_or(agent_type);

        let (Some(session_name), Some(window_name), Some(project_path)) =
            (session_name, window_name, project_path)
        else {
            return HttpResponse::text(400, "Invalid project state");
        };

        let command = build_runtime_ensure_command(
            project_name,
            project_path,
            agent_type,
            instance_id,
            permission_allow,
            self.auth_token.as_deref(),
        );

        match self
            .with_runtime(|runtime| runtime.ensure_window(session_name, window_name, &command))
        {
            Ok(()) => HttpResponse::text(200, "OK"),
            Err(RuntimeControlError::Unavailable) => {
                HttpResponse::text(501, "Runtime control unavailable")
            }
            Err(_) => HttpResponse::text(400, "Runtime operation failed"),
        }
    }

    fn with_runtime<T, F>(&self, callback: F) -> Result<T, RuntimeControlError>
    where
        F: FnOnce(&mut RuntimeControl) -> Result<T, RuntimeControlError>,
    {
        let Some(runtime) = &self.runtime else {
            return Err(RuntimeControlError::Unavailable);
        };
        let mut guard = runtime.lock().map_err(|_| RuntimeControlError::Sidecar)?;
        callback(&mut guard)
    }

    fn handle_opencode_event(&mut self, payload: &Value) -> bool {
        let event = match HookEvent::from_payload(payload) {
            Some(value) => value,
            None => return false,
        };

        let state = self.load_state();
        let Some(project) = state.projects.get(&event.project_name) else {
            return false;
        };

        let agent_type = event.agent_type.as_deref().unwrap_or("opencode");
        let instance = match resolve_instance(project, agent_type, event.instance_id.as_deref()) {
            Some(value) => value,
            None => return false,
        };

        let channel_id = instance
            .as_object()
            .and_then(|obj| obj.get("channelId"))
            .and_then(non_empty_str);
        if channel_id.is_none() {
            return false;
        }

        self.pending.on_event(&event);
        true
    }

    fn handle_send_files(&self, payload: &Value) -> HttpResponse {
        let Some(obj) = payload.as_object() else {
            return HttpResponse::text(400, "Invalid payload");
        };

        let project_name = match obj.get("projectName").and_then(non_empty_str) {
            Some(value) => value,
            None => return HttpResponse::text(400, "Missing projectName"),
        };

        let agent_type = obj
            .get("agentType")
            .and_then(non_empty_str)
            .unwrap_or("opencode");
        let instance_id = obj.get("instanceId").and_then(non_empty_str);
        let files: Vec<String> = obj
            .get("files")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(ToString::to_string))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();

        if files.is_empty() {
            return HttpResponse::text(400, "No files provided");
        }

        let state = self.load_state();
        let Some(project) = state.projects.get(project_name) else {
            return HttpResponse::text(404, "Project not found");
        };

        let instance = resolve_instance(project, agent_type, instance_id);
        let channel_id = instance
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|obj| obj.get("channelId"))
            .and_then(non_empty_str);
        if channel_id.is_none() {
            return HttpResponse::text(404, "No channel found for project/agent");
        }

        let project_path = project
            .as_object()
            .and_then(|obj| obj.get("projectPath"))
            .and_then(non_empty_str)
            .map(PathBuf::from);
        let Some(project_path) = project_path else {
            return HttpResponse::text(400, "No valid files");
        };

        let valid_files = validate_file_paths(&files, &project_path);
        if valid_files.is_empty() {
            return HttpResponse::text(400, "No valid files");
        }

        HttpResponse::text(200, "OK")
    }

    fn load_state(&self) -> LoadedState {
        let state_path = self.state_dir.join(compat::STATE_FILE_NAME);
        let state = compat::CompatState::load(&state_path);
        let projects = state
            .normalized()
            .as_object()
            .and_then(|obj| obj.get("projects"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        LoadedState { projects }
    }
}

pub fn read_hook_token(state_dir: &Path) -> Option<String> {
    let path = state_dir.join(".hook-token");
    let token = fs::read_to_string(path).ok()?;
    let trimmed = token.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[derive(Default)]
struct PendingTracker {
    active: HashMap<String, PendingEntry>,
    recently_completed: HashMap<String, Instant>,
}

#[derive(Debug, Clone)]
struct PendingEntry {
    hook_active: bool,
}

impl PendingTracker {
    fn on_event(&mut self, event: &HookEvent) {
        self.prune_recently_completed();
        let key = event.pending_key();

        match event.event_type.as_str() {
            "prompt.submit" => {
                self.active.insert(key, PendingEntry { hook_active: false });
            }
            "tool.activity" | "session.start" | "thinking.start" => {
                if let Some(entry) = self.active.get_mut(&key) {
                    entry.hook_active = true;
                }
            }
            "session.idle" | "session.end" | "session.error" | "task.completed" => {
                if self.active.remove(&key).is_some() {
                    self.recently_completed.insert(key, Instant::now());
                }
            }
            _ => {}
        }
    }

    fn prune_recently_completed(&mut self) {
        let now = Instant::now();
        self.recently_completed
            .retain(|_, instant| now.duration_since(*instant) <= RECENTLY_COMPLETED_TTL);
    }

    #[cfg(test)]
    fn has_pending(&self, key: &str) -> bool {
        self.active.contains_key(key)
    }

    #[cfg(test)]
    fn has_recently_completed(&self, key: &str) -> bool {
        self.recently_completed.contains_key(key)
    }
}

struct HookEvent {
    event_type: String,
    project_name: String,
    agent_type: Option<String>,
    instance_id: Option<String>,
}

impl HookEvent {
    fn from_payload(payload: &Value) -> Option<Self> {
        let obj = payload.as_object()?;
        let event_type = non_empty_str(obj.get("type")?)?.to_string();
        let project_name = non_empty_str(obj.get("projectName")?)?.to_string();

        if !is_optional_string(obj.get("agentType"))
            || !is_optional_string(obj.get("instanceId"))
            || !is_optional_string(obj.get("text"))
            || !is_optional_string(obj.get("message"))
            || !is_optional_string(obj.get("timestamp"))
            || !is_optional_string(obj.get("turnId"))
        {
            return None;
        }

        Some(Self {
            event_type,
            project_name,
            agent_type: obj
                .get("agentType")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            instance_id: obj
                .get("instanceId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        })
    }

    fn pending_key(&self) -> String {
        let instance = self
            .instance_id
            .as_deref()
            .or(self.agent_type.as_deref())
            .unwrap_or("opencode");
        format!("{}:{instance}", self.project_name)
    }
}

fn is_optional_string(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(v) => v.is_string(),
    }
}

fn resolve_instance(project: &Value, agent_type: &str, instance_id: Option<&str>) -> Option<Value> {
    let instances = project
        .as_object()
        .and_then(|obj| obj.get("instances"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let by_id = instance_id.and_then(|id| instances.get(id).cloned());
    if by_id.is_some() {
        return by_id;
    }

    let mut keys: Vec<String> = instances.keys().cloned().collect();
    keys.sort();
    for key in keys {
        let Some(instance) = instances.get(&key) else {
            continue;
        };
        let same_agent = instance
            .as_object()
            .and_then(|obj| obj.get("agentType"))
            .and_then(non_empty_str)
            .map(|value| value == agent_type)
            .unwrap_or(false);
        if same_agent {
            return Some(instance.clone());
        }
    }

    None
}

fn validate_file_paths(paths: &[String], project_path: &Path) -> Vec<String> {
    let project_real = match fs::canonicalize(project_path) {
        Ok(path) => path,
        Err(_) => return Vec::new(),
    };

    paths
        .iter()
        .filter_map(|value| {
            let path = PathBuf::from(value);
            if !path.exists() {
                return None;
            }
            let real = fs::canonicalize(&path).ok()?;
            if real == project_real || real.starts_with(&project_real) {
                Some(value.to_string())
            } else {
                None
            }
        })
        .collect()
}

#[derive(Clone)]
struct LoadedState {
    projects: Map<String, Value>,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Debug)]
struct HttpResponse {
    status: u16,
    body: String,
    content_type: &'static str,
}

impl HttpResponse {
    fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.to_string(),
            content_type: "text/plain; charset=utf-8",
        }
    }

    fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            body: serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string()),
            content_type: "application/json; charset=utf-8",
        }
    }
}

fn write_http_response(stream: &mut TcpStream, response: &HttpResponse) -> io::Result<()> {
    let reason = reason_phrase(response.status);
    let bytes = response.body.as_bytes();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        reason,
        response.content_type,
        bytes.len(),
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(bytes)?;
    stream.flush()
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "OK",
    }
}

enum HttpReadError {
    Io(io::Error),
    BadRequest,
    PayloadTooLarge,
}

fn read_http_request(
    stream: &mut TcpStream,
    max_body_bytes: usize,
) -> Result<Option<HttpRequest>, HttpReadError> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];

    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(size) => {
                buffer.extend_from_slice(&chunk[..size]);
                if let Some(header_end) = find_subsequence(&buffer, b"\r\n\r\n") {
                    let headers_raw = std::str::from_utf8(&buffer[..header_end])
                        .map_err(|_| HttpReadError::BadRequest)?;
                    let (method, path, headers) = parse_headers(headers_raw)?;

                    let content_length = headers
                        .get("content-length")
                        .and_then(|value| value.parse::<usize>().ok())
                        .unwrap_or(0);
                    if content_length > max_body_bytes {
                        return Err(HttpReadError::PayloadTooLarge);
                    }

                    let body_start = header_end + 4;
                    let required = body_start.saturating_add(content_length);
                    while buffer.len() < required {
                        match stream.read(&mut chunk) {
                            Ok(0) => break,
                            Ok(extra) => buffer.extend_from_slice(&chunk[..extra]),
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                                ) =>
                            {
                                break;
                            }
                            Err(error) => return Err(HttpReadError::Io(error)),
                        }
                    }

                    if buffer.len() < required {
                        return Err(HttpReadError::BadRequest);
                    }

                    let body = String::from_utf8(buffer[body_start..required].to_vec())
                        .map_err(|_| HttpReadError::BadRequest)?;

                    return Ok(Some(HttpRequest {
                        method,
                        path,
                        headers,
                        body,
                    }));
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                if buffer.is_empty() {
                    return Ok(None);
                }
                return Err(HttpReadError::BadRequest);
            }
            Err(error) => return Err(HttpReadError::Io(error)),
        }

        if buffer.len() > max_body_bytes + 64 * 1024 {
            return Err(HttpReadError::PayloadTooLarge);
        }
    }

    if buffer.is_empty() {
        return Ok(None);
    }

    Err(HttpReadError::BadRequest)
}

fn parse_headers(raw: &str) -> Result<(String, String, HashMap<String, String>), HttpReadError> {
    let mut lines = raw.lines();
    let request_line = lines.next().ok_or(HttpReadError::BadRequest)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(HttpReadError::BadRequest)?.to_string();
    let path = parts.next().ok_or(HttpReadError::BadRequest)?.to_string();
    let _version = parts.next().ok_or(HttpReadError::BadRequest)?;

    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }

    Ok((method, path, headers))
}

fn find_subsequence(buffer: &[u8], pattern: &[u8]) -> Option<usize> {
    if pattern.is_empty() || buffer.len() < pattern.len() {
        return None;
    }

    buffer
        .windows(pattern.len())
        .position(|window| window == pattern)
}

fn split_path_and_query(path: &str) -> (String, HashMap<String, String>) {
    let Some((raw_path, query)) = path.split_once('?') else {
        return (path.to_string(), HashMap::new());
    };

    let mut out = HashMap::new();
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            if !pair.is_empty() {
                out.insert(pair.to_string(), String::new());
            }
            continue;
        };
        out.insert(key.to_string(), value.to_string());
    }

    (raw_path.to_string(), out)
}

fn non_empty_str(value: &Value) -> Option<&str> {
    value.as_str().and_then(|raw| {
        if raw.trim().is_empty() {
            None
        } else {
            Some(raw)
        }
    })
}

fn build_runtime_ensure_command(
    project_name: &str,
    project_path: &str,
    agent_type: &str,
    instance_id: &str,
    permission_allow: bool,
    hook_token: Option<&str>,
) -> String {
    let mut env_vars = vec![
        ("DISCODE_PROJECT".to_string(), project_name.to_string()),
        (
            "DISCODE_PORT".to_string(),
            resolve_daemon_port().to_string(),
        ),
        ("DISCODE_AGENT".to_string(), agent_type.to_string()),
        ("DISCODE_INSTANCE".to_string(), instance_id.to_string()),
    ];
    if let Some(token) = hook_token {
        env_vars.push(("DISCODE_HOOK_TOKEN".to_string(), token.to_string()));
    }
    if agent_type == "opencode" && permission_allow {
        env_vars.push((
            "OPENCODE_PERMISSION".to_string(),
            r#"{"*":"allow"}"#.to_string(),
        ));
    }

    let export_prefix = env_vars
        .into_iter()
        .map(|(key, value)| format!("export {key}={}", shell_escape(&value)))
        .collect::<Vec<_>>()
        .join("; ");

    let start_command = build_agent_start_command(agent_type, project_path, permission_allow);
    if export_prefix.is_empty() {
        start_command
    } else {
        format!("{export_prefix}; {start_command}")
    }
}

fn resolve_daemon_port() -> u16 {
    env::var("HOOK_SERVER_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(18470)
}

fn build_agent_start_command(
    agent_type: &str,
    project_path: &str,
    permission_allow: bool,
) -> String {
    let agent_command = match agent_type {
        "claude" => {
            let mut cmd = String::from("claude");
            if permission_allow {
                cmd.push_str(" --dangerously-skip-permissions");
            }
            let plugin_dir = resolve_claude_plugin_dir();
            if let Some(plugin_dir) = plugin_dir {
                cmd.push_str(" --plugin-dir ");
                cmd.push_str(&shell_escape(&plugin_dir));
            }
            cmd
        }
        "codex" => {
            let mut cmd = String::from("codex");
            if permission_allow {
                cmd.push_str(" --full-auto");
            }
            cmd
        }
        "gemini" => "gemini".to_string(),
        "opencode" => "opencode".to_string(),
        other => other.to_string(),
    };

    format!("cd {} && {}", shell_escape(project_path), agent_command)
}

fn resolve_claude_plugin_dir() -> Option<String> {
    let home = env::var("HOME").ok()?;
    let path = PathBuf::from(home)
        .join(".claude")
        .join("plugins")
        .join("discode-claude-bridge");
    if path.exists() {
        return Some(path.to_string_lossy().to_string());
    }
    None
}

fn shell_escape(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

struct TokenBucket {
    tokens: f64,
    max_tokens: f64,
    refill_per_second: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(max_tokens: f64, refill_per_second: f64) -> Self {
        Self {
            tokens: max_tokens,
            max_tokens,
            refill_per_second,
            last_refill: Instant::now(),
        }
    }

    fn allow(&mut self, now: Instant) -> bool {
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_second).min(self.max_tokens);
        self.last_refill = now;

        if self.tokens < 1.0 {
            return false;
        }

        self.tokens -= 1.0;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{nonce}"));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn write_state(state_dir: &Path, payload: Value) {
        fs::create_dir_all(state_dir).expect("state dir should exist");
        let path = state_dir.join(compat::STATE_FILE_NAME);
        fs::write(
            path,
            serde_json::to_string_pretty(&payload).expect("payload should encode"),
        )
        .expect("state should be written");
    }

    fn request(method: &str, path: &str, body: &str, auth: Option<&str>) -> HttpRequest {
        let mut headers = HashMap::new();
        if let Some(token) = auth {
            headers.insert("authorization".to_string(), format!("Bearer {token}"));
        }
        HttpRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers,
            body: body.to_string(),
        }
    }

    #[test]
    fn health_route_is_public() {
        let state_dir = temp_dir("discode-hook-server");
        let mut server = HookServer::new(state_dir, Some("secret".to_string()));

        let response = server.handle_request(request("GET", "/health", "", None));
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "OK");
    }

    #[test]
    fn non_health_requires_auth_when_token_is_set() {
        let state_dir = temp_dir("discode-hook-server");
        let mut server = HookServer::new(state_dir, Some("secret".to_string()));

        let response = server.handle_request(request("GET", "/runtime/windows", "", None));
        assert_eq!(response.status, 401);
        assert_eq!(response.body, "Unauthorized");
    }

    #[test]
    fn applies_token_bucket_rate_limit() {
        let state_dir = temp_dir("discode-hook-server");
        let mut server = HookServer::new(state_dir, Some("secret".to_string()));

        let mut statuses = Vec::new();
        for _ in 0..61 {
            let response =
                server.handle_request(request("GET", "/runtime/windows", "", Some("secret")));
            statuses.push(response.status);
        }
        assert_eq!(statuses[59], 501);
        assert_eq!(statuses[60], 429);
    }

    #[test]
    fn rejects_invalid_json_for_post_routes() {
        let state_dir = temp_dir("discode-hook-server");
        let mut server = HookServer::new(state_dir, None);

        let response = server.handle_request(request("POST", "/opencode-event", "not-json", None));
        assert_eq!(response.status, 400);
        assert_eq!(response.body, "Invalid JSON");
    }

    #[test]
    fn validates_opencode_event_payload_and_project_lookup() {
        let state_dir = temp_dir("discode-hook-server");
        write_state(
            &state_dir,
            json!({
                "projects": {
                    "demo": {
                        "projectName": "demo",
                        "projectPath": "/tmp/demo",
                        "instances": {
                            "opencode": {
                                "instanceId": "opencode",
                                "agentType": "opencode",
                                "channelId": "ch-1"
                            }
                        }
                    }
                }
            }),
        );

        let mut server = HookServer::new(state_dir, None);

        let bad = server.handle_request(request(
            "POST",
            "/opencode-event",
            "{\"type\":\"session.idle\"}",
            None,
        ));
        assert_eq!(bad.status, 400);
        assert_eq!(bad.body, "Invalid event payload");

        let unknown_project = server.handle_request(request(
            "POST",
            "/opencode-event",
            "{\"type\":\"session.idle\",\"projectName\":\"missing\"}",
            None,
        ));
        assert_eq!(unknown_project.status, 400);
        assert_eq!(unknown_project.body, "Invalid event payload");

        let ok = server.handle_request(request(
            "POST",
            "/opencode-event",
            "{\"type\":\"prompt.submit\",\"projectName\":\"demo\",\"agentType\":\"opencode\"}",
            None,
        ));
        assert_eq!(ok.status, 200);
        assert_eq!(ok.body, "OK");
    }

    #[test]
    fn send_files_validates_payload_and_project_path_scope() {
        let state_dir = temp_dir("discode-hook-server");
        let project_path = state_dir.join("project");
        fs::create_dir_all(&project_path).expect("project dir should be created");
        let inside_file = project_path.join("inside.txt");
        fs::write(&inside_file, "ok").expect("inside file should be written");

        let outside_file = state_dir.join("outside.txt");
        fs::write(&outside_file, "nope").expect("outside file should be written");

        write_state(
            &state_dir,
            json!({
                "projects": {
                    "demo": {
                        "projectName": "demo",
                        "projectPath": project_path.to_string_lossy(),
                        "instances": {
                            "opencode": {
                                "instanceId": "opencode",
                                "agentType": "opencode",
                                "channelId": "ch-1"
                            }
                        }
                    }
                }
            }),
        );

        let mut server = HookServer::new(state_dir, None);

        let missing_project =
            server.handle_request(request("POST", "/send-files", "{\"files\":[\"a\"]}", None));
        assert_eq!(missing_project.status, 400);
        assert_eq!(missing_project.body, "Missing projectName");

        let no_files = server.handle_request(request(
            "POST",
            "/send-files",
            "{\"projectName\":\"demo\",\"files\":[]}",
            None,
        ));
        assert_eq!(no_files.status, 400);
        assert_eq!(no_files.body, "No files provided");

        let outside = server.handle_request(request(
            "POST",
            "/send-files",
            &format!(
                "{{\"projectName\":\"demo\",\"files\":[\"{}\"]}}",
                outside_file.to_string_lossy()
            ),
            None,
        ));
        assert_eq!(outside.status, 400);
        assert_eq!(outside.body, "No valid files");

        let ok = server.handle_request(request(
            "POST",
            "/send-files",
            &format!(
                "{{\"projectName\":\"demo\",\"files\":[\"{}\"]}}",
                inside_file.to_string_lossy()
            ),
            None,
        ));
        assert_eq!(ok.status, 200);
        assert_eq!(ok.body, "OK");
    }

    #[test]
    fn pending_tracker_moves_entry_to_recently_completed() {
        let state_dir = temp_dir("discode-hook-server");
        write_state(
            &state_dir,
            json!({
                "projects": {
                    "demo": {
                        "projectName": "demo",
                        "projectPath": "/tmp/demo",
                        "instances": {
                            "opencode": {
                                "instanceId": "opencode",
                                "agentType": "opencode",
                                "channelId": "ch-1"
                            }
                        }
                    }
                }
            }),
        );

        let mut server = HookServer::new(state_dir, None);
        let key = "demo:opencode";

        let _ = server.handle_request(request(
            "POST",
            "/opencode-event",
            "{\"type\":\"prompt.submit\",\"projectName\":\"demo\",\"agentType\":\"opencode\"}",
            None,
        ));
        assert!(server.pending.has_pending(key));

        let _ = server.handle_request(request(
            "POST",
            "/opencode-event",
            "{\"type\":\"session.end\",\"projectName\":\"demo\",\"agentType\":\"opencode\"}",
            None,
        ));
        assert!(!server.pending.has_pending(key));
        assert!(server.pending.has_recently_completed(key));
    }

    #[test]
    fn parser_rejects_payloads_larger_than_limit() {
        let body = "x".repeat(MAX_BODY_BYTES + 1);
        let raw = format!(
            "POST /opencode-event HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );

        let mut cursor = io::Cursor::new(raw.into_bytes());
        let result = read_http_request_from_reader(&mut cursor, MAX_BODY_BYTES);
        assert!(matches!(result, Err(HttpReadError::PayloadTooLarge)));
    }

    fn read_http_request_from_reader<R: Read>(
        reader: &mut R,
        max_body_bytes: usize,
    ) -> Result<Option<HttpRequest>, HttpReadError> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => buffer.extend_from_slice(&chunk[..size]),
                Err(error) => return Err(HttpReadError::Io(error)),
            }

            if let Some(header_end) = find_subsequence(&buffer, b"\r\n\r\n") {
                let headers_raw = std::str::from_utf8(&buffer[..header_end])
                    .map_err(|_| HttpReadError::BadRequest)?;
                let (method, path, headers) = parse_headers(headers_raw)?;
                let content_length = headers
                    .get("content-length")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);

                if content_length > max_body_bytes {
                    return Err(HttpReadError::PayloadTooLarge);
                }

                let body_start = header_end + 4;
                let required = body_start + content_length;
                if buffer.len() < required {
                    continue;
                }

                let body = String::from_utf8(buffer[body_start..required].to_vec())
                    .map_err(|_| HttpReadError::BadRequest)?;
                return Ok(Some(HttpRequest {
                    method,
                    path,
                    headers,
                    body,
                }));
            }
        }

        Ok(None)
    }
}
