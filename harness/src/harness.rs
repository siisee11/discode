use crate::cleanup;
use crate::cli::{CleanupAction, ObservabilityAction, QueryKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Clone, Debug)]
pub struct HarnessContext {
    repo_root: PathBuf,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Ports {
    pub base: u16,
    pub app_port: u16,
    pub vector_log_port: u16,
    pub vector_otlp_grpc_port: u16,
    pub vector_otlp_http_port: u16,
    pub vlogs_port: u16,
    pub vmetrics_port: u16,
    pub vtraces_port: u16,
    pub vector_api_port: u16,
}

#[derive(Debug, Deserialize, Serialize)]
struct AppMetadata {
    worktree_id: String,
    app: String,
    app_url: String,
    healthcheck_url: String,
    port: u16,
    pid: u32,
    runtime_root: String,
    log_file: String,
    browser_profile_dir: String,
    vite_cache_dir: String,
    tmp_dir: String,
    observability_enabled: i32,
    observability: ObservabilityEndpoints,
}

#[derive(Debug, Deserialize, Serialize)]
struct ObservabilityEndpoints {
    log_endpoint: Option<String>,
    otlp_http_endpoint: Option<String>,
    vector_api_endpoint: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ObservabilityMetadata {
    worktree_id: String,
    network: String,
    vector_log_port: u16,
    vector_otlp_grpc_port: u16,
    vector_otlp_http_port: u16,
    vector_api_port: u16,
    vlogs_port: u16,
    vmetrics_port: u16,
    vtraces_port: u16,
    log_endpoint: String,
    otlp_endpoint: String,
    vector_health: String,
    vlogs_query: String,
    vmetrics_query: String,
    vtraces_query: String,
}

#[derive(Debug, Deserialize)]
struct PackageJson {
    scripts: Option<HashMap<String, String>>,
}

impl HarnessContext {
    pub fn discover() -> Result<Self, String> {
        let current_dir = std::env::current_dir()
            .map_err(|error| format!("Failed to read current directory: {error}"))?;
        if let Some(repo_root) = find_repo_root(&current_dir) {
            return Ok(Self { repo_root });
        }

        let executable = std::env::current_exe()
            .map_err(|error| format!("Failed to resolve harnesscli path: {error}"))?;
        if let Some(repo_root) = find_repo_root(&executable) {
            return Ok(Self { repo_root });
        }

        Err("Unable to locate repository root for harnesscli.".to_string())
    }

    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    pub fn worktree_id(&self) -> Result<String, String> {
        if let Ok(value) = std::env::var("DISCODE_WORKTREE_ID") {
            if !value.trim().is_empty() {
                return Ok(value);
            }
        }

        let root = self.repo_root();
        let slug = slugify(
            root.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("worktree"),
        );
        let hash = cksum_string(root.to_string_lossy().as_ref())?;
        Ok(format!(
            "{}-{}",
            if slug.is_empty() { "worktree" } else { &slug },
            hash
        ))
    }

    pub fn runtime_root(&self) -> Result<PathBuf, String> {
        Ok(self.repo_root.join(".worktree").join(self.worktree_id()?))
    }

    pub fn logs_dir(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_root()?.join("logs"))
    }

    pub fn tmp_dir(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_root()?.join("tmp"))
    }

    pub fn browser_profile_dir(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_root()?.join("browser-profile"))
    }

    pub fn vite_cache_dir(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_root()?.join("vite-cache"))
    }

    pub fn observability_dir(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_root()?.join("observability"))
    }

    pub fn ports_file(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_root()?.join("ports.env"))
    }

    pub fn app_pid_file(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_root()?.join("app.pid"))
    }

    pub fn app_log_file(&self) -> Result<PathBuf, String> {
        Ok(self.logs_dir()?.join("app.log"))
    }

    pub fn app_metadata_file(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_root()?.join("app.json"))
    }

    pub fn observability_metadata_file(&self) -> Result<PathBuf, String> {
        Ok(self.observability_dir()?.join("metadata.json"))
    }

    pub fn generated_vector_config(&self) -> Result<PathBuf, String> {
        Ok(self.observability_dir()?.join("vector.generated.toml"))
    }

    pub fn ensure_runtime_dirs(&self) -> Result<(), String> {
        create_dir(self.runtime_root()?)?;
        create_dir(self.logs_dir()?)?;
        create_dir(self.tmp_dir()?)?;
        create_dir(self.browser_profile_dir()?)?;
        create_dir(self.vite_cache_dir()?)?;
        create_dir(self.observability_dir()?)?;
        Ok(())
    }

    pub fn load_ports(&self) -> Result<Option<Ports>, String> {
        let path = self.ports_file()?;
        if !path.is_file() {
            return Ok(None);
        }

        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        let mut values = HashMap::new();
        for line in content.lines() {
            if let Some((key, value)) = line.split_once('=') {
                values.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
        parse_ports_map(&values).map(Some)
    }

    pub fn write_ports(&self, ports: Ports) -> Result<(), String> {
        let path = self.ports_file()?;
        if let Some(parent) = path.parent() {
            create_dir(parent.to_path_buf())?;
        }
        let content = format!(
            "DISCODE_PORT_BASE={}\nDISCODE_APP_PORT={}\nDISCODE_VECTOR_LOG_PORT={}\nDISCODE_VECTOR_OTLP_GRPC_PORT={}\nDISCODE_VECTOR_OTLP_HTTP_PORT={}\nDISCODE_VLOGS_PORT={}\nDISCODE_VMETRICS_PORT={}\nDISCODE_VTRACES_PORT={}\nDISCODE_VECTOR_API_PORT={}\n",
            ports.base,
            ports.app_port,
            ports.vector_log_port,
            ports.vector_otlp_grpc_port,
            ports.vector_otlp_http_port,
            ports.vlogs_port,
            ports.vmetrics_port,
            ports.vtraces_port,
            ports.vector_api_port
        );
        fs::write(&path, content)
            .map_err(|error| format!("Failed to write {}: {error}", path.display()))
    }

    pub fn resolve_ports(&self, required_offsets: &[u16]) -> Result<Ports, String> {
        if let Ok(base) = std::env::var("DISCODE_PORT_BASE") {
            if let Ok(base) = base.parse::<u16>() {
                return Ok(ports_from_base(base));
            }
        }

        if let Some(ports) = self.load_ports()? {
            return Ok(ports);
        }

        let seed = cksum_string(&self.worktree_id()?)?;
        for attempt in 0..50u16 {
            let base = 42000 + (((seed % 400) as u16 + attempt) * 20);
            if required_offsets
                .iter()
                .all(|offset| port_is_available(base.saturating_add(*offset)))
            {
                return Ok(ports_from_base(base));
            }
        }

        Err(format!(
            "Unable to allocate a free port block for worktree {}.",
            self.worktree_id()?
        ))
    }
}

pub fn boot(context: &HarnessContext) -> Result<i32, String> {
    context.ensure_runtime_dirs()?;
    let ports = context.resolve_ports(&[0, 1, 2, 3, 4, 5, 6, 7])?;
    context.write_ports(ports)?;

    let metadata_path = context.app_metadata_file()?;
    let pid_path = context.app_pid_file()?;
    let log_file = context.app_log_file()?;
    let runtime_root = context.runtime_root()?;
    let browser_profile_dir = context.browser_profile_dir()?;
    let vite_cache_dir = context.vite_cache_dir()?;
    let tmp_dir = context.tmp_dir()?;
    let app_host = std::env::var("DISCODE_APP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let worktree_id = context.worktree_id()?;
    let app_url = format!("http://{}:{}/", app_host, ports.app_port);
    let healthcheck_url = format!("{app_url}__harness/health");

    if let Some(existing_pid) = read_pid(&pid_path)? {
        if pid_is_running(existing_pid)
            && metadata_path.is_file()
            && wait_for_http_body_fragment(&healthcheck_url, "\"ok\":true", Duration::from_secs(2))
        {
            print_file(&metadata_path)?;
            return Ok(0);
        }
        remove_if_exists(&pid_path)?;
    }

    if observability_enabled() {
        start_observability(context, false)?;
    }

    let mut command = Command::new("node");
    command.arg(context.repo_root().join("scripts/harness/dev-server.mjs"));
    command.current_dir(context.repo_root());
    command.stdin(Stdio::null());
    command.stdout(Stdio::from(open_log(&log_file)?));
    command.stderr(Stdio::from(open_log(&log_file)?));
    command.env("DISCODE_WORKTREE_ID", &worktree_id);
    command.env("DISCODE_APP_HOST", &app_host);
    command.env("DISCODE_APP_PORT", ports.app_port.to_string());
    command.env("DISCODE_VITE_CACHE_DIR", &vite_cache_dir);
    command.env("DISCODE_BOOT_STARTED_AT", utc_timestamp()?);
    command.env("TMPDIR", &tmp_dir);
    if observability_enabled() {
        command.env(
            "LOG_ENDPOINT",
            format!("http://127.0.0.1:{}/logs", ports.vector_log_port),
        );
        command.env(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            format!("http://127.0.0.1:{}", ports.vector_otlp_http_port),
        );
    }

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start harness dev server: {error}"))?;
    let app_pid = child.id();
    fs::write(&pid_path, format!("{app_pid}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", pid_path.display()))?;
    detach_child(child);

    let timeout = std::env::var("DISCODE_APP_BOOT_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30);
    if !wait_for_http_body_fragment(
        &healthcheck_url,
        "\"ok\":true",
        Duration::from_secs(timeout),
    ) {
        kill_pid(app_pid)?;
        remove_if_exists(&pid_path)?;
        let mut message = format!(
            "Worktree app failed to become ready. Inspect {}",
            log_file.display()
        );
        if let Ok(log_contents) = fs::read_to_string(&log_file) {
            if log_contents.contains("listen EPERM")
                || log_contents.contains("operation not permitted")
            {
                message.push_str(
                    ". The local runtime could not bind the configured port. In restricted sandboxes, rerun harnesscli boot with permission to open local listening sockets.",
                );
            }
        }
        return Err(message);
    }

    let metadata = AppMetadata {
        worktree_id,
        app: "discode-site-dev".to_string(),
        app_url,
        healthcheck_url,
        port: ports.app_port,
        pid: app_pid,
        runtime_root: runtime_root.display().to_string(),
        log_file: log_file.display().to_string(),
        browser_profile_dir: browser_profile_dir.display().to_string(),
        vite_cache_dir: vite_cache_dir.display().to_string(),
        tmp_dir: tmp_dir.display().to_string(),
        observability_enabled: if observability_enabled() { 1 } else { 0 },
        observability: if observability_enabled() {
            ObservabilityEndpoints {
                log_endpoint: Some(format!("http://127.0.0.1:{}/logs", ports.vector_log_port)),
                otlp_http_endpoint: Some(format!(
                    "http://127.0.0.1:{}",
                    ports.vector_otlp_http_port
                )),
                vector_api_endpoint: Some(format!(
                    "http://127.0.0.1:{}/health",
                    ports.vector_api_port
                )),
            }
        } else {
            ObservabilityEndpoints {
                log_endpoint: None,
                otlp_http_endpoint: None,
                vector_api_endpoint: None,
            }
        },
    };
    write_json(&metadata_path, &metadata)?;
    print_json(&metadata)?;
    Ok(0)
}

pub fn stop(context: &HarnessContext) -> Result<i32, String> {
    let pid_path = context.app_pid_file()?;
    let metadata_path = context.app_metadata_file()?;
    if let Some(pid) = read_pid(&pid_path)? {
        if pid_is_running(pid) {
            kill_pid(pid)?;
        }
        remove_if_exists(&pid_path)?;
    }
    remove_if_exists(&metadata_path)?;

    if observability_enabled() {
        stop_observability(context, false)?;
    }

    Ok(0)
}

pub fn example(context: &HarnessContext) -> Result<i32, String> {
    let metadata_path = context.app_metadata_file()?;
    if !metadata_path.is_file() {
        return Err(
            "No running harness app metadata found. Start the app with harnesscli boot first."
                .to_string(),
        );
    }
    let metadata: AppMetadata = read_json(&metadata_path)?;

    println!(
        "Worktree app is ready.\n\n1. Healthcheck\n   curl -fsS \"{}\"\n\n2. Agent-browser validation prompt\n   Open {}\n   Wait until the page heading \"Your ultimate IDE is a messenger.\" is visible\n   Capture a DOM snapshot\n   Capture a screenshot of the hero and install-command card\n   Click the \"npm\" install tab and verify the command becomes \"npm install -g @siisee11/discode\"\n   Change the language selector to Korean and verify the hero text updates\n\n3. Verification target\n   Worktree: {}",
        metadata.healthcheck_url,
        metadata.app_url,
        metadata.worktree_id
    );
    Ok(0)
}

pub fn smoke(context: &HarnessContext) -> Result<i32, String> {
    if let Ok(command) = std::env::var("HARNESS_SMOKE_CMD") {
        return run_override_shell(&command);
    }
    run_steps(&[Step::new("npm", &["run", "build"])], context.repo_root())
}

pub fn test(context: &HarnessContext) -> Result<i32, String> {
    if let Ok(command) = std::env::var("HARNESS_TEST_CMD") {
        return run_override_shell(&command);
    }

    run_steps(
        &[
            Step::new("npm", &["run", "test"]),
            Step::new(
                "cargo",
                &["test", "--manifest-path", "sidecar/pty-rust/Cargo.toml"],
            ),
            Step::new("npm", &["run", "daemon-rs:test"]),
            Step::new("npm", &["run", "runtime-client:test"]),
        ],
        context.repo_root(),
    )
}

pub fn lint(context: &HarnessContext) -> Result<i32, String> {
    if let Ok(command) = std::env::var("HARNESS_LINT_CMD") {
        return run_override_shell(&command);
    }

    run_steps(
        &[
            Step::new("node", &["scripts/linters/architecture-lint.mjs"]),
            Step::new("node", &["scripts/linters/boundary-lint.mjs"]),
            Step::new("node", &["scripts/linters/taste-lint.mjs"]),
        ],
        context.repo_root(),
    )?;

    let cleanup_exit = cleanup::run(
        context,
        CleanupAction::Scan {
            fail_on_error: true,
        },
    )?;
    if cleanup_exit != 0 {
        return Ok(cleanup_exit);
    }

    if package_has_lint_script(context.repo_root())? {
        run_steps(&[Step::new("npm", &["run", "lint"])], context.repo_root())
    } else {
        println!("No package.json lint script found; using repository static analysis fallback.");
        run_steps(
            &[
                Step::new("npm", &["run", "typecheck"]),
                Step::new(
                    "cargo",
                    &[
                        "fmt",
                        "--manifest-path",
                        "sidecar/pty-rust/Cargo.toml",
                        "--all",
                        "--",
                        "--check",
                    ],
                ),
                Step::new(
                    "cargo",
                    &[
                        "fmt",
                        "--manifest-path",
                        "daemon-rs/Cargo.toml",
                        "--all",
                        "--",
                        "--check",
                    ],
                ),
                Step::new(
                    "cargo",
                    &[
                        "fmt",
                        "--manifest-path",
                        "runtime-client-rs/Cargo.toml",
                        "--all",
                        "--",
                        "--check",
                    ],
                ),
            ],
            context.repo_root(),
        )
    }
}

pub fn typecheck(context: &HarnessContext) -> Result<i32, String> {
    if let Ok(command) = std::env::var("HARNESS_TYPECHECK_CMD") {
        return run_override_shell(&command);
    }

    run_steps(
        &[
            Step::new("npm", &["run", "typecheck"]),
            Step::new(
                "cargo",
                &["check", "--manifest-path", "sidecar/pty-rust/Cargo.toml"],
            ),
            Step::new(
                "cargo",
                &["check", "--manifest-path", "daemon-rs/Cargo.toml"],
            ),
            Step::new(
                "cargo",
                &["check", "--manifest-path", "runtime-client-rs/Cargo.toml"],
            ),
        ],
        context.repo_root(),
    )
}

pub fn audit(_context: &HarnessContext, target: &Path) -> Result<i32, String> {
    let audit_root = if target.is_absolute() {
        target.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Failed to read current directory: {error}"))?
            .join(target)
    };

    let required_files = [
        "AGENTS.md",
        "ARCHITECTURE.md",
        "docs/PLANS.md",
        "docs/OBSERVABILITY.md",
        "docs/design-docs/index.md",
        "docs/exec-plans/tech-debt-tracker.md",
        "docs/product-specs/index.md",
        "Makefile.harness",
        "harness/Cargo.toml",
        "harness/src/main.rs",
        ".github/workflows/harness.yml",
    ];
    let required_dirs = [
        "docs/design-docs",
        "docs/exec-plans/active",
        "docs/exec-plans/completed",
        "docs/product-specs",
        "docs/references",
        "docs/generated",
        "harness/src",
    ];

    let mut failures = 0usize;

    for file in required_files {
        if audit_root.join(file).is_file() {
            println!("[ok] {file} exists");
        } else {
            println!("[missing] {file} exists");
            failures += 1;
        }
    }

    for dir in required_dirs {
        if audit_root.join(dir).is_dir() {
            println!("[ok] {dir}/ exists");
        } else {
            println!("[missing] {dir}/ exists");
            failures += 1;
        }
    }

    let makefile_path = audit_root.join("Makefile");
    if !makefile_path.is_file() {
        println!("[missing] Makefile exists");
        failures += 1;
    } else {
        let makefile = fs::read_to_string(&makefile_path)
            .map_err(|error| format!("Failed to read {}: {error}", makefile_path.display()))?;
        if makefile.contains("-include Makefile.harness") {
            println!("[ok] Makefile includes Makefile.harness");
        } else {
            println!("[missing] Makefile includes Makefile.harness");
            failures += 1;
        }
    }

    if failures > 0 {
        println!("{failures} harness audit check(s) failed.");
        return Ok(1);
    }

    println!("Harness audit passed.");
    Ok(0)
}

pub fn run_observability(
    context: &HarnessContext,
    action: ObservabilityAction,
) -> Result<i32, String> {
    match action {
        ObservabilityAction::Start => start_observability(context, true),
        ObservabilityAction::Stop => stop_observability(context, true),
        ObservabilityAction::Query { kind, query } => query_observability(context, kind, &query),
    }
}

fn start_observability(context: &HarnessContext, print_output: bool) -> Result<i32, String> {
    ensure_command(
        "docker",
        &["--version"],
        "Docker is required for the local observability stack.",
    )?;
    let status = Command::new("docker")
        .arg("info")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Failed to run docker info: {error}"))?;
    if !status.success() {
        return Err("Docker is installed but the daemon is not reachable.".to_string());
    }

    context.ensure_runtime_dirs()?;
    let ports = context.resolve_ports(&[0, 1, 2, 3, 4, 5, 6, 7])?;
    context.write_ports(ports)?;

    let worktree_id = context.worktree_id()?;
    let obs_dir = context.observability_dir()?;
    create_dir(obs_dir.join("vector"))?;
    create_dir(obs_dir.join("victoria-logs"))?;
    create_dir(obs_dir.join("victoria-metrics"))?;
    create_dir(obs_dir.join("victoria-traces"))?;

    let metadata_path = context.observability_metadata_file()?;
    let config_path = context.generated_vector_config()?;
    let template_path = context
        .repo_root()
        .join("scripts/observability/vector.toml");
    let template = fs::read_to_string(&template_path)
        .map_err(|error| format!("Failed to read {}: {error}", template_path.display()))?;

    let network_name = format!("discode-harness-{worktree_id}");
    let vlogs_container = format!("discode-vlogs-{worktree_id}");
    let vmetrics_container = format!("discode-vmetrics-{worktree_id}");
    let vtraces_container = format!("discode-vtraces-{worktree_id}");
    let vector_container = format!("discode-vector-{worktree_id}");

    let generated = template
        .replace("__VECTOR_API_PORT__", &ports.vector_api_port.to_string())
        .replace("__VECTOR_LOG_PORT__", &ports.vector_log_port.to_string())
        .replace(
            "__VECTOR_OTLP_GRPC_PORT__",
            &ports.vector_otlp_grpc_port.to_string(),
        )
        .replace(
            "__VECTOR_OTLP_HTTP_PORT__",
            &ports.vector_otlp_http_port.to_string(),
        )
        .replace("__VLOGS_CONTAINER__", &vlogs_container)
        .replace("__VMETRICS_CONTAINER__", &vmetrics_container)
        .replace("__VTRACES_CONTAINER__", &vtraces_container);
    fs::write(&config_path, generated)
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;

    let inspect_status = Command::new("docker")
        .args(["network", "inspect", &network_name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Failed to inspect docker network: {error}"))?;
    if !inspect_status.success() {
        run_step(
            Step::new("docker", &["network", "create", &network_name]),
            context.repo_root(),
            false,
        )?;
    }

    for container in [
        vector_container.as_str(),
        vlogs_container.as_str(),
        vmetrics_container.as_str(),
        vtraces_container.as_str(),
    ] {
        let _ = run_step(
            Step::new("docker", &["rm", "-f", container]),
            context.repo_root(),
            false,
        );
    }

    let vlogs_image = std::env::var("DISCODE_VLOGS_IMAGE")
        .unwrap_or_else(|_| "victoriametrics/victoria-logs:latest".to_string());
    let vmetrics_image = std::env::var("DISCODE_VMETRICS_IMAGE")
        .unwrap_or_else(|_| "victoriametrics/victoria-metrics:latest".to_string());
    let vtraces_image = std::env::var("DISCODE_VTRACES_IMAGE")
        .unwrap_or_else(|_| "victoriametrics/victoria-traces:latest".to_string());
    let vector_image = std::env::var("DISCODE_VECTOR_IMAGE")
        .unwrap_or_else(|_| "timberio/vector:latest-alpine".to_string());

    run_step(
        Step::new(
            "docker",
            &[
                "run",
                "-d",
                "--rm",
                "--name",
                &vlogs_container,
                "--network",
                &network_name,
                "-p",
                &format!("{}:9428", ports.vlogs_port),
                "-v",
                &format!(
                    "{}:/victoria-logs-data",
                    obs_dir.join("victoria-logs").display()
                ),
                &vlogs_image,
                "-storageDataPath=/victoria-logs-data",
            ],
        ),
        context.repo_root(),
        false,
    )?;

    run_step(
        Step::new(
            "docker",
            &[
                "run",
                "-d",
                "--rm",
                "--name",
                &vmetrics_container,
                "--network",
                &network_name,
                "-p",
                &format!("{}:8428", ports.vmetrics_port),
                "-v",
                &format!(
                    "{}:/victoria-metrics-data",
                    obs_dir.join("victoria-metrics").display()
                ),
                &vmetrics_image,
                "-storageDataPath=/victoria-metrics-data",
            ],
        ),
        context.repo_root(),
        false,
    )?;

    run_step(
        Step::new(
            "docker",
            &[
                "run",
                "-d",
                "--rm",
                "--name",
                &vtraces_container,
                "--network",
                &network_name,
                "-p",
                &format!("{}:10428", ports.vtraces_port),
                "-v",
                &format!(
                    "{}:/victoria-traces-data",
                    obs_dir.join("victoria-traces").display()
                ),
                &vtraces_image,
                "-storageDataPath=/victoria-traces-data",
            ],
        ),
        context.repo_root(),
        false,
    )?;

    run_step(
        Step::new(
            "docker",
            &[
                "run",
                "-d",
                "--rm",
                "--name",
                &vector_container,
                "--network",
                &network_name,
                "-p",
                &format!("{}:{}", ports.vector_log_port, ports.vector_log_port),
                "-p",
                &format!(
                    "{}:{}",
                    ports.vector_otlp_grpc_port, ports.vector_otlp_grpc_port
                ),
                "-p",
                &format!(
                    "{}:{}",
                    ports.vector_otlp_http_port, ports.vector_otlp_http_port
                ),
                "-p",
                &format!("{}:{}", ports.vector_api_port, ports.vector_api_port),
                "-v",
                &format!("{}:/etc/vector/vector.toml:ro", config_path.display()),
                "-v",
                &format!("{}:/var/lib/vector", obs_dir.join("vector").display()),
                &vector_image,
                "--config",
                "/etc/vector/vector.toml",
            ],
        ),
        context.repo_root(),
        false,
    )?;

    wait_for_http_ok(
        &format!("http://127.0.0.1:{}/metrics", ports.vlogs_port),
        Duration::from_secs(30),
    )?;
    wait_for_http_ok(
        &format!("http://127.0.0.1:{}/metrics", ports.vmetrics_port),
        Duration::from_secs(30),
    )?;
    wait_for_http_ok(
        &format!("http://127.0.0.1:{}/metrics", ports.vtraces_port),
        Duration::from_secs(30),
    )?;
    wait_for_http_ok(
        &format!("http://127.0.0.1:{}/health", ports.vector_api_port),
        Duration::from_secs(30),
    )?;

    let metadata = ObservabilityMetadata {
        worktree_id,
        network: network_name,
        vector_log_port: ports.vector_log_port,
        vector_otlp_grpc_port: ports.vector_otlp_grpc_port,
        vector_otlp_http_port: ports.vector_otlp_http_port,
        vector_api_port: ports.vector_api_port,
        vlogs_port: ports.vlogs_port,
        vmetrics_port: ports.vmetrics_port,
        vtraces_port: ports.vtraces_port,
        log_endpoint: format!("http://127.0.0.1:{}/logs", ports.vector_log_port),
        otlp_endpoint: format!("http://127.0.0.1:{}", ports.vector_otlp_http_port),
        vector_health: format!("http://127.0.0.1:{}/health", ports.vector_api_port),
        vlogs_query: format!("http://127.0.0.1:{}/select/logsql/query", ports.vlogs_port),
        vmetrics_query: format!("http://127.0.0.1:{}/api/v1/query", ports.vmetrics_port),
        vtraces_query: format!(
            "http://127.0.0.1:{}/select/logsql/query",
            ports.vtraces_port
        ),
    };
    write_json(&metadata_path, &metadata)?;
    if print_output {
        print_json(&metadata)?;
    }
    Ok(0)
}

fn stop_observability(context: &HarnessContext, _print_output: bool) -> Result<i32, String> {
    let worktree_id = context.worktree_id()?;
    let obs_dir = context.observability_dir()?;
    let network_name = format!("discode-harness-{worktree_id}");
    for container in [
        format!("discode-vector-{worktree_id}"),
        format!("discode-vlogs-{worktree_id}"),
        format!("discode-vmetrics-{worktree_id}"),
        format!("discode-vtraces-{worktree_id}"),
    ] {
        let _ = run_step(
            Step::new("docker", &["rm", "-f", &container]),
            context.repo_root(),
            false,
        );
    }
    let _ = run_step(
        Step::new("docker", &["network", "rm", &network_name]),
        context.repo_root(),
        false,
    );
    remove_if_exists(&context.observability_metadata_file()?)?;
    remove_if_exists(&context.generated_vector_config()?)?;

    if std::env::var("DISCODE_OBSERVABILITY_CLEAN").ok().as_deref() == Some("1") {
        remove_dir_if_exists(obs_dir.join("vector"))?;
        remove_dir_if_exists(obs_dir.join("victoria-logs"))?;
        remove_dir_if_exists(obs_dir.join("victoria-metrics"))?;
        remove_dir_if_exists(obs_dir.join("victoria-traces"))?;
    }

    Ok(0)
}

fn query_observability(
    context: &HarnessContext,
    kind: QueryKind,
    query: &str,
) -> Result<i32, String> {
    let Some(ports) = context.load_ports()? else {
        return Err(
            "No worktree ports metadata found. Start the harness or observability stack first."
                .to_string(),
        );
    };

    let response = match kind {
        QueryKind::Logs => ureq::post(&format!(
            "http://127.0.0.1:{}/select/logsql/query",
            ports.vlogs_port
        ))
        .send_form(&[("query", query)])
        .map_err(map_http_error)?,
        QueryKind::Metrics => ureq::get(&format!(
            "http://127.0.0.1:{}/api/v1/query",
            ports.vmetrics_port
        ))
        .query("query", query)
        .call()
        .map_err(map_http_error)?,
        QueryKind::Traces => ureq::post(&format!(
            "http://127.0.0.1:{}/select/logsql/query",
            ports.vtraces_port
        ))
        .send_form(&[("query", query)])
        .map_err(map_http_error)?,
    };

    let text = response
        .into_string()
        .map_err(|error| format!("Failed to read observability query response: {error}"))?;
    print!("{text}");
    if !text.ends_with('\n') {
        println!();
    }
    Ok(0)
}

fn package_has_lint_script(repo_root: &Path) -> Result<bool, String> {
    let package_path = repo_root.join("package.json");
    let package: PackageJson = read_json(&package_path)?;
    Ok(package
        .scripts
        .map(|scripts| scripts.contains_key("lint"))
        .unwrap_or(false))
}

#[derive(Clone, Copy)]
struct Step<'a> {
    program: &'a str,
    args: &'a [&'a str],
}

impl<'a> Step<'a> {
    const fn new(program: &'a str, args: &'a [&'a str]) -> Self {
        Self { program, args }
    }
}

fn run_steps(steps: &[Step<'_>], repo_root: &Path) -> Result<i32, String> {
    for step in steps {
        run_step(*step, repo_root, true)?;
    }
    Ok(0)
}

fn run_step(step: Step<'_>, repo_root: &Path, echo: bool) -> Result<(), String> {
    if echo {
        println!("+ {} {}", step.program, step.args.join(" "));
    }
    let mut command = Command::new(step.program);
    command.args(step.args).current_dir(repo_root);
    if !echo {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    let status = command
        .status()
        .map_err(|error| format!("Failed to run {}: {error}", step.program))?;
    if !status.success() {
        return Err(format!(
            "Command failed with exit code {}: {} {}",
            status.code().unwrap_or(1),
            step.program,
            step.args.join(" ")
        ));
    }
    Ok(())
}

fn run_override_shell(command: &str) -> Result<i32, String> {
    println!("+ {command}");
    let status = Command::new("bash")
        .args(["-lc", command])
        .status()
        .map_err(|error| format!("Failed to run override command: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn observability_enabled() -> bool {
    std::env::var("DISCODE_OBSERVABILITY").ok().as_deref() == Some("1")
}

fn ensure_command(program: &str, args: &[&str], message: &str) -> Result<(), String> {
    match Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(_) => Ok(()),
        Err(_) => Err(message.to_string()),
    }
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut current = if start.is_dir() {
        Some(start)
    } else {
        start.parent()
    };

    while let Some(path) = current {
        if path.join("package.json").is_file()
            && path.join("AGENTS.md").is_file()
            && path.join("scripts").is_dir()
        {
            return Some(path.to_path_buf());
        }
        current = path.parent();
    }

    None
}

fn slugify(input: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in input.chars() {
        let lower = character.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            output.push(lower);
            previous_dash = false;
        } else if !previous_dash && !output.is_empty() {
            output.push('-');
            previous_dash = true;
        }
    }
    output.trim_matches('-').to_string()
}

fn cksum_string(input: &str) -> Result<u32, String> {
    let output = Command::new("cksum")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(stdin) = &mut child.stdin {
                stdin.write_all(input.as_bytes())?;
            }
            child.wait_with_output()
        })
        .map_err(|error| format!("Failed to run cksum: {error}"))?;
    if !output.status.success() {
        return Err("cksum failed".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value = stdout
        .split_whitespace()
        .next()
        .ok_or_else(|| "cksum returned no hash".to_string())?
        .parse::<u32>()
        .map_err(|error| format!("Failed to parse cksum output: {error}"))?;
    Ok(value)
}

fn create_dir(path: PathBuf) -> Result<(), String> {
    fs::create_dir_all(&path)
        .map_err(|error| format!("Failed to create {}: {error}", path.display()))
}

fn port_is_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn parse_ports_map(values: &HashMap<String, String>) -> Result<Ports, String> {
    let parse = |key: &str| -> Result<u16, String> {
        values
            .get(key)
            .ok_or_else(|| format!("Missing {key} in ports.env"))?
            .parse::<u16>()
            .map_err(|error| format!("Invalid {key} in ports.env: {error}"))
    };

    Ok(Ports {
        base: parse("DISCODE_PORT_BASE")?,
        app_port: parse("DISCODE_APP_PORT")?,
        vector_log_port: parse("DISCODE_VECTOR_LOG_PORT")?,
        vector_otlp_grpc_port: parse("DISCODE_VECTOR_OTLP_GRPC_PORT")?,
        vector_otlp_http_port: parse("DISCODE_VECTOR_OTLP_HTTP_PORT")?,
        vlogs_port: parse("DISCODE_VLOGS_PORT")?,
        vmetrics_port: parse("DISCODE_VMETRICS_PORT")?,
        vtraces_port: parse("DISCODE_VTRACES_PORT")?,
        vector_api_port: parse("DISCODE_VECTOR_API_PORT")?,
    })
}

fn ports_from_base(base: u16) -> Ports {
    Ports {
        base,
        app_port: base,
        vector_log_port: base + 1,
        vector_otlp_grpc_port: base + 2,
        vector_otlp_http_port: base + 3,
        vlogs_port: base + 4,
        vmetrics_port: base + 5,
        vtraces_port: base + 6,
        vector_api_port: base + 7,
    }
}

fn read_pid(path: &Path) -> Result<Option<u32>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let pid = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?
        .trim()
        .parse::<u32>()
        .map_err(|error| format!("Invalid pid in {}: {error}", path.display()))?;
    Ok(Some(pid))
}

fn pid_is_running(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn kill_pid(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .arg(pid.to_string())
        .status()
        .map_err(|error| format!("Failed to stop pid {pid}: {error}"))?;
    if !status.success() {
        return Err(format!("Failed to stop pid {pid}."));
    }
    Ok(())
}

fn wait_for_http_ok(url: &str, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        match ureq::get(url).call() {
            Ok(response) if response.status() < 400 => return Ok(()),
            _ => thread::sleep(Duration::from_millis(200)),
        }
    }
    Err(format!("Timed out waiting for {url}"))
}

fn wait_for_http_body_fragment(url: &str, fragment: &str, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        let response = ureq::get(url).call();
        if let Ok(response) = response {
            if let Ok(body) = response.into_string() {
                if body.contains(fragment) {
                    return true;
                }
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize JSON for {}: {error}", path.display()))?;
    fs::write(path, format!("{json}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse JSON from {}: {error}", path.display()))
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize JSON: {error}"))?;
    println!("{json}");
    Ok(())
}

fn print_file(path: &Path) -> Result<(), String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    print!("{content}");
    if !content.ends_with('\n') {
        println!();
    }
    Ok(())
}

fn open_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))
}

fn detach_child(_child: Child) {}

fn utc_timestamp() -> Result<String, String> {
    OffsetDateTime::from(SystemTime::now())
        .format(&Rfc3339)
        .map_err(|error| format!("Failed to format UTC timestamp: {error}"))
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }
}

fn remove_dir_if_exists(path: PathBuf) -> Result<(), String> {
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }
}

fn map_http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => format!(
            "Observability query failed with status {}: {}",
            status,
            response.status_text()
        ),
        ureq::Error::Transport(transport) => format!("Observability query failed: {transport}"),
    }
}
