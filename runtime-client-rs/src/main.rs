#[cfg(unix)]
use base64::Engine;
#[cfg(unix)]
use crossterm::cursor::{Hide, MoveTo, Show};
#[cfg(unix)]
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
#[cfg(unix)]
use crossterm::style::Print;
#[cfg(unix)]
use crossterm::terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen};
#[cfg(unix)]
use crossterm::{execute, queue};
#[cfg(unix)]
use serde::Deserialize;
#[cfg(unix)]
use serde_json::{json, Value};
#[cfg(unix)]
use std::cmp::{max, min};
#[cfg(unix)]
use std::env;
#[cfg(unix)]
use std::io::{self, BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
#[cfg(unix)]
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
const LOOP_TICK_MS: u64 = 16;
#[cfg(unix)]
const RESIZE_THROTTLE_MS: u64 = 40;
#[cfg(unix)]
const RECONNECT_BACKOFF_MS: [u64; 5] = [100, 300, 1000, 2000, 5000];
#[cfg(unix)]
const RUNTIME_STREAM_PROTOCOL_VERSION_V2: u64 = 2;
#[cfg(unix)]
const PING_INTERVAL_MS: u64 = 5000;
#[cfg(unix)]
const PONG_TIMEOUT_MS: u64 = 15000;
#[cfg(unix)]
const RUNTIME_HTTP_TIMEOUT_MS: u64 = 2000;

#[cfg(unix)]
fn main() {
    if let Err(error) = run() {
        eprintln!("native attach error: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("discode-runtime-client currently supports unix platforms only");
    std::process::exit(1);
}

#[cfg(unix)]
fn run() -> Result<(), String> {
    let args = parse_args(env::args().skip(1))?;
    let mut terminal = TerminalSession::enter()?;
    let mut frame = FrameState::default();
    let mut status = String::from("connecting...");
    let mut scroll = ScrollState::default();
    let mut running = true;
    let mut last_resize_sent_at = Instant::now() - Duration::from_millis(RESIZE_THROTTLE_MS);
    let mut last_ping_sent_at = Instant::now();
    let mut last_pong_received_at = Instant::now();
    let mut ping_seq = 0u64;
    let mut attached_window_id = args.window_id.clone();
    render(&mut terminal.stdout, &frame, &scroll, &status)?;
    let mut connection = connect_and_subscribe(&args, &attached_window_id)?;
    status = "connected (waiting frame)".to_string();
    render(&mut terminal.stdout, &frame, &scroll, &status)?;

    while running {
        let mut reconnect_needed = false;

        loop {
            match connection.rx.try_recv() {
                Ok(event) => match event {
                    StreamEvent::Message(value) => {
                        apply_stream_update(&mut frame, &value);
                        match value
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                        {
                            "hello" => {
                                let version = value
                                    .get("streamProtocolVersion")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0);
                                status = format!("connected (protocol v{version})");
                            }
                            "window-exit" => {
                                if value
                                    .get("windowId")
                                    .and_then(Value::as_str)
                                    .map(|window_id| window_id == attached_window_id)
                                    .unwrap_or(false)
                                {
                                    status = format!("window exited: {}", attached_window_id);
                                    running = false;
                                }
                            }
                            "error" => {
                                let code = value
                                    .get("code")
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown");
                                let message = value
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown");
                                status = format!("stream error: {code} {message}");
                            }
                            "pong" => {
                                last_pong_received_at = Instant::now();
                            }
                            _ => {}
                        }
                        render(&mut terminal.stdout, &frame, &scroll, &status)?;
                    }
                    StreamEvent::Closed => {
                        status = "stream closed".to_string();
                        reconnect_needed = true;
                        render(&mut terminal.stdout, &frame, &scroll, &status)?;
                        break;
                    }
                    StreamEvent::Error(message) => {
                        status = format!("stream error: {message}");
                        reconnect_needed = true;
                        render(&mut terminal.stdout, &frame, &scroll, &status)?;
                        break;
                    }
                },
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    status = "stream disconnected".to_string();
                    reconnect_needed = true;
                    break;
                }
            }
        }

        if reconnect_needed && running {
            connection = reconnect_stream(
                &args,
                &attached_window_id,
                &mut terminal.stdout,
                &frame,
                &mut scroll,
                &mut status,
            )?;
            last_pong_received_at = Instant::now();
            last_ping_sent_at = Instant::now();
            continue;
        }

        if !running {
            break;
        }

        if last_ping_sent_at.elapsed() >= Duration::from_millis(PING_INTERVAL_MS) {
            ping_seq = ping_seq.saturating_add(1);
            let ping_id = format!("ping-{ping_seq}");
            if send_json(
                &connection.writer,
                &json!({
                    "type": "ping",
                    "id": ping_id,
                }),
            )
            .is_ok()
            {
                last_ping_sent_at = Instant::now();
            } else {
                status = "stream ping failed".to_string();
                reconnect_needed = true;
            }
        }

        if last_pong_received_at.elapsed() >= Duration::from_millis(PONG_TIMEOUT_MS) {
            status = "stream heartbeat timeout".to_string();
            reconnect_needed = true;
        }

        if event::poll(Duration::from_millis(LOOP_TICK_MS))
            .map_err(|e| format!("poll terminal event failed: {e}"))?
        {
            let evt = event::read().map_err(|e| format!("read terminal event failed: {e}"))?;
            match evt {
                Event::Key(key) => {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    if should_exit_key(&key) {
                        status = "detached".to_string();
                        running = false;
                        render(&mut terminal.stdout, &frame, &scroll, &status)?;
                        continue;
                    }

                    if let Some(next_status) = handle_scroll_key(key, &frame, &mut scroll) {
                        status = next_status;
                        render(&mut terminal.stdout, &frame, &scroll, &status)?;
                        continue;
                    }

                    if let Some(next_status) = handle_copy_key(&key, &frame, &scroll) {
                        status = next_status;
                        render(&mut terminal.stdout, &frame, &scroll, &status)?;
                        continue;
                    }

                    if let Some(next_status) =
                        handle_switch_key(&key, &args, &connection, &mut attached_window_id)
                    {
                        status = next_status;
                        scroll.offset_from_bottom = 0;
                        render(&mut terminal.stdout, &frame, &scroll, &status)?;
                        continue;
                    }

                    if let Some(bytes) = key_event_to_bytes(key) {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                        if send_json(
                            &connection.writer,
                            &json!({
                                "type": "input",
                                "windowId": attached_window_id,
                                "bytesBase64": encoded,
                            }),
                        )
                        .is_err()
                        {
                            status = "stream write failed".to_string();
                            reconnect_needed = true;
                            render(&mut terminal.stdout, &frame, &scroll, &status)?;
                        }
                    }
                }
                Event::Resize(new_cols, new_rows) => {
                    if last_resize_sent_at.elapsed() >= Duration::from_millis(RESIZE_THROTTLE_MS) {
                        if send_json(
                            &connection.writer,
                            &json!({
                                "type": "resize",
                                "windowId": attached_window_id,
                                "cols": new_cols,
                                "rows": new_rows,
                            }),
                        )
                        .is_ok()
                        {
                            last_resize_sent_at = Instant::now();
                        } else {
                            status = "stream write failed".to_string();
                            reconnect_needed = true;
                        }
                    }
                    render(&mut terminal.stdout, &frame, &scroll, &status)?;
                }
                _ => {}
            }
        }

        if reconnect_needed && running {
            connection = reconnect_stream(
                &args,
                &attached_window_id,
                &mut terminal.stdout,
                &frame,
                &mut scroll,
                &mut status,
            )?;
            last_pong_received_at = Instant::now();
            last_ping_sent_at = Instant::now();
        }
    }

    Ok(())
}

#[cfg(unix)]
struct StreamConnection {
    writer: Arc<Mutex<UnixStream>>,
    rx: Receiver<StreamEvent>,
}

#[cfg(unix)]
fn connect_stream(socket: &str) -> Result<StreamConnection, String> {
    let stream =
        UnixStream::connect(socket).map_err(|e| format!("connect {socket} failed: {e}"))?;
    let writer = Arc::new(Mutex::new(
        stream
            .try_clone()
            .map_err(|e| format!("clone stream failed: {e}"))?,
    ));
    let (tx, rx): (Sender<StreamEvent>, Receiver<StreamEvent>) = mpsc::channel();
    spawn_stream_reader(stream, tx);
    Ok(StreamConnection { writer, rx })
}

#[cfg(unix)]
fn send_hello(writer: &Arc<Mutex<UnixStream>>) -> Result<(), String> {
    send_json(
        writer,
        &json!({ "type": "hello", "version": RUNTIME_STREAM_PROTOCOL_VERSION_V2 }),
    )?;
    Ok(())
}

#[cfg(unix)]
fn send_subscribe_and_focus(
    writer: &Arc<Mutex<UnixStream>>,
    window_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    send_json(
        writer,
        &json!({
            "type": "subscribe",
            "windowId": window_id,
            "cols": cols,
            "rows": rows,
        }),
    )?;
    send_json(
        writer,
        &json!({
            "type": "focus",
            "windowId": window_id,
        }),
    )?;
    Ok(())
}

#[cfg(unix)]
fn connect_and_subscribe(args: &ParsedArgs, window_id: &str) -> Result<StreamConnection, String> {
    let (cols, rows) = terminal::size().unwrap_or((args.cols, args.rows));
    let connection = connect_stream(&args.socket)?;
    send_hello(&connection.writer)?;
    send_subscribe_and_focus(&connection.writer, window_id, cols, rows)?;
    Ok(connection)
}

#[cfg(unix)]
fn reconnect_delay_ms(attempt: usize) -> u64 {
    RECONNECT_BACKOFF_MS[min(attempt, RECONNECT_BACKOFF_MS.len() - 1)]
}

#[cfg(unix)]
fn reconnect_stream(
    args: &ParsedArgs,
    window_id: &str,
    stdout: &mut io::Stdout,
    frame: &FrameState,
    scroll: &mut ScrollState,
    status: &mut String,
) -> Result<StreamConnection, String> {
    let mut attempt = 0usize;
    loop {
        let delay = reconnect_delay_ms(attempt);
        *status = format!(
            "stream disconnected; reconnecting in {delay}ms (attempt {})",
            attempt + 1
        );
        render(stdout, frame, scroll, status)?;
        thread::sleep(Duration::from_millis(delay));

        match connect_and_subscribe(args, window_id) {
            Ok(connection) => {
                scroll.offset_from_bottom = 0;
                *status = "reconnected (waiting frame)".to_string();
                render(stdout, frame, scroll, status)?;
                return Ok(connection);
            }
            Err(error) => {
                *status = format!("reconnect failed: {error}");
                render(stdout, frame, scroll, status)?;
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

#[cfg(unix)]
fn spawn_stream_reader(stream: UnixStream, tx: Sender<StreamEvent>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(StreamEvent::Closed);
                    return;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(trimmed) {
                        Ok(value) => {
                            let _ = tx.send(StreamEvent::Message(value));
                        }
                        Err(error) => {
                            let _ = tx.send(StreamEvent::Error(format!(
                                "invalid JSON from stream: {error}"
                            )));
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = tx.send(StreamEvent::Error(format!("socket read failed: {error}")));
                    return;
                }
            }
        }
    });
}

#[cfg(unix)]
enum StreamEvent {
    Message(Value),
    Closed,
    Error(String),
}

#[cfg(unix)]
fn send_json(writer: &Arc<Mutex<UnixStream>>, value: &Value) -> Result<(), String> {
    let encoded = value.to_string();
    let mut guard = writer
        .lock()
        .map_err(|_| "writer lock poisoned".to_string())?;
    guard
        .write_all(encoded.as_bytes())
        .map_err(|e| format!("write stream failed: {e}"))?;
    guard
        .write_all(b"\n")
        .map_err(|e| format!("write stream failed: {e}"))?;
    guard
        .flush()
        .map_err(|e| format!("flush stream failed: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn should_exit_key(key: &KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('q') | KeyCode::Char('Q'))
}

#[cfg(unix)]
fn handle_scroll_key(
    key: KeyEvent,
    frame: &FrameState,
    scroll: &mut ScrollState,
) -> Option<String> {
    let (_, rows) = terminal::size().unwrap_or((120, 40));
    let usable_rows = max(1, rows.saturating_sub(1)) as usize;
    let page = max(1, usable_rows / 2);
    let max_offset = compute_max_scroll_offset(frame.lines.len(), usable_rows);

    match key.code {
        KeyCode::PageUp => {
            scroll.offset_from_bottom =
                min(max_offset, scroll.offset_from_bottom.saturating_add(page));
            Some(format!(
                "scroll: {}/{} lines from bottom (PgUp/PgDn/Home/End, Ctrl+W switch, Ctrl+Y copy, Ctrl+Q detach)",
                scroll.offset_from_bottom, max_offset
            ))
        }
        KeyCode::PageDown => {
            scroll.offset_from_bottom = scroll.offset_from_bottom.saturating_sub(page);
            Some(if scroll.offset_from_bottom == 0 {
                "live mode (Ctrl+W switch, Ctrl+Y copy, Ctrl+Q detach)".to_string()
            } else {
                format!(
                    "scroll: {}/{} lines from bottom (PgUp/PgDn/Home/End, Ctrl+W switch, Ctrl+Y copy, Ctrl+Q detach)",
                    scroll.offset_from_bottom, max_offset
                )
            })
        }
        KeyCode::Home => {
            scroll.offset_from_bottom = max_offset;
            Some(format!(
                "scroll: {}/{} lines from bottom (PgUp/PgDn/Home/End, Ctrl+W switch, Ctrl+Y copy, Ctrl+Q detach)",
                scroll.offset_from_bottom, max_offset
            ))
        }
        KeyCode::End => {
            scroll.offset_from_bottom = 0;
            Some("live mode (Ctrl+W switch, Ctrl+Y copy, Ctrl+Q detach)".to_string())
        }
        KeyCode::Char('f') | KeyCode::Char('F')
            if key.modifiers.contains(KeyModifiers::CONTROL) =>
        {
            scroll.offset_from_bottom = 0;
            Some("live mode (Ctrl+W switch, Ctrl+Y copy, Ctrl+Q detach)".to_string())
        }
        _ => None,
    }
}

#[cfg(unix)]
fn is_copy_key(key: &KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y'))
}

#[cfg(unix)]
fn handle_copy_key(key: &KeyEvent, frame: &FrameState, scroll: &ScrollState) -> Option<String> {
    if !is_copy_key(key) {
        return None;
    }
    let (visible_text, line_count) = build_visible_text(frame, scroll);
    if line_count == 0 {
        return Some("copy skipped: no visible lines".to_string());
    }

    match copy_to_clipboard(&visible_text) {
        Ok(()) => Some(format!(
            "copied {} visible lines (Ctrl+Y copy, Ctrl+Q detach)",
            line_count
        )),
        Err(error) => Some(format!("copy failed: {error}")),
    }
}

#[cfg(unix)]
fn build_visible_text(frame: &FrameState, scroll: &ScrollState) -> (String, usize) {
    let (_, rows) = terminal::size().unwrap_or((120, 40));
    let usable_rows = max(1, rows.saturating_sub(1)) as usize;
    build_visible_text_for_rows(frame, scroll, usable_rows)
}

#[cfg(unix)]
fn build_visible_text_for_rows(
    frame: &FrameState,
    scroll: &ScrollState,
    usable_rows: usize,
) -> (String, usize) {
    let (start, end, _, _) =
        compute_visible_range(frame.lines.len(), usable_rows, scroll.offset_from_bottom);
    if start >= end {
        return (String::new(), 0);
    }

    let mut output = String::new();
    for idx in start..end {
        if idx > start {
            output.push('\n');
        }
        output.push_str(frame.lines.get(idx).map_or("", String::as_str));
    }
    (output, end.saturating_sub(start))
}

#[cfg(unix)]
fn copy_to_clipboard(content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("nothing to copy".to_string());
    }

    let candidates: [(&str, &[&str]); 4] = [
        ("pbcopy", &[]),
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ];

    let mut attempted = false;
    for (bin, args) in candidates {
        match copy_with_command(bin, args, content) {
            Ok(true) => return Ok(()),
            Ok(false) => {
                attempted = true;
            }
            Err(error) => return Err(error),
        }
    }

    if attempted {
        Err("clipboard command failed".to_string())
    } else {
        Err("no clipboard utility found (pbcopy/wl-copy/xclip/xsel)".to_string())
    }
}

#[cfg(unix)]
fn copy_with_command(bin: &str, args: &[&str], content: &str) -> Result<bool, String> {
    let mut child = match Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("failed to execute {bin}: {error}")),
    };

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("failed to write clipboard input: {e}"))?;
    }

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait for {bin}: {e}"))?;
    Ok(status.success())
}

#[cfg(unix)]
fn is_switch_key(key: &KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('w') | KeyCode::Char('W'))
}

#[cfg(unix)]
fn handle_switch_key(
    key: &KeyEvent,
    args: &ParsedArgs,
    connection: &StreamConnection,
    attached_window_id: &mut String,
) -> Option<String> {
    if !is_switch_key(key) {
        return None;
    }

    match switch_to_next_window(args, connection, attached_window_id) {
        Ok(Some(next_window_id)) => {
            *attached_window_id = next_window_id.clone();
            Some(format!(
                "switched window: {} (Ctrl+W switch, Ctrl+Y copy, Ctrl+Q detach)",
                next_window_id
            ))
        }
        Ok(None) => Some("switch skipped: no other runtime window".to_string()),
        Err(error) => Some(format!("switch failed: {error}")),
    }
}

#[cfg(unix)]
fn switch_to_next_window(
    args: &ParsedArgs,
    connection: &StreamConnection,
    current_window_id: &str,
) -> Result<Option<String>, String> {
    let token = read_hook_token();
    let response = fetch_runtime_windows(args.daemon_port, token.as_deref())?;
    if response.windows.is_empty() {
        return Ok(None);
    }

    let mut window_ids = response
        .windows
        .iter()
        .map(|window| window.window_id.as_str())
        .collect::<Vec<_>>();
    window_ids.sort_unstable();
    window_ids.dedup();
    if window_ids.is_empty() {
        return Ok(None);
    }

    let current = if window_ids.iter().any(|id| *id == current_window_id) {
        current_window_id
    } else if let Some(active) = response.active_window_id.as_deref() {
        active
    } else {
        window_ids[0]
    };

    let current_index = window_ids.iter().position(|id| *id == current).unwrap_or(0);
    let next_index = (current_index + 1) % window_ids.len();
    let next_window_id = window_ids[next_index].to_string();
    if next_window_id == current_window_id {
        return Ok(None);
    }

    let (cols, rows) = terminal::size().unwrap_or((args.cols, args.rows));
    send_subscribe_and_focus(&connection.writer, &next_window_id, cols, rows)?;
    Ok(Some(next_window_id))
}

#[cfg(unix)]
fn read_hook_token() -> Option<String> {
    if let Ok(value) = env::var("DISCODE_HOOK_TOKEN") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let home = env::var("HOME").ok()?;
    let path = format!("{home}/.discode/.hook-token");
    let token = std::fs::read_to_string(path).ok()?;
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(unix)]
#[derive(Deserialize)]
struct RuntimeWindowsResponse {
    #[serde(rename = "activeWindowId")]
    active_window_id: Option<String>,
    #[serde(default)]
    windows: Vec<RuntimeWindowInfo>,
}

#[cfg(unix)]
#[derive(Deserialize)]
struct RuntimeWindowInfo {
    #[serde(rename = "windowId")]
    window_id: String,
}

#[cfg(unix)]
fn fetch_runtime_windows(port: u16, token: Option<&str>) -> Result<RuntimeWindowsResponse, String> {
    let (status, body) = runtime_http_request(port, "GET", "/runtime/windows", None, token)?;
    if status != 200 {
        return Err(format!("runtime windows status={status}"));
    }
    serde_json::from_str::<RuntimeWindowsResponse>(&body)
        .map_err(|e| format!("runtime windows parse failed: {e}"))
}

#[cfg(unix)]
fn runtime_http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    bearer_token: Option<&str>,
) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("connect runtime http 127.0.0.1:{port} failed: {e}"))?;
    let timeout = Some(Duration::from_millis(RUNTIME_HTTP_TIMEOUT_MS));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);

    let payload = body.unwrap_or("");
    let mut request =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(token) = bearer_token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if body.is_some() {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    request.push_str("\r\n");
    request.push_str(payload);

    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write runtime http request failed: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("flush runtime http request failed: {e}"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("read runtime http response failed: {e}"))?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body_part) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "invalid runtime http response".to_string())?;
    let status_line = head
        .lines()
        .next()
        .ok_or_else(|| "missing runtime http status line".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "invalid runtime http status line".to_string())?
        .parse::<u16>()
        .map_err(|_| format!("invalid runtime http status: {status_line}"))?;
    Ok((status, body_part.to_string()))
}

#[cfg(unix)]
fn key_event_to_bytes(key: KeyEvent) -> Option<Vec<u8>> {
    match key.code {
        KeyCode::Enter => Some(vec![b'\r']),
        KeyCode::Backspace => Some(vec![0x7f]),
        KeyCode::Tab => Some(vec![b'\t']),
        KeyCode::Esc => Some(vec![0x1b]),
        KeyCode::Left => Some(b"\x1b[D".to_vec()),
        KeyCode::Right => Some(b"\x1b[C".to_vec()),
        KeyCode::Up => Some(b"\x1b[A".to_vec()),
        KeyCode::Down => Some(b"\x1b[B".to_vec()),
        KeyCode::Home => Some(b"\x1b[H".to_vec()),
        KeyCode::End => Some(b"\x1b[F".to_vec()),
        KeyCode::Delete => Some(b"\x1b[3~".to_vec()),
        KeyCode::PageUp => Some(b"\x1b[5~".to_vec()),
        KeyCode::PageDown => Some(b"\x1b[6~".to_vec()),
        KeyCode::Char(ch) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                let lower = ch.to_ascii_lowercase();
                if lower.is_ascii_alphabetic() {
                    return Some(vec![(lower as u8) & 0x1f]);
                }
            }
            if key.modifiers.contains(KeyModifiers::ALT) {
                let mut out = vec![0x1b];
                let mut bytes = [0u8; 4];
                let raw = ch.encode_utf8(&mut bytes);
                out.extend_from_slice(raw.as_bytes());
                return Some(out);
            }
            let mut bytes = [0u8; 4];
            let raw = ch.encode_utf8(&mut bytes);
            Some(raw.as_bytes().to_vec())
        }
        _ => None,
    }
}

#[cfg(unix)]
#[derive(Default)]
struct FrameState {
    lines: Vec<String>,
    cursor_row: Option<u16>,
    cursor_col: Option<u16>,
    cursor_visible: bool,
}

#[cfg(unix)]
#[derive(Default)]
struct ScrollState {
    offset_from_bottom: usize,
}

#[cfg(unix)]
fn extract_frame_state(value: &Value) -> Option<FrameState> {
    let message_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match message_type {
        "frame" => {
            let lines = value.get("lines")?;
            Some(FrameState {
                lines: render_plain_lines(lines),
                cursor_row: None,
                cursor_col: None,
                cursor_visible: true,
            })
        }
        "frame-v2" => {
            let lines = value.get("lines")?;
            Some(FrameState {
                lines: render_plain_lines(lines),
                cursor_row: value
                    .get("cursorRow")
                    .and_then(Value::as_u64)
                    .map(|n| min(n, u16::MAX as u64) as u16),
                cursor_col: value
                    .get("cursorCol")
                    .and_then(Value::as_u64)
                    .map(|n| min(n, u16::MAX as u64) as u16),
                cursor_visible: value
                    .get("cursorVisible")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            })
        }
        "frame-styled" => {
            let frame = value.get("frame").unwrap_or(value);
            let lines = frame.get("lines")?;
            let cursor = frame.get("cursor");
            Some(FrameState {
                lines: render_plain_lines(lines),
                cursor_row: frame
                    .get("cursorRow")
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        cursor
                            .and_then(Value::as_object)
                            .and_then(|obj| obj.get("row"))
                            .and_then(Value::as_u64)
                    })
                    .map(|n| min(n, u16::MAX as u64) as u16),
                cursor_col: frame
                    .get("cursorCol")
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        cursor
                            .and_then(Value::as_object)
                            .and_then(|obj| obj.get("col"))
                            .and_then(Value::as_u64)
                    })
                    .map(|n| min(n, u16::MAX as u64) as u16),
                cursor_visible: frame
                    .get("cursorVisible")
                    .and_then(Value::as_bool)
                    .or_else(|| {
                        cursor
                            .and_then(Value::as_object)
                            .and_then(|obj| obj.get("visible"))
                            .and_then(Value::as_bool)
                    })
                    .unwrap_or(true),
            })
        }
        _ => None,
    }
}

#[cfg(unix)]
fn extract_patch_state(current: &FrameState, value: &Value) -> Option<FrameState> {
    let message_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match message_type {
        "patch" | "patch-styled" => apply_index_patch(current, value),
        "patch-v2" => apply_patch_v2(current, value),
        _ => None,
    }
}

#[cfg(unix)]
fn apply_stream_update(frame: &mut FrameState, value: &Value) {
    if let Some(next) = extract_frame_state(value) {
        *frame = next;
        return;
    }
    if let Some(next) = extract_patch_state(frame, value) {
        *frame = next;
    }
}

#[cfg(unix)]
fn apply_index_patch(current: &FrameState, value: &Value) -> Option<FrameState> {
    let mut next = FrameState {
        lines: current.lines.clone(),
        cursor_row: current.cursor_row,
        cursor_col: current.cursor_col,
        cursor_visible: current.cursor_visible,
    };
    let line_count = value
        .get("lineCount")
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    if let Some(count) = line_count {
        next.lines.resize(count, String::new());
    }

    let ops = value.get("ops").and_then(Value::as_array)?;
    for op in ops {
        let Some(index) = op.get("index").and_then(Value::as_u64).map(|n| n as usize) else {
            continue;
        };
        if let Some(count) = line_count {
            if index >= count {
                continue;
            }
        }
        if index >= next.lines.len() {
            next.lines.resize(index + 1, String::new());
        }
        let text = op.get("line").map(render_plain_line).unwrap_or_default();
        next.lines[index] = text;
    }

    if let Some(count) = line_count {
        next.lines.resize(count, String::new());
    }
    next.cursor_row = parse_cursor_row(value).or(current.cursor_row);
    next.cursor_col = parse_cursor_col(value).or(current.cursor_col);
    next.cursor_visible = parse_cursor_visible(value).unwrap_or(current.cursor_visible);
    Some(next)
}

#[cfg(unix)]
fn apply_patch_v2(current: &FrameState, value: &Value) -> Option<FrameState> {
    let ops = value.get("ops").and_then(Value::as_array)?;
    let mut lines = current.lines.clone();
    for op in ops {
        if op.get("kind").and_then(Value::as_str).unwrap_or_default() != "replace" {
            continue;
        }
        let Some(start) = op.get("start").and_then(Value::as_u64).map(|n| n as usize) else {
            continue;
        };
        let delete_count = op
            .get("deleteCount")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(0);
        let insert_lines = op.get("lines").map(render_plain_lines).unwrap_or_default();
        if start > lines.len() {
            lines.resize(start, String::new());
        }
        let end = min(start.saturating_add(delete_count), lines.len());
        lines.splice(start..end, insert_lines);
    }

    if let Some(count) = value
        .get("lineCount")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
    {
        lines.resize(count, String::new());
    }

    Some(FrameState {
        lines,
        cursor_row: parse_cursor_row(value).or(current.cursor_row),
        cursor_col: parse_cursor_col(value).or(current.cursor_col),
        cursor_visible: parse_cursor_visible(value).unwrap_or(current.cursor_visible),
    })
}

#[cfg(unix)]
fn parse_cursor_row(value: &Value) -> Option<u16> {
    value
        .get("cursorRow")
        .and_then(Value::as_u64)
        .map(|n| min(n, u16::MAX as u64) as u16)
}

#[cfg(unix)]
fn parse_cursor_col(value: &Value) -> Option<u16> {
    value
        .get("cursorCol")
        .and_then(Value::as_u64)
        .map(|n| min(n, u16::MAX as u64) as u16)
}

#[cfg(unix)]
fn parse_cursor_visible(value: &Value) -> Option<bool> {
    value.get("cursorVisible").and_then(Value::as_bool)
}

#[cfg(unix)]
fn render_plain_lines(lines: &Value) -> Vec<String> {
    let Some(lines_array) = lines.as_array() else {
        return vec![];
    };

    lines_array.iter().map(render_plain_line).collect()
}

#[cfg(unix)]
fn render_plain_line(line: &Value) -> String {
    if let Some(text) = line.as_str() {
        return text.to_string();
    }
    if let Some(text) = line.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    let Some(segments) = line.get("segments").and_then(Value::as_array) else {
        return String::new();
    };
    let mut row = String::new();
    for segment in segments {
        if let Some(text) = segment.get("text").and_then(Value::as_str) {
            row.push_str(text);
        }
    }
    row
}

#[cfg(unix)]
fn compute_max_scroll_offset(total_lines: usize, usable_rows: usize) -> usize {
    total_lines.saturating_sub(usable_rows)
}

#[cfg(unix)]
fn compute_visible_range(
    total_lines: usize,
    usable_rows: usize,
    requested_offset: usize,
) -> (usize, usize, usize, usize) {
    let max_offset = compute_max_scroll_offset(total_lines, usable_rows);
    let offset = min(requested_offset, max_offset);
    let end = total_lines.saturating_sub(offset);
    let start = end.saturating_sub(usable_rows);
    (start, end, max_offset, offset)
}

#[cfg(unix)]
fn render(
    stdout: &mut io::Stdout,
    frame: &FrameState,
    scroll: &ScrollState,
    status: &str,
) -> Result<(), String> {
    let (cols, rows) = terminal::size().map_err(|e| format!("read terminal size failed: {e}"))?;
    let usable_rows = max(1, rows.saturating_sub(1));
    let cols_usize = cols as usize;
    let usable_rows_usize = usable_rows as usize;
    let (start, end, max_offset, offset) = compute_visible_range(
        frame.lines.len(),
        usable_rows_usize,
        scroll.offset_from_bottom,
    );

    queue!(stdout, MoveTo(0, 0), Clear(ClearType::All))
        .map_err(|e| format!("terminal clear failed: {e}"))?;

    for row in 0..usable_rows_usize {
        let idx = start.saturating_add(row);
        let text = frame.lines.get(idx).map_or("", String::as_str);
        let rendered = text.chars().take(cols_usize).collect::<String>();
        queue!(stdout, MoveTo(0, row as u16), Print(rendered))
            .map_err(|e| format!("terminal draw failed: {e}"))?;
    }

    let status_row = rows.saturating_sub(1);
    let mode_label = if offset == 0 { "live" } else { "scroll" };
    let status_full = format!(
        "{status} | mode:{mode_label} offset:{offset}/{max_offset} | Ctrl+W switch | Ctrl+Y copy | Ctrl+Q detach"
    );
    let status_text = status_full.chars().take(cols_usize).collect::<String>();
    queue!(stdout, MoveTo(0, status_row), Print(status_text))
        .map_err(|e| format!("terminal status draw failed: {e}"))?;

    if frame.cursor_visible && offset == 0 {
        if let (Some(row), Some(col)) = (frame.cursor_row, frame.cursor_col) {
            if (row as usize) >= start && (row as usize) < end {
                let local_row = (row as usize).saturating_sub(start) as u16;
                queue!(
                    stdout,
                    Show,
                    MoveTo(min(col, cols.saturating_sub(1)), local_row)
                )
                .map_err(|e| format!("terminal cursor draw failed: {e}"))?;
            } else {
                queue!(stdout, Hide).map_err(|e| format!("terminal cursor hide failed: {e}"))?;
            }
        } else {
            queue!(stdout, Hide).map_err(|e| format!("terminal cursor hide failed: {e}"))?;
        }
    } else {
        queue!(stdout, Hide).map_err(|e| format!("terminal cursor hide failed: {e}"))?;
    }

    stdout
        .flush()
        .map_err(|e| format!("terminal flush failed: {e}"))?;
    Ok(())
}

#[cfg(unix)]
struct TerminalSession {
    stdout: io::Stdout,
}

#[cfg(unix)]
impl TerminalSession {
    fn enter() -> Result<Self, String> {
        let mut stdout = io::stdout();
        terminal::enable_raw_mode().map_err(|e| format!("enable raw mode failed: {e}"))?;
        execute!(stdout, EnterAlternateScreen, Hide)
            .map_err(|e| format!("enter alternate screen failed: {e}"))?;
        Ok(Self { stdout })
    }
}

#[cfg(unix)]
impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = execute!(self.stdout, Show, LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
    }
}

#[cfg(unix)]
struct ParsedArgs {
    socket: String,
    window_id: String,
    daemon_port: u16,
    cols: u16,
    rows: u16,
}

#[cfg(unix)]
fn parse_args<I>(args: I) -> Result<ParsedArgs, String>
where
    I: Iterator<Item = String>,
{
    let mut socket = default_socket_path();
    let mut window_id: Option<String> = None;
    let mut daemon_port = default_daemon_port();
    let mut cols = 120u16;
    let mut rows = 40u16;

    let mut iter = args.peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--socket" => {
                socket = iter
                    .next()
                    .ok_or_else(|| "--socket requires a value".to_string())?;
            }
            "--window-id" => {
                window_id = Some(
                    iter.next()
                        .ok_or_else(|| "--window-id requires a value".to_string())?,
                );
            }
            "--daemon-port" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--daemon-port requires a value".to_string())?;
                daemon_port = raw
                    .parse::<u16>()
                    .map_err(|_| format!("invalid --daemon-port value: {raw}"))?;
            }
            "--cols" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--cols requires a value".to_string())?;
                cols = raw
                    .parse::<u16>()
                    .map_err(|_| format!("invalid --cols value: {raw}"))?;
            }
            "--rows" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--rows requires a value".to_string())?;
                rows = raw
                    .parse::<u16>()
                    .map_err(|_| format!("invalid --rows value: {raw}"))?;
            }
            "--help" | "-h" => {
                println!(
                    "Usage: discode-runtime-client --window-id <session:window> [--socket <path>] [--daemon-port <n>] [--cols <n>] [--rows <n>]\n\nKeys: Ctrl+Q detach, Ctrl+W switch window, Ctrl+Y copy visible lines, PgUp/PgDn scroll, Home top, End live"
                );
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }

    let window_id = window_id.ok_or_else(|| "--window-id is required".to_string())?;

    Ok(ParsedArgs {
        socket,
        window_id,
        daemon_port,
        cols,
        rows,
    })
}

#[cfg(unix)]
fn default_daemon_port() -> u16 {
    env::var("DISCODE_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .unwrap_or(18470)
}

#[cfg(unix)]
fn default_socket_path() -> String {
    match env::var("HOME") {
        Ok(home) if !home.is_empty() => format!("{home}/.discode/runtime.sock"),
        _ => "/tmp/discode-runtime.sock".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_stream_update, build_visible_text_for_rows, compute_max_scroll_offset,
        compute_visible_range, is_copy_key, is_switch_key, key_event_to_bytes, parse_args,
        reconnect_delay_ms, render_plain_lines, FrameState, ScrollState,
    };
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use serde_json::json;

    #[test]
    fn maps_arrow_keys_to_ansi() {
        let key = KeyEvent::new(KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(key), Some(b"\x1b[A".to_vec()));
    }

    #[test]
    fn maps_ctrl_c_to_etx() {
        let key = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_bytes(key), Some(vec![0x03]));
    }

    #[test]
    fn renders_segmented_lines_to_plain_text() {
        let lines = json!([
            { "segments": [ { "text": "abc" }, { "text": "123" } ] },
            { "text": "plain" }
        ]);
        assert_eq!(
            render_plain_lines(&lines),
            vec!["abc123".to_string(), "plain".to_string()]
        );
    }

    #[test]
    fn renders_plain_string_lines() {
        let lines = json!(["hello", "world"]);
        assert_eq!(
            render_plain_lines(&lines),
            vec!["hello".to_string(), "world".to_string()]
        );
    }

    #[test]
    fn computes_max_scroll_offset() {
        assert_eq!(compute_max_scroll_offset(10, 10), 0);
        assert_eq!(compute_max_scroll_offset(30, 10), 20);
        assert_eq!(compute_max_scroll_offset(5, 10), 0);
    }

    #[test]
    fn reconnect_delay_is_capped() {
        assert_eq!(reconnect_delay_ms(0), 100);
        assert_eq!(reconnect_delay_ms(1), 300);
        assert_eq!(reconnect_delay_ms(2), 1000);
        assert_eq!(reconnect_delay_ms(3), 2000);
        assert_eq!(reconnect_delay_ms(4), 5000);
        assert_eq!(reconnect_delay_ms(20), 5000);
    }

    #[test]
    fn applies_patch_styled_updates() {
        let mut frame = FrameState {
            lines: vec!["line-0".to_string(), "line-1".to_string()],
            cursor_row: None,
            cursor_col: None,
            cursor_visible: true,
        };
        let patch = json!({
            "type": "patch-styled",
            "lineCount": 2,
            "ops": [
                {
                    "index": 1,
                    "line": { "segments": [ { "text": "line-1-updated" } ] }
                }
            ]
        });

        apply_stream_update(&mut frame, &patch);
        assert_eq!(
            frame.lines,
            vec!["line-0".to_string(), "line-1-updated".to_string()]
        );
    }

    #[test]
    fn accepts_frame_styled_top_level_shape() {
        let mut frame = FrameState::default();
        let message = json!({
            "type": "frame-styled",
            "lines": [
                { "segments": [ { "text": "prompt> " }, { "text": "ls" } ] }
            ],
            "cursorRow": 0,
            "cursorCol": 10,
            "cursorVisible": true
        });

        apply_stream_update(&mut frame, &message);
        assert_eq!(frame.lines, vec!["prompt> ls".to_string()]);
        assert_eq!(frame.cursor_row, Some(0));
        assert_eq!(frame.cursor_col, Some(10));
        assert!(frame.cursor_visible);
    }

    #[test]
    fn applies_patch_v2_replace_and_cursor() {
        let mut frame = FrameState {
            lines: vec!["a".to_string(), "b".to_string(), "c".to_string()],
            cursor_row: Some(0),
            cursor_col: Some(0),
            cursor_visible: true,
        };
        let patch = json!({
            "type": "patch-v2",
            "lineCount": 3,
            "ops": [
                {
                    "kind": "replace",
                    "start": 1,
                    "deleteCount": 1,
                    "lines": [
                        { "segments": [ { "text": "B" } ] }
                    ]
                }
            ],
            "cursorRow": 2,
            "cursorCol": 4,
            "cursorVisible": false
        });

        apply_stream_update(&mut frame, &patch);
        assert_eq!(
            frame.lines,
            vec!["a".to_string(), "B".to_string(), "c".to_string()]
        );
        assert_eq!(frame.cursor_row, Some(2));
        assert_eq!(frame.cursor_col, Some(4));
        assert!(!frame.cursor_visible);
    }

    #[test]
    fn detects_copy_shortcut() {
        assert!(is_copy_key(&KeyEvent::new(
            KeyCode::Char('y'),
            KeyModifiers::CONTROL
        )));
        assert!(is_copy_key(&KeyEvent::new(
            KeyCode::Char('Y'),
            KeyModifiers::CONTROL
        )));
        assert!(!is_copy_key(&KeyEvent::new(
            KeyCode::Char('y'),
            KeyModifiers::NONE
        )));
    }

    #[test]
    fn detects_switch_shortcut() {
        assert!(is_switch_key(&KeyEvent::new(
            KeyCode::Char('w'),
            KeyModifiers::CONTROL
        )));
        assert!(is_switch_key(&KeyEvent::new(
            KeyCode::Char('W'),
            KeyModifiers::CONTROL
        )));
        assert!(!is_switch_key(&KeyEvent::new(
            KeyCode::Char('w'),
            KeyModifiers::NONE
        )));
    }

    #[test]
    fn computes_visible_range_clamping() {
        let (start, end, max_offset, offset) = compute_visible_range(50, 10, 1000);
        assert_eq!(max_offset, 40);
        assert_eq!(offset, 40);
        assert_eq!((start, end), (0, 10));
    }

    #[test]
    fn builds_visible_text_for_rows() {
        let frame = FrameState {
            lines: (0..6).map(|n| format!("line-{n}")).collect(),
            cursor_row: None,
            cursor_col: None,
            cursor_visible: false,
        };
        let scroll = ScrollState {
            offset_from_bottom: 1,
        };
        let (text, line_count) = build_visible_text_for_rows(&frame, &scroll, 3);
        assert_eq!(line_count, 3);
        assert_eq!(text, "line-2\nline-3\nline-4");
    }

    #[test]
    fn parses_daemon_port_arg() {
        let parsed = parse_args(
            [
                "--window-id",
                "bridge:demo",
                "--daemon-port",
                "19000",
                "--rows",
                "50",
            ]
            .into_iter()
            .map(String::from),
        )
        .expect("parse args");
        assert_eq!(parsed.window_id, "bridge:demo");
        assert_eq!(parsed.daemon_port, 19000);
        assert_eq!(parsed.rows, 50);
    }
}
