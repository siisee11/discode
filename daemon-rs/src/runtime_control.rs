use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const RUNTIME_CONTROL_PROTOCOL_VERSION: u64 = 1;
pub const RUNTIME_STREAM_PROTOCOL_VERSION: u64 = 1;

const SIDECAR_BOOT_TIMEOUT_MS: u64 = 1_200;
const SIDECAR_REQUEST_TIMEOUT_MS: u64 = 1_500;

pub struct RuntimeControl {
    bridge: SidecarBridge,
    active_window_id: Option<String>,
}

impl RuntimeControl {
    pub fn new(state_dir: &Path) -> Self {
        Self {
            bridge: SidecarBridge::new(state_dir),
            active_window_id: None,
        }
    }

    pub fn is_available(&mut self) -> bool {
        self.bridge.ensure_available().is_ok()
    }

    pub fn list_windows(&mut self) -> Result<Value, RuntimeControlError> {
        let windows = self
            .bridge
            .list_windows(None)
            .map_err(RuntimeControlError::from)?;

        if windows.is_empty() {
            self.active_window_id = None;
        } else if self.active_window_id.as_ref().is_none()
            || !windows
                .iter()
                .any(|window| Some(window.window_id()) == self.active_window_id)
        {
            self.active_window_id = windows.first().map(WindowSnapshot::window_id);
        }

        let windows_json = windows
            .iter()
            .map(|window| {
                json!({
                    "windowId": window.window_id(),
                    "sessionName": window.session_name,
                    "windowName": window.window_name,
                    "status": window.status,
                    "pid": window.pid,
                    "startedAt": window.started_at,
                    "exitedAt": window.exited_at,
                    "exitCode": window.exit_code,
                    "signal": window.signal,
                })
            })
            .collect::<Vec<_>>();

        Ok(json!({
            "protocolVersion": RUNTIME_CONTROL_PROTOCOL_VERSION,
            "activeWindowId": self.active_window_id,
            "windows": windows_json,
        }))
    }

    pub fn focus_window(&mut self, window_id: &str) -> Result<(), RuntimeControlError> {
        let parsed =
            parse_runtime_window_id(window_id).ok_or(RuntimeControlError::InvalidWindowId)?;
        if !self
            .bridge
            .window_exists(&parsed.session_name, &parsed.window_name)
            .map_err(RuntimeControlError::from)?
        {
            return Err(RuntimeControlError::WindowNotFound);
        }

        self.active_window_id = Some(parsed.window_id());
        Ok(())
    }

    pub fn get_active_window_id(&self) -> Option<&str> {
        self.active_window_id.as_deref()
    }

    pub fn send_input(
        &mut self,
        window_id: Option<&str>,
        text: Option<&str>,
        submit: Option<bool>,
    ) -> Result<String, RuntimeControlError> {
        let target = window_id
            .map(ToString::to_string)
            .or_else(|| self.active_window_id.clone())
            .ok_or(RuntimeControlError::MissingWindowId)?;

        let parsed =
            parse_runtime_window_id(&target).ok_or(RuntimeControlError::InvalidWindowId)?;
        if !self
            .bridge
            .window_exists(&parsed.session_name, &parsed.window_name)
            .map_err(RuntimeControlError::from)?
        {
            return Err(RuntimeControlError::WindowNotFound);
        }

        if let Some(value) = text {
            if !value.is_empty() {
                self.bridge
                    .type_keys(&parsed.session_name, &parsed.window_name, value)
                    .map_err(RuntimeControlError::from)?;
            }
        }

        let should_submit = submit.unwrap_or(true);
        if should_submit {
            self.bridge
                .send_enter(&parsed.session_name, &parsed.window_name)
                .map_err(RuntimeControlError::from)?;
        }

        self.active_window_id = Some(parsed.window_id());
        Ok(parsed.window_id())
    }

    pub fn send_input_bytes(
        &mut self,
        window_id: &str,
        text: &str,
    ) -> Result<(), RuntimeControlError> {
        let parsed =
            parse_runtime_window_id(window_id).ok_or(RuntimeControlError::InvalidWindowId)?;
        if !self
            .bridge
            .window_exists(&parsed.session_name, &parsed.window_name)
            .map_err(RuntimeControlError::from)?
        {
            return Err(RuntimeControlError::WindowNotFound);
        }

        self.bridge
            .type_keys(&parsed.session_name, &parsed.window_name, text)
            .map_err(RuntimeControlError::from)?;
        self.active_window_id = Some(parsed.window_id());
        Ok(())
    }

    pub fn get_buffer(
        &mut self,
        window_id: &str,
        since: i64,
    ) -> Result<Value, RuntimeControlError> {
        let parsed =
            parse_runtime_window_id(window_id).ok_or(RuntimeControlError::InvalidWindowId)?;
        if !self
            .bridge
            .window_exists(&parsed.session_name, &parsed.window_name)
            .map_err(RuntimeControlError::from)?
        {
            return Err(RuntimeControlError::WindowNotFound);
        }

        let raw = self
            .bridge
            .get_window_buffer(&parsed.session_name, &parsed.window_name)
            .map_err(RuntimeControlError::from)?;
        let safe_since = since.max(0) as usize;
        let start = safe_since.min(raw.len());
        let chunk = raw[start..].to_string();

        Ok(json!({
            "protocolVersion": RUNTIME_CONTROL_PROTOCOL_VERSION,
            "windowId": parsed.window_id(),
            "since": start,
            "next": raw.len(),
            "chunk": chunk,
        }))
    }

    pub fn stop_window(&mut self, window_id: &str) -> Result<(), RuntimeControlError> {
        let parsed =
            parse_runtime_window_id(window_id).ok_or(RuntimeControlError::InvalidWindowId)?;
        if !self
            .bridge
            .window_exists(&parsed.session_name, &parsed.window_name)
            .map_err(RuntimeControlError::from)?
        {
            return Err(RuntimeControlError::WindowNotFound);
        }

        let stopped = self
            .bridge
            .stop_window(&parsed.session_name, &parsed.window_name)
            .map_err(RuntimeControlError::from)?;
        if !stopped {
            return Err(RuntimeControlError::StopFailed);
        }

        Ok(())
    }

    pub fn resize_window(
        &mut self,
        window_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), RuntimeControlError> {
        let parsed =
            parse_runtime_window_id(window_id).ok_or(RuntimeControlError::InvalidWindowId)?;
        self.bridge
            .resize_window(&parsed.session_name, &parsed.window_name, cols, rows)
            .map_err(RuntimeControlError::from)?;
        self.active_window_id = Some(parsed.window_id());
        Ok(())
    }

    pub fn get_frame(
        &mut self,
        window_id: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, RuntimeControlError> {
        let parsed =
            parse_runtime_window_id(window_id).ok_or(RuntimeControlError::InvalidWindowId)?;
        if !self
            .bridge
            .window_exists(&parsed.session_name, &parsed.window_name)
            .map_err(RuntimeControlError::from)?
        {
            return Err(RuntimeControlError::WindowNotFound);
        }

        self.bridge
            .get_window_frame(&parsed.session_name, &parsed.window_name, cols, rows)
            .map_err(RuntimeControlError::from)
    }
}

#[derive(Debug)]
pub enum RuntimeControlError {
    Unavailable,
    MissingWindowId,
    InvalidWindowId,
    WindowNotFound,
    StopFailed,
    Sidecar,
}

impl From<SidecarError> for RuntimeControlError {
    fn from(value: SidecarError) -> Self {
        match value {
            SidecarError::Unavailable => Self::Unavailable,
            SidecarError::Other(_) => Self::Sidecar,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug)]
enum SidecarError {
    Unavailable,
    Other(String),
}

struct SidecarBridge {
    socket_path: PathBuf,
    binary_path: Option<PathBuf>,
    server_process: Option<Child>,
    available: bool,
    next_request_id: u64,
}

impl SidecarBridge {
    fn new(state_dir: &Path) -> Self {
        let socket_path = state_dir.join("pty-rust-sidecar.sock");
        let binary_path = resolve_sidecar_binary_path();

        Self {
            socket_path,
            binary_path,
            server_process: None,
            available: false,
            next_request_id: 1,
        }
    }

    fn ensure_available(&mut self) -> Result<(), SidecarError> {
        if self.available {
            return Ok(());
        }

        let Some(binary_path) = self.binary_path.clone() else {
            return Err(SidecarError::Unavailable);
        };

        if self.request_without_bootstrap("health", json!({})).is_ok() {
            self.available = true;
            return Ok(());
        }

        if let Some(parent) = self.socket_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let child = Command::new(binary_path)
            .arg("server")
            .arg("--socket")
            .arg(self.socket_path.to_string_lossy().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| SidecarError::Other(format!("spawn sidecar server: {error}")))?;

        self.server_process = Some(child);

        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(SIDECAR_BOOT_TIMEOUT_MS) {
            if self.request_without_bootstrap("health", json!({})).is_ok()
                || self.request_without_bootstrap("hello", json!({})).is_ok()
            {
                self.available = true;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(50));
        }

        self.available = false;
        Err(SidecarError::Unavailable)
    }

    fn list_windows(
        &mut self,
        session_name: Option<&str>,
    ) -> Result<Vec<WindowSnapshot>, SidecarError> {
        let response = self.request_value(
            "list_windows",
            json!({
                "sessionName": session_name,
            }),
        )?;

        let list = response
            .get("windows")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut windows = Vec::new();
        for item in list {
            if let Ok(parsed) = serde_json::from_value::<WindowSnapshot>(item) {
                windows.push(parsed);
            }
        }

        Ok(windows)
    }

    fn window_exists(
        &mut self,
        session_name: &str,
        window_name: &str,
    ) -> Result<bool, SidecarError> {
        let response = self.request_value(
            "window_exists",
            json!({
                "sessionName": session_name,
                "windowName": window_name,
            }),
        )?;
        Ok(response
            .get("exists")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }

    fn type_keys(
        &mut self,
        session_name: &str,
        window_name: &str,
        keys: &str,
    ) -> Result<(), SidecarError> {
        let _ = self.request_value(
            "type_keys",
            json!({
                "sessionName": session_name,
                "windowName": window_name,
                "keys": keys,
            }),
        )?;
        Ok(())
    }

    fn send_enter(&mut self, session_name: &str, window_name: &str) -> Result<(), SidecarError> {
        let _ = self.request_value(
            "send_enter",
            json!({
                "sessionName": session_name,
                "windowName": window_name,
            }),
        )?;
        Ok(())
    }

    fn get_window_buffer(
        &mut self,
        session_name: &str,
        window_name: &str,
    ) -> Result<String, SidecarError> {
        let response = self.request_value(
            "get_window_buffer",
            json!({
                "sessionName": session_name,
                "windowName": window_name,
            }),
        )?;
        Ok(response
            .get("buffer")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string())
    }

    fn get_window_frame(
        &mut self,
        session_name: &str,
        window_name: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, SidecarError> {
        self.request_value(
            "get_window_frame",
            json!({
                "sessionName": session_name,
                "windowName": window_name,
                "cols": cols,
                "rows": rows,
            }),
        )
    }

    fn stop_window(&mut self, session_name: &str, window_name: &str) -> Result<bool, SidecarError> {
        let response = self.request_value(
            "stop_window",
            json!({
                "sessionName": session_name,
                "windowName": window_name,
            }),
        )?;
        Ok(response
            .get("stopped")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }

    fn resize_window(
        &mut self,
        session_name: &str,
        window_name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), SidecarError> {
        let _ = self.request_value(
            "resize_window",
            json!({
                "sessionName": session_name,
                "windowName": window_name,
                "cols": cols,
                "rows": rows,
            }),
        )?;
        Ok(())
    }

    fn dispose(&mut self) {
        let _ = self.request_value("dispose", json!({}));
        if let Some(child) = &mut self.server_process {
            let _ = child.kill();
        }
        self.server_process = None;
        self.available = false;
    }

    fn request_value(&mut self, method: &str, params: Value) -> Result<Value, SidecarError> {
        self.ensure_available()?;
        self.request_without_bootstrap(method, params)
    }

    fn request_without_bootstrap(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, SidecarError> {
        let mut stream = UnixStream::connect(&self.socket_path)
            .map_err(|error| SidecarError::Other(format!("connect sidecar socket: {error}")))?;
        let _ = stream.set_read_timeout(Some(Duration::from_millis(SIDECAR_REQUEST_TIMEOUT_MS)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(SIDECAR_REQUEST_TIMEOUT_MS)));

        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.saturating_add(1);

        let payload = json!({
            "id": request_id,
            "method": method,
            "params": params,
            "timeoutMs": SIDECAR_REQUEST_TIMEOUT_MS,
        });
        let mut encoded = serde_json::to_vec(&payload)
            .map_err(|error| SidecarError::Other(format!("encode sidecar request: {error}")))?;
        encoded.push(b'\n');
        stream
            .write_all(&encoded)
            .map_err(|error| SidecarError::Other(format!("write sidecar request: {error}")))?;

        let mut line = String::new();
        let mut reader = BufReader::new(stream);
        reader
            .read_line(&mut line)
            .map_err(|error| SidecarError::Other(format!("read sidecar response: {error}")))?;

        let response: RpcResponse = serde_json::from_str(line.trim())
            .map_err(|error| SidecarError::Other(format!("decode sidecar response: {error}")))?;
        if !response.ok {
            return Err(SidecarError::Other(format_sidecar_error(response.error)));
        }

        Ok(response.result.unwrap_or_else(|| json!({})))
    }
}

impl Drop for SidecarBridge {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowSnapshot {
    #[serde(rename = "sessionName")]
    session_name: String,
    #[serde(rename = "windowName")]
    window_name: String,
    status: Option<String>,
    pid: Option<u32>,
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
    #[serde(rename = "exitedAt")]
    exited_at: Option<u64>,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
    signal: Option<String>,
}

impl WindowSnapshot {
    fn window_id(&self) -> String {
        format!("{}:{}", self.session_name, self.window_name)
    }
}

#[derive(Debug)]
struct RuntimeWindowRef {
    session_name: String,
    window_name: String,
}

impl RuntimeWindowRef {
    fn window_id(&self) -> String {
        format!("{}:{}", self.session_name, self.window_name)
    }
}

fn parse_runtime_window_id(window_id: &str) -> Option<RuntimeWindowRef> {
    let index = window_id.find(':')?;
    if index == 0 || index + 1 >= window_id.len() {
        return None;
    }

    let session_name = window_id[..index].to_string();
    let window_name = window_id[index + 1..].to_string();
    if session_name.is_empty() || window_name.is_empty() {
        return None;
    }

    Some(RuntimeWindowRef {
        session_name,
        window_name,
    })
}

#[derive(Debug, Deserialize)]
struct RpcResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<Value>,
}

fn format_sidecar_error(value: Option<Value>) -> String {
    let Some(error) = value else {
        return "sidecar error".to_string();
    };

    if let Some(as_text) = error.as_str() {
        return as_text.to_string();
    }

    let code = error
        .as_object()
        .and_then(|obj| obj.get("code"))
        .and_then(Value::as_str);
    let message = error
        .as_object()
        .and_then(|obj| obj.get("message"))
        .and_then(Value::as_str);

    match (code, message) {
        (Some(code), Some(message)) => format!("[{code}] {message}"),
        (Some(code), None) => format!("[{code}] sidecar error"),
        (None, Some(message)) => message.to_string(),
        (None, None) => "sidecar error".to_string(),
    }
}

fn resolve_sidecar_binary_path() -> Option<PathBuf> {
    if let Ok(value) = env::var("DISCODE_PTY_RUST_SIDECAR_BIN") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Some(path);
        }
    }

    let binary = "discode-pty-sidecar";
    let cwd = env::current_dir().ok();
    let home = env::var("HOME").ok().map(PathBuf::from);

    let os = env::consts::OS;
    let arch = match env::consts::ARCH {
        "x86_64" => Some("x64"),
        "aarch64" => Some("arm64"),
        _ => None,
    };

    let mut candidates = Vec::new();
    if let Some(cwd) = &cwd {
        candidates.push(cwd.join("sidecar/pty-rust/target/release").join(binary));
        if let (Some(arch), true) = (arch, os == "darwin" || os == "linux") {
            candidates.push(
                cwd.join("dist/release/sidecar")
                    .join(format!("discode-pty-sidecar-{os}-{arch}"))
                    .join("bin")
                    .join(binary),
            );
        }
    }
    if let Some(home) = &home {
        candidates.push(home.join(".discode/bin").join(binary));
        if let (Some(arch), true) = (arch, os == "darwin" || os == "linux") {
            candidates.push(
                home.join(".discode/bin/sidecar")
                    .join(format!("{os}-{arch}"))
                    .join(binary),
            );
        }
    }

    candidates.into_iter().find(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_runtime_window_id() {
        let parsed = parse_runtime_window_id("bridge:demo").expect("window id should parse");
        assert_eq!(parsed.session_name, "bridge");
        assert_eq!(parsed.window_name, "demo");
        assert!(parse_runtime_window_id("missing-colon").is_none());
    }

    #[test]
    fn formats_sidecar_error_objects() {
        let text = format_sidecar_error(Some(json!("oops")));
        assert_eq!(text, "oops");

        let coded = format_sidecar_error(Some(json!({ "code": "BAD", "message": "bad" })));
        assert_eq!(coded, "[BAD] bad");
    }
}
