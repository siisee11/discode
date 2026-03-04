mod compat;
mod hook_server;
mod runtime_control;
mod runtime_stream;

use fs2::FileExt;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use nix::sys::signal::{kill, Signal};
#[cfg(unix)]
use nix::unistd::Pid;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

const DEFAULT_PORT: u16 = 18470;
const DEFAULT_TIMEOUT_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Start,
    Stop,
    Status,
    Restart,
    Run,
}

#[derive(Debug, Clone)]
struct CliOptions {
    action: Action,
    port: u16,
    state_dir: PathBuf,
    log_file: Option<PathBuf>,
    timeout_ms: u64,
    no_caffeinate: bool,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let opts = match parse_args(&args) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            print_usage();
            process::exit(2);
        }
    };

    let result = match opts.action {
        Action::Start => command_start(&opts),
        Action::Stop => command_stop(&opts),
        Action::Status => command_status(&opts),
        Action::Restart => command_restart(&opts),
        Action::Run => command_run(&opts),
    };

    if let Err(message) = result {
        eprintln!("{message}");
        process::exit(1);
    }
}

fn parse_args(args: &[String]) -> Result<CliOptions, String> {
    if args.len() < 2 {
        return Err("Missing action (start|stop|status|restart|run)".to_string());
    }

    if args[1] == "-h" || args[1] == "--help" {
        print_usage();
        process::exit(0);
    }

    let action = match args[1].as_str() {
        "start" => Action::Start,
        "stop" => Action::Stop,
        "status" => Action::Status,
        "restart" => Action::Restart,
        "run" => Action::Run,
        other => {
            return Err(format!(
                "Unknown action '{other}' (expected start|stop|status|restart|run)"
            ))
        }
    };

    let mut port = read_port_from_env().unwrap_or(DEFAULT_PORT);
    let mut state_dir = default_state_dir();
    let mut log_file: Option<PathBuf> = None;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut no_caffeinate = false;

    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                let Some(raw) = args.get(i) else {
                    return Err("--port requires a value".to_string());
                };
                port = raw
                    .parse::<u16>()
                    .map_err(|_| format!("Invalid --port value: {raw}"))?;
            }
            "--state-dir" => {
                i += 1;
                let Some(raw) = args.get(i) else {
                    return Err("--state-dir requires a value".to_string());
                };
                state_dir = PathBuf::from(raw);
            }
            "--log-file" => {
                i += 1;
                let Some(raw) = args.get(i) else {
                    return Err("--log-file requires a value".to_string());
                };
                log_file = Some(PathBuf::from(raw));
            }
            "--timeout-ms" => {
                i += 1;
                let Some(raw) = args.get(i) else {
                    return Err("--timeout-ms requires a value".to_string());
                };
                timeout_ms = raw
                    .parse::<u64>()
                    .map_err(|_| format!("Invalid --timeout-ms value: {raw}"))?;
            }
            "--no-caffeinate" => {
                no_caffeinate = true;
            }
            other => {
                return Err(format!("Unknown option: {other}"));
            }
        }
        i += 1;
    }

    Ok(CliOptions {
        action,
        port,
        state_dir,
        log_file,
        timeout_ms,
        no_caffeinate,
    })
}

fn print_usage() {
    println!(
        "discode-daemon-rs <action> [options]\n\
         \n\
         Actions:\n\
           start     Start daemon in background\n\
           stop      Stop daemon\n\
           status    Show daemon status\n\
           restart   Restart daemon\n\
           run       Run daemon in foreground\n\
         \n\
         Options:\n\
           --port <n>          Hook server port (default: 18470 or HOOK_SERVER_PORT)\n\
           --state-dir <path>  State directory (default: ~/.discode)\n\
           --log-file <path>   Log file path (default: <state-dir>/daemon.log)\n\
           --timeout-ms <ms>   Startup/shutdown wait timeout (default: 5000)\n\
           --no-caffeinate     Disable macOS caffeinate wrapper for start\n"
    );
}

fn read_port_from_env() -> Option<u16> {
    let raw = env::var("HOOK_SERVER_PORT").ok()?;
    raw.parse::<u16>().ok()
}

fn default_state_dir() -> PathBuf {
    if let Ok(value) = env::var("DISCODE_STATE_DIR") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }

    if let Ok(home) = env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".discode");
        }
    }

    if let Ok(profile) = env::var("USERPROFILE") {
        if !profile.trim().is_empty() {
            return PathBuf::from(profile).join(".discode");
        }
    }

    PathBuf::from(".discode")
}

fn pid_file(state_dir: &Path) -> PathBuf {
    state_dir.join("daemon.pid")
}

fn lock_file(state_dir: &Path) -> PathBuf {
    state_dir.join("daemon.lock")
}

fn resolve_log_file(opts: &CliOptions) -> PathBuf {
    opts.log_file
        .clone()
        .unwrap_or_else(|| opts.state_dir.join("daemon.log"))
}

fn command_start(opts: &CliOptions) -> Result<(), String> {
    fs::create_dir_all(&opts.state_dir)
        .map_err(|error| format!("Failed to create state directory: {error}"))?;

    if is_port_open(opts.port) {
        println!("Daemon already running (port {})", opts.port);
        return Ok(());
    }

    let log_path = resolve_log_file(opts);
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Failed to open log file {}: {error}", log_path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("Failed to clone log file handle: {error}"))?;

    let current_exe =
        env::current_exe().map_err(|error| format!("Failed to resolve current exe: {error}"))?;
    let mut run_args = vec![
        "run".to_string(),
        "--port".to_string(),
        opts.port.to_string(),
        "--state-dir".to_string(),
        opts.state_dir.to_string_lossy().to_string(),
    ];

    if let Some(log_file) = &opts.log_file {
        run_args.push("--log-file".to_string());
        run_args.push(log_file.to_string_lossy().to_string());
    }

    let mut command = if cfg!(target_os = "macos") && !opts.no_caffeinate {
        let mut cmd = Command::new("caffeinate");
        cmd.arg("-ims");
        cmd.arg(current_exe.as_os_str());
        for arg in &run_args {
            cmd.arg(arg);
        }
        cmd
    } else {
        let mut cmd = Command::new(&current_exe);
        for arg in &run_args {
            cmd.arg(arg);
        }
        cmd
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .env("HOOK_SERVER_PORT", opts.port.to_string());

    #[cfg(unix)]
    {
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn daemon process: {error}"))?;

    println!("Starting daemon (bootstrap pid {})...", child.id());

    if wait_for_port_state(opts.port, true, opts.timeout_ms) {
        println!("Daemon started (port {})", opts.port);
    } else {
        println!(
            "Daemon may not be ready. Check logs: {}",
            log_path.display()
        );
    }

    Ok(())
}

fn command_stop(opts: &CliOptions) -> Result<(), String> {
    let pid_path = pid_file(&opts.state_dir);
    let pid = match read_pid(&pid_path)? {
        Some(value) => value,
        None => {
            println!("Daemon was not running");
            return Ok(());
        }
    };

    if !terminate_process(pid) {
        let _ = fs::remove_file(&pid_path);
        return Err(format!("Failed to terminate daemon pid {pid}"));
    }

    let _ = wait_for_port_state(opts.port, false, opts.timeout_ms);
    let _ = fs::remove_file(&pid_path);
    println!("Daemon stopped");
    Ok(())
}

fn command_status(opts: &CliOptions) -> Result<(), String> {
    fs::create_dir_all(&opts.state_dir)
        .map_err(|error| format!("Failed to create state directory: {error}"))?;

    let running = is_port_open(opts.port);
    let log_path = resolve_log_file(opts);
    let pid_path = pid_file(&opts.state_dir);
    if running {
        println!("Daemon running (port {})", opts.port);
    } else {
        println!("Daemon not running");
    }
    println!("   Log: {}", log_path.display());
    println!("   PID: {}", pid_path.display());

    Ok(())
}

fn command_restart(opts: &CliOptions) -> Result<(), String> {
    let _ = command_stop(opts);
    command_start(opts)
}

fn command_run(opts: &CliOptions) -> Result<(), String> {
    fs::create_dir_all(&opts.state_dir)
        .map_err(|error| format!("Failed to create state directory: {error}"))?;

    // Load config/state using TS-compatible compatibility loaders.
    // Parsing failures are tolerated (empty/default objects), matching current TS behavior.
    let config_path = opts.state_dir.join(compat::CONFIG_FILE_NAME);
    let config = compat::CompatConfig::load(&config_path);
    let runtime_mode = config.runtime_mode();

    let auth_token = hook_server::read_hook_token(&opts.state_dir);
    let mut server = hook_server::HookServer::new_with_runtime(
        opts.state_dir.clone(),
        auth_token,
        runtime_mode == "pty-rust",
    );

    let mut runtime_stream = server.runtime_handle().and_then(|runtime| {
        let available = runtime
            .lock()
            .map(|mut guard| guard.is_available())
            .unwrap_or(false);
        if available {
            Some(runtime_stream::RuntimeStreamService::new(
                opts.state_dir.join("runtime.sock"),
                runtime,
            ))
        } else {
            None
        }
    });
    if let Some(service) = runtime_stream.as_mut() {
        service
            .start()
            .map_err(|error| format!("Failed to start runtime stream service: {error}"))?;
    }

    let lock_path = lock_file(&opts.state_dir);
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("Failed to open lock file {}: {error}", lock_path.display()))?;

    lock.try_lock_exclusive()
        .map_err(|_| format!("Another daemon instance holds lock {}", lock_path.display()))?;

    let listener = TcpListener::bind(("127.0.0.1", opts.port))
        .map_err(|error| format!("Failed to bind 127.0.0.1:{}: {error}", opts.port))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to configure listener: {error}"))?;

    let running = Arc::new(AtomicBool::new(true));
    let signal_flag = Arc::clone(&running);
    ctrlc::set_handler(move || {
        signal_flag.store(false, Ordering::SeqCst);
    })
    .map_err(|error| format!("Failed to register signal handler: {error}"))?;

    let pid_path = pid_file(&opts.state_dir);
    write_pid(&pid_path, process::id())?;

    println!("discode-daemon-rs listening on 127.0.0.1:{}", opts.port);

    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = server.handle_stream(stream);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                eprintln!("accept error: {error}");
                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    if let Some(service) = runtime_stream.as_mut() {
        service.stop();
    }

    let _ = fs::remove_file(&pid_path);
    drop(lock);
    Ok(())
}

fn is_port_open(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn wait_for_port_state(port: u16, should_be_open: bool, timeout_ms: u64) -> bool {
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(timeout_ms) {
        let open = is_port_open(port);
        if open == should_be_open {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn read_pid(path: &Path) -> Result<Option<i32>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read pid file {}: {error}", path.display()))?;
    let parsed = raw
        .trim()
        .parse::<i32>()
        .map_err(|_| format!("Invalid pid in {}: {}", path.display(), raw.trim()))?;
    Ok(Some(parsed))
}

fn write_pid(path: &Path, pid: u32) -> Result<(), String> {
    let mut file = File::create(path)
        .map_err(|error| format!("Failed to create pid file {}: {error}", path.display()))?;
    file.write_all(pid.to_string().as_bytes())
        .map_err(|error| format!("Failed to write pid file {}: {error}", path.display()))
}

#[cfg(unix)]
fn terminate_process(pid: i32) -> bool {
    if kill(Pid::from_raw(-pid), Signal::SIGTERM).is_ok() {
        return true;
    }
    kill(Pid::from_raw(pid), Signal::SIGTERM).is_ok()
}

#[cfg(not(unix))]
fn terminate_process(pid: i32) -> bool {
    Command::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_start_action() {
        let args = vec![
            "discode-daemon-rs".to_string(),
            "start".to_string(),
            "--port".to_string(),
            "19000".to_string(),
        ];
        let parsed = parse_args(&args).expect("parse should succeed");
        assert_eq!(parsed.action, Action::Start);
        assert_eq!(parsed.port, 19000);
    }

    #[test]
    fn rejects_unknown_action() {
        let args = vec!["discode-daemon-rs".to_string(), "launch".to_string()];
        assert!(parse_args(&args).is_err());
    }
}
