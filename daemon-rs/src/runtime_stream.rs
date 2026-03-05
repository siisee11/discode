use crate::runtime_control::{
    RuntimeControl, RuntimeControlError, RUNTIME_STREAM_PROTOCOL_VERSION,
};
use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const FRAME_TICK_MS: u64 = 50;
pub const RUNTIME_STREAM_PROTOCOL_MIN_SUPPORTED_VERSION: u64 = RUNTIME_STREAM_PROTOCOL_VERSION;
pub const RUNTIME_STREAM_PROTOCOL_MAX_SUPPORTED_VERSION: u64 = 2;
const RUNTIME_STREAM_PROTOCOL_VERSION_V1: u64 = RUNTIME_STREAM_PROTOCOL_MIN_SUPPORTED_VERSION;
const RUNTIME_STREAM_PROTOCOL_VERSION_V2: u64 = RUNTIME_STREAM_PROTOCOL_MAX_SUPPORTED_VERSION;

pub trait RuntimeStreamRuntime {
    fn focus_window(&mut self, window_id: &str) -> Result<(), RuntimeControlError>;
    fn send_input_bytes(&mut self, window_id: &str, text: &str) -> Result<(), RuntimeControlError>;
    fn resize_window(
        &mut self,
        window_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), RuntimeControlError>;
    fn get_frame(
        &mut self,
        window_id: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, RuntimeControlError>;
}

impl RuntimeStreamRuntime for RuntimeControl {
    fn focus_window(&mut self, window_id: &str) -> Result<(), RuntimeControlError> {
        RuntimeControl::focus_window(self, window_id)
    }

    fn send_input_bytes(&mut self, window_id: &str, text: &str) -> Result<(), RuntimeControlError> {
        RuntimeControl::send_input_bytes(self, window_id, text)
    }

    fn resize_window(
        &mut self,
        window_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), RuntimeControlError> {
        RuntimeControl::resize_window(self, window_id, cols, rows)
    }

    fn get_frame(
        &mut self,
        window_id: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, RuntimeControlError> {
        RuntimeControl::get_frame(self, window_id, cols, rows)
    }
}

pub struct RuntimeStreamService<R>
where
    R: RuntimeStreamRuntime + Send + 'static,
{
    socket_path: PathBuf,
    runtime: Arc<Mutex<R>>,
    running: Arc<AtomicBool>,
    listener_thread: Option<JoinHandle<()>>,
    started: bool,
}

impl<R> RuntimeStreamService<R>
where
    R: RuntimeStreamRuntime + Send + 'static,
{
    pub fn new(socket_path: PathBuf, runtime: Arc<Mutex<R>>) -> Self {
        Self {
            socket_path,
            runtime,
            running: Arc::new(AtomicBool::new(false)),
            listener_thread: None,
            started: false,
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.started {
            return Ok(());
        }

        if self.socket_path.exists() {
            let _ = fs::remove_file(&self.socket_path);
        }
        if let Some(parent) = self.socket_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create stream socket parent failed: {error}"))?;
        }

        let listener = UnixListener::bind(&self.socket_path)
            .map_err(|error| format!("bind runtime stream socket failed: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("set stream listener nonblocking failed: {error}"))?;

        self.running.store(true, Ordering::SeqCst);
        let running = Arc::clone(&self.running);
        let runtime = Arc::clone(&self.runtime);
        let socket_path = self.socket_path.clone();

        self.listener_thread = Some(thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let runtime = Arc::clone(&runtime);
                        let running = Arc::clone(&running);
                        thread::spawn(move || handle_client(stream, runtime, running));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(50));
                    }
                }
            }
            let _ = fs::remove_file(socket_path);
        }));

        self.started = true;
        Ok(())
    }

    pub fn stop(&mut self) {
        if !self.started {
            return;
        }

        self.running.store(false, Ordering::SeqCst);
        let _ = UnixStream::connect(&self.socket_path);
        if let Some(handle) = self.listener_thread.take() {
            let _ = handle.join();
        }
        self.started = false;
    }
}

impl<R> Drop for RuntimeStreamService<R>
where
    R: RuntimeStreamRuntime + Send + 'static,
{
    fn drop(&mut self) {
        self.stop();
    }
}

struct ClientState {
    window_id: Option<String>,
    cols: u16,
    rows: u16,
    missing_notified: bool,
    last_flush: Instant,
    protocol_version: u64,
    seq: u64,
}

fn handle_client<R>(mut stream: UnixStream, runtime: Arc<Mutex<R>>, running: Arc<AtomicBool>)
where
    R: RuntimeStreamRuntime + Send + 'static,
{
    let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));

    let mut state = ClientState {
        window_id: None,
        cols: 120,
        rows: 40,
        missing_notified: false,
        last_flush: Instant::now(),
        protocol_version: RUNTIME_STREAM_PROTOCOL_VERSION_V1,
        seq: 0,
    };

    let mut read_buffer = String::new();
    let mut chunk = [0u8; 4096];

    while running.load(Ordering::SeqCst) {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(size) => {
                let text = String::from_utf8_lossy(&chunk[..size]);
                read_buffer.push_str(&text);
                while let Some(index) = read_buffer.find('\n') {
                    let line = read_buffer[..index].trim().to_string();
                    read_buffer = read_buffer[index + 1..].to_string();
                    if !line.is_empty() {
                        if !handle_message(&line, &mut stream, &runtime, &mut state) {
                            return;
                        }
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }

        if state.window_id.is_some()
            && state.last_flush.elapsed() >= Duration::from_millis(FRAME_TICK_MS)
        {
            send_frame(&mut stream, &runtime, &mut state);
            state.last_flush = Instant::now();
        }
    }
}

fn handle_message<R>(
    line: &str,
    stream: &mut UnixStream,
    runtime: &Arc<Mutex<R>>,
    state: &mut ClientState,
) -> bool
where
    R: RuntimeStreamRuntime + Send + 'static,
{
    let payload = match serde_json::from_str::<Value>(line) {
        Ok(value) => value,
        Err(_) => {
            send_message(
                stream,
                json!({ "type": "error", "code": "bad_json", "message": "Invalid JSON" }),
                state.protocol_version,
            );
            return true;
        }
    };

    let Some(message_type) = payload
        .as_object()
        .and_then(|obj| obj.get("type"))
        .and_then(Value::as_str)
    else {
        send_message(
            stream,
            json!({ "type": "error", "code": "bad_message", "message": "Invalid message" }),
            state.protocol_version,
        );
        return true;
    };

    match message_type {
        "hello" => {
            if let Some(version) = parse_protocol_version(payload.get("version")) {
                if !is_supported_protocol_version(version) {
                    send_message(
                        stream,
                        json!({
                            "type": "error",
                            "code": "unsupported_protocol_version",
                            "message": format!("Unsupported runtime stream protocol version: {version}"),
                        }),
                        RUNTIME_STREAM_PROTOCOL_VERSION_V2,
                    );
                    return false;
                }
                state.protocol_version = version;
            }
            send_message(
                stream,
                json!({
                    "type": "hello",
                    "ok": true,
                }),
                state.protocol_version,
            );
        }
        "subscribe" => {
            let Some(window_id) = payload.get("windowId").and_then(Value::as_str) else {
                send_message(
                    stream,
                    json!({ "type": "error", "code": "bad_subscribe", "message": "Missing windowId" }),
                    state.protocol_version,
                );
                return true;
            };

            state.window_id = Some(window_id.to_string());
            state.cols = clamp_u16(payload.get("cols"), 30, 240, 120);
            state.rows = clamp_u16(payload.get("rows"), 10, 120, 40);
            state.missing_notified = false;
            if state.protocol_version >= RUNTIME_STREAM_PROTOCOL_VERSION_V2 {
                send_message(
                    stream,
                    json!({ "type": "ack", "op": "subscribe", "windowId": window_id }),
                    state.protocol_version,
                );
            }
            send_frame(stream, runtime, state);
        }
        "focus" => {
            let Some(window_id) = payload.get("windowId").and_then(Value::as_str) else {
                send_message(
                    stream,
                    json!({ "type": "error", "code": "bad_focus", "message": "Missing windowId" }),
                    state.protocol_version,
                );
                return true;
            };

            state.window_id = Some(window_id.to_string());
            state.missing_notified = false;
            if let Ok(mut guard) = runtime.lock() {
                let _ = guard.focus_window(window_id);
            }

            if state.protocol_version >= RUNTIME_STREAM_PROTOCOL_VERSION_V2 {
                send_message(
                    stream,
                    json!({ "type": "ack", "op": "focus", "windowId": window_id }),
                    state.protocol_version,
                );
            } else {
                send_message(
                    stream,
                    json!({ "type": "focus", "ok": true, "windowId": window_id }),
                    state.protocol_version,
                );
            }
            send_frame(stream, runtime, state);
        }
        "input" => {
            let Some(window_id) = payload.get("windowId").and_then(Value::as_str) else {
                send_message(
                    stream,
                    json!({ "type": "error", "code": "bad_input", "message": "Invalid windowId" }),
                    state.protocol_version,
                );
                return true;
            };

            let Some(bytes_base64) = payload.get("bytesBase64").and_then(Value::as_str) else {
                send_message(
                    stream,
                    json!({ "type": "error", "code": "bad_input", "message": "Invalid bytesBase64" }),
                    state.protocol_version,
                );
                return true;
            };

            let decoded = match base64::engine::general_purpose::STANDARD.decode(bytes_base64) {
                Ok(value) => value,
                Err(_) => {
                    send_message(
                        stream,
                        json!({ "type": "error", "code": "bad_input", "message": "Invalid bytesBase64" }),
                        state.protocol_version,
                    );
                    return true;
                }
            };

            let text = String::from_utf8_lossy(&decoded).to_string();
            let result = runtime
                .lock()
                .ok()
                .map(|mut guard| guard.send_input_bytes(window_id, &text));

            match result {
                Some(Ok(())) => {
                    if state.protocol_version >= RUNTIME_STREAM_PROTOCOL_VERSION_V2 {
                        send_message(
                            stream,
                            json!({ "type": "ack", "op": "input", "windowId": window_id }),
                            state.protocol_version,
                        );
                    } else {
                        send_message(
                            stream,
                            json!({ "type": "input", "ok": true, "windowId": window_id }),
                            state.protocol_version,
                        );
                    }
                }
                Some(Err(RuntimeControlError::WindowNotFound))
                | Some(Err(RuntimeControlError::InvalidWindowId)) => {
                    send_window_exit(stream, window_id, "missing", state.protocol_version);
                }
                Some(Err(_)) | None => {
                    send_window_exit(stream, window_id, "not_running", state.protocol_version);
                }
            }
        }
        "resize" => {
            let Some(window_id) = payload.get("windowId").and_then(Value::as_str) else {
                return true;
            };

            state.window_id = Some(window_id.to_string());
            state.cols = clamp_u16(payload.get("cols"), 30, 240, state.cols);
            state.rows = clamp_u16(payload.get("rows"), 10, 120, state.rows);
            state.missing_notified = false;

            if let Ok(mut guard) = runtime.lock() {
                let _ = guard.resize_window(window_id, state.cols, state.rows);
            }
            if state.protocol_version >= RUNTIME_STREAM_PROTOCOL_VERSION_V2 {
                send_message(
                    stream,
                    json!({ "type": "ack", "op": "resize", "windowId": window_id }),
                    state.protocol_version,
                );
            }
            send_frame(stream, runtime, state);
        }
        "ping" => {
            let ping_id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            send_message(
                stream,
                json!({ "type": "pong", "id": ping_id }),
                state.protocol_version,
            );
        }
        _ => {
            send_message(
                stream,
                json!({ "type": "error", "code": "unknown_type", "message": "Unknown message type" }),
                state.protocol_version,
            );
        }
    }

    true
}

fn send_frame<R>(stream: &mut UnixStream, runtime: &Arc<Mutex<R>>, state: &mut ClientState)
where
    R: RuntimeStreamRuntime + Send + 'static,
{
    let Some(window_id) = state.window_id.clone() else {
        return;
    };

    let result = runtime
        .lock()
        .ok()
        .map(|mut guard| guard.get_frame(&window_id, Some(state.cols), Some(state.rows)));

    match result {
        Some(Ok(frame)) => {
            state.missing_notified = false;
            state.seq = state.seq.saturating_add(1);
            if state.protocol_version >= RUNTIME_STREAM_PROTOCOL_VERSION_V2 {
                send_message(
                    stream,
                    frame_to_v2_payload(&window_id, state.seq, &frame),
                    state.protocol_version,
                );
            } else {
                send_message(
                    stream,
                    json!({ "type": "frame-styled", "windowId": window_id, "frame": frame }),
                    state.protocol_version,
                );
            }
        }
        Some(Err(RuntimeControlError::WindowNotFound))
        | Some(Err(RuntimeControlError::InvalidWindowId)) => {
            if !state.missing_notified {
                send_window_exit(stream, &window_id, "missing", state.protocol_version);
                state.missing_notified = true;
            }
        }
        Some(Err(_)) | None => {
            if !state.missing_notified {
                send_window_exit(stream, &window_id, "not_running", state.protocol_version);
                state.missing_notified = true;
            }
        }
    }
}

fn parse_protocol_version(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(number)) => number.as_u64(),
        Some(Value::String(raw)) => raw.parse::<u64>().ok(),
        _ => None,
    }
}

fn is_supported_protocol_version(version: u64) -> bool {
    version == RUNTIME_STREAM_PROTOCOL_VERSION_V1 || version == RUNTIME_STREAM_PROTOCOL_VERSION_V2
}

fn frame_to_v2_payload(window_id: &str, seq: u64, frame: &Value) -> Value {
    let lines = frame
        .get("lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let line_count = lines.len();

    let cursor_row = frame
        .get("cursorRow")
        .and_then(Value::as_u64)
        .or_else(|| {
            frame
                .get("cursor")
                .and_then(Value::as_object)
                .and_then(|cursor| cursor.get("row"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let cursor_col = frame
        .get("cursorCol")
        .and_then(Value::as_u64)
        .or_else(|| {
            frame
                .get("cursor")
                .and_then(Value::as_object)
                .and_then(|cursor| cursor.get("col"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let cursor_visible = frame
        .get("cursorVisible")
        .and_then(Value::as_bool)
        .or_else(|| {
            frame
                .get("cursor")
                .and_then(Value::as_object)
                .and_then(|cursor| cursor.get("visible"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);

    json!({
        "type": "frame-v2",
        "windowId": window_id,
        "seq": seq,
        "cursorRow": cursor_row,
        "cursorCol": cursor_col,
        "cursorVisible": cursor_visible,
        "lineCount": line_count,
        "lines": lines,
    })
}

fn send_window_exit(stream: &mut UnixStream, window_id: &str, signal: &str, protocol_version: u64) {
    if protocol_version >= RUNTIME_STREAM_PROTOCOL_VERSION_V2 {
        send_message(
            stream,
            json!({
                "type": "window-exit",
                "windowId": window_id,
                "exitCode": Value::Null,
                "signal": signal,
            }),
            protocol_version,
        );
        return;
    }

    send_message(
        stream,
        json!({
            "type": "window-exit",
            "windowId": window_id,
            "code": Value::Null,
            "signal": signal,
        }),
        protocol_version,
    );
}

fn clamp_u16(value: Option<&Value>, min: u16, max: u16, fallback: u16) -> u16 {
    let parsed = value
        .and_then(Value::as_i64)
        .filter(|n| *n >= i64::from(min) && *n <= i64::from(max))
        .map(|n| n as u16);
    parsed.unwrap_or(fallback)
}

fn send_message(stream: &mut UnixStream, payload: Value, stream_protocol_version: u64) {
    if let Some(object) = payload.as_object() {
        let mut with_version = object.clone();
        with_version.insert(
            "streamProtocolVersion".to_string(),
            json!(stream_protocol_version),
        );
        let encoded = Value::Object(with_version).to_string();
        let _ = stream.write_all(encoded.as_bytes());
        let _ = stream.write_all(b"\n");
        let _ = stream.flush();
        return;
    }

    let encoded = payload.to_string();
    let _ = stream.write_all(encoded.as_bytes());
    let _ = stream.write_all(b"\n");
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct MockRuntime {
        input_calls: AtomicUsize,
        resize_calls: AtomicUsize,
        focus_calls: AtomicUsize,
    }

    impl RuntimeStreamRuntime for MockRuntime {
        fn focus_window(&mut self, window_id: &str) -> Result<(), RuntimeControlError> {
            if !window_id.contains(':') {
                return Err(RuntimeControlError::InvalidWindowId);
            }
            self.focus_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn send_input_bytes(
            &mut self,
            window_id: &str,
            _text: &str,
        ) -> Result<(), RuntimeControlError> {
            if !window_id.contains(':') {
                return Err(RuntimeControlError::InvalidWindowId);
            }
            self.input_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn resize_window(
            &mut self,
            window_id: &str,
            _cols: u16,
            _rows: u16,
        ) -> Result<(), RuntimeControlError> {
            if !window_id.contains(':') {
                return Err(RuntimeControlError::InvalidWindowId);
            }
            self.resize_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn get_frame(
            &mut self,
            window_id: &str,
            cols: Option<u16>,
            rows: Option<u16>,
        ) -> Result<Value, RuntimeControlError> {
            if !window_id.contains(':') {
                return Err(RuntimeControlError::InvalidWindowId);
            }
            Ok(json!({
                "cursor": {
                    "row": 0,
                    "col": 0,
                    "visible": true,
                },
                "rows": rows.unwrap_or(40),
                "cols": cols.unwrap_or(120),
                "lines": [
                    {
                        "text": "mock-frame",
                        "segments": [],
                    }
                ],
            }))
        }
    }

    fn unique_socket_path(prefix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        PathBuf::from("/tmp").join(format!("{prefix}-{stamp}.sock"))
    }

    fn wait_for_socket(path: &PathBuf) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(2) {
            if path.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("socket not created: {}", path.display());
    }

    fn connect_with_retry(path: &PathBuf) -> UnixStream {
        let start = Instant::now();
        loop {
            match UnixStream::connect(path) {
                Ok(stream) => return stream,
                Err(_) if start.elapsed() < Duration::from_secs(2) => {
                    std::thread::sleep(Duration::from_millis(15));
                }
                Err(error) => panic!("failed to connect socket {}: {error}", path.display()),
            }
        }
    }

    fn write_json_line(stream: &mut UnixStream, payload: Value) {
        let mut encoded = payload.to_string();
        encoded.push('\n');
        stream
            .write_all(encoded.as_bytes())
            .expect("socket write should succeed");
        stream.flush().expect("socket flush should succeed");
    }

    fn read_for(stream: &mut UnixStream, duration: Duration) -> String {
        stream
            .set_read_timeout(Some(Duration::from_millis(50)))
            .expect("set timeout should succeed");
        let start = Instant::now();
        let mut out = String::new();
        let mut chunk = [0u8; 4096];
        while start.elapsed() < duration {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => out.push_str(&String::from_utf8_lossy(&chunk[..size])),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
        out
    }

    #[test]
    fn parses_protocol_versions() {
        assert_eq!(parse_protocol_version(Some(&json!(1))), Some(1));
        assert_eq!(parse_protocol_version(Some(&json!("2"))), Some(2));
        assert_eq!(parse_protocol_version(Some(&json!("x"))), None);
    }

    #[test]
    fn clamps_dimensions() {
        assert_eq!(clamp_u16(Some(&json!(80)), 30, 240, 120), 80);
        assert_eq!(clamp_u16(Some(&json!(10)), 30, 240, 120), 120);
    }

    #[test]
    fn supports_v2_handshake_and_emits_v2_frames() {
        let socket_path = unique_socket_path("drs-v2");
        let runtime = Arc::new(Mutex::new(MockRuntime::default()));
        let mut service = RuntimeStreamService::new(socket_path.clone(), Arc::clone(&runtime));
        service.start().expect("stream service should start");
        wait_for_socket(&socket_path);

        let mut stream = connect_with_retry(&socket_path);
        let window_id = "bridge:v2";

        write_json_line(&mut stream, json!({ "type": "hello", "version": 2 }));
        write_json_line(
            &mut stream,
            json!({ "type": "subscribe", "windowId": window_id, "cols": 120, "rows": 40 }),
        );
        let output = read_for(&mut stream, Duration::from_millis(350));

        assert!(output.contains("\"type\":\"hello\""));
        assert!(output.contains("\"streamProtocolVersion\":2"));
        assert!(output.contains("\"type\":\"ack\""));
        assert!(output.contains("\"op\":\"subscribe\""));
        assert!(output.contains("\"type\":\"frame-v2\""));
        assert!(!output.contains("\"type\":\"frame-styled\""));

        service.stop();
        let _ = fs::remove_file(socket_path);
    }

    #[test]
    fn rejects_unsupported_protocol_versions() {
        let socket_path = unique_socket_path("drs-vx");
        let runtime = Arc::new(Mutex::new(MockRuntime::default()));
        let mut service = RuntimeStreamService::new(socket_path.clone(), Arc::clone(&runtime));
        service.start().expect("stream service should start");
        wait_for_socket(&socket_path);

        let mut stream = connect_with_retry(&socket_path);
        write_json_line(&mut stream, json!({ "type": "hello", "version": 999 }));
        let output = read_for(&mut stream, Duration::from_millis(200));

        assert!(output.contains("\"code\":\"unsupported_protocol_version\""));
        assert!(output.contains("\"streamProtocolVersion\":2"));

        service.stop();
        let _ = fs::remove_file(socket_path);
    }

    #[test]
    fn handles_concurrent_stream_clients() {
        let socket_path = unique_socket_path("drs-conc");
        let runtime = Arc::new(Mutex::new(MockRuntime::default()));
        let mut service = RuntimeStreamService::new(socket_path.clone(), Arc::clone(&runtime));
        service.start().expect("stream service should start");
        wait_for_socket(&socket_path);

        let mut workers = Vec::new();
        for index in 0..8 {
            let socket_path = socket_path.clone();
            workers.push(thread::spawn(move || {
                let mut stream = connect_with_retry(&socket_path);
                let window_id = format!("bridge:worker-{index}");

                write_json_line(&mut stream, json!({ "type": "hello", "version": 1 }));
                write_json_line(
                    &mut stream,
                    json!({ "type": "subscribe", "windowId": window_id, "cols": 100, "rows": 30 }),
                );
                let bytes = base64::engine::general_purpose::STANDARD.encode("hello");
                write_json_line(
                    &mut stream,
                    json!({ "type": "input", "windowId": window_id, "bytesBase64": bytes }),
                );
                write_json_line(
                    &mut stream,
                    json!({ "type": "resize", "windowId": window_id, "cols": 90, "rows": 28 }),
                );

                let output = read_for(&mut stream, Duration::from_millis(400));
                assert!(output.contains("\"type\":\"hello\""));
                assert!(output.contains("\"type\":\"input\""));
                assert!(output.contains("\"type\":\"frame-styled\""));
            }));
        }

        for worker in workers {
            worker.join().expect("worker should finish cleanly");
        }

        let guard = runtime.lock().expect("runtime lock should be available");
        assert!(guard.input_calls.load(Ordering::SeqCst) >= 8);
        assert!(guard.resize_calls.load(Ordering::SeqCst) >= 8);
        assert!(guard.focus_calls.load(Ordering::SeqCst) == 0);

        service.stop();
        let _ = fs::remove_file(socket_path);
    }

    #[test]
    fn tolerates_rapid_resize_and_input_bursts() {
        let socket_path = unique_socket_path("drs-burst");
        let runtime = Arc::new(Mutex::new(MockRuntime::default()));
        let mut service = RuntimeStreamService::new(socket_path.clone(), Arc::clone(&runtime));
        service.start().expect("stream service should start");
        wait_for_socket(&socket_path);

        let mut stream = connect_with_retry(&socket_path);
        let window_id = "bridge:rapid";
        write_json_line(
            &mut stream,
            json!({ "type": "subscribe", "windowId": window_id, "cols": 120, "rows": 40 }),
        );

        for i in 0..120 {
            let bytes = base64::engine::general_purpose::STANDARD.encode(format!("msg-{i}"));
            write_json_line(
                &mut stream,
                json!({ "type": "input", "windowId": window_id, "bytesBase64": bytes }),
            );
            write_json_line(
                &mut stream,
                json!({ "type": "resize", "windowId": window_id, "cols": 80 + (i % 20), "rows": 24 + (i % 8) }),
            );
        }

        let output = read_for(&mut stream, Duration::from_millis(700));
        assert!(output.contains("\"type\":\"input\""));
        assert!(output.contains("\"type\":\"frame-styled\""));
        assert!(!output.contains("\"code\":\"bad_json\""));

        let guard = runtime.lock().expect("runtime lock should be available");
        assert!(guard.input_calls.load(Ordering::SeqCst) >= 120);
        assert!(guard.resize_calls.load(Ordering::SeqCst) >= 120);

        service.stop();
        let _ = fs::remove_file(socket_path);
    }
}
