import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { arch as osArch, homedir, platform as osPlatform } from 'os';
import { resolve } from 'path';

export type DaemonBackend = 'rust';

type RustDaemonStatus = {
  running: boolean;
  logFile: string;
  pidFile: string;
};

type RustCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  binaryPath: string | null;
};

const DEFAULT_DAEMON_BACKEND: DaemonBackend = 'rust';
const DEFAULT_DAEMON_PORT = 18470;
const RUST_DAEMON_TIMEOUT_MS = 5000;

function getDaemonStateDir(): string {
  return process.env.DISCODE_STATE_DIR || resolve(homedir(), '.discode');
}

export function getDaemonPort(): number {
  const raw = process.env.HOOK_SERVER_PORT?.trim();
  if (!raw) return DEFAULT_DAEMON_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_PORT;
}

export function getDaemonLogFilePath(): string {
  return resolve(getDaemonStateDir(), 'daemon.log');
}

export function getDaemonPidFilePath(): string {
  return resolve(getDaemonStateDir(), 'daemon.pid');
}

export type EnsureDaemonRunningResult = {
  alreadyRunning: boolean;
  ready: boolean;
  port: number;
  logFile: string;
  backend: DaemonBackend;
  fallbackReason?: string;
};

export async function ensureDaemonRunning(): Promise<EnsureDaemonRunningResult> {
  return ensureRustDaemonRunning();
}

export async function getDaemonStatus(): Promise<{
  running: boolean;
  port: number;
  logFile: string;
  pidFile: string;
  runtimeStreamProtocolVersion?: number;
  backend: DaemonBackend;
}> {
  const selected = getRustDaemonStatus();
  return {
    ...selected,
    backend: DEFAULT_DAEMON_BACKEND,
  };
}

export function stopDaemon(): boolean {
  return stopRustDaemon();
}

export async function restartDaemonIfRunning(): Promise<{
  restarted: boolean;
  ready: boolean;
  port: number;
  logFile: string;
  backend: DaemonBackend;
}> {
  const status = await getDaemonStatus();
  if (!status.running) {
    return {
      restarted: false,
      ready: false,
      port: status.port,
      logFile: status.logFile,
      backend: status.backend,
    };
  }

  const stopped = stopDaemon();
  if (!stopped) {
    return {
      restarted: false,
      ready: false,
      port: status.port,
      logFile: status.logFile,
      backend: status.backend,
    };
  }

  const result = await ensureDaemonRunning();
  return {
    restarted: true,
    ready: result.ready,
    port: result.port,
    logFile: result.logFile,
    backend: result.backend,
  };
}

function ensureRustDaemonRunning(): EnsureDaemonRunningResult {
  const port = getDaemonPort();
  const before = getRustDaemonStatus();
  if (before.running) {
    return {
      alreadyRunning: true,
      ready: true,
      port,
      logFile: before.logFile,
      backend: 'rust',
    };
  }

  const start = runRustDaemonCommand('start');
  if (!start.ok) {
    return {
      alreadyRunning: false,
      ready: false,
      port,
      logFile: before.logFile,
      backend: 'rust',
      fallbackReason: buildRustFallbackReason(start),
    };
  }

  const after = getRustDaemonStatus();
  return {
    alreadyRunning: false,
    ready: after.running,
    port,
    logFile: after.logFile,
    backend: 'rust',
    fallbackReason: after.running ? undefined : 'Rust daemon did not become ready',
  };
}

function getRustDaemonStatus(): RustDaemonStatus & {
  port: number;
  pidFile: string;
  runtimeStreamProtocolVersion?: number;
} {
  const command = runRustDaemonCommand('status');
  const port = getDaemonPort();
  const defaults = {
    running: false,
    logFile: getDaemonLogFilePath(),
    pidFile: getDaemonPidFilePath(),
    port,
  };

  if (!command.ok) {
    return defaults;
  }

  const running = /Daemon running/i.test(command.stdout);
  const logFile = command.stdout.match(/^\s*Log:\s*(.+)$/m)?.[1]?.trim() || defaults.logFile;
  const pidFile = command.stdout.match(/^\s*PID:\s*(.+)$/m)?.[1]?.trim() || defaults.pidFile;
  const parsedProtocolVersion = command.stdout.match(/^\s*Runtime Stream Protocol:\s*(\d+)\s*$/m)?.[1];
  const runtimeStreamProtocolVersion = parsedProtocolVersion
    ? Number.parseInt(parsedProtocolVersion, 10)
    : undefined;

  const result: RustDaemonStatus & { port: number; pidFile: string; runtimeStreamProtocolVersion?: number } = {
    running,
    logFile,
    pidFile,
    port,
  };
  if (Number.isFinite(runtimeStreamProtocolVersion)) {
    result.runtimeStreamProtocolVersion = runtimeStreamProtocolVersion;
  }
  return result;
}

function stopRustDaemon(): boolean {
  const command = runRustDaemonCommand('stop');
  if (!command.ok) return false;
  return /Daemon stopped/i.test(command.stdout);
}

function runRustDaemonCommand(action: 'start' | 'stop' | 'status' | 'restart'): RustCommandResult {
  const binaryPath = resolveRustDaemonBinaryPath();
  if (!binaryPath) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Rust daemon binary not found',
      binaryPath: null,
    };
  }

  const port = getDaemonPort();
  const stateDir = getDaemonStateDir();
  const result = spawnSync(
    binaryPath,
    [
      action,
      '--port',
      String(port),
      '--state-dir',
      stateDir,
      '--timeout-ms',
      String(RUST_DAEMON_TIMEOUT_MS),
    ],
    {
      encoding: 'utf-8',
      timeout: RUST_DAEMON_TIMEOUT_MS * 2,
      env: {
        ...process.env,
        HOOK_SERVER_PORT: String(port),
      },
    },
  );

  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
    binaryPath,
  };
}

function buildRustFallbackReason(command: RustCommandResult): string {
  if (!command.binaryPath) {
    return 'Rust daemon binary not found (set DISCODE_DAEMON_RS_BIN or build daemon-rs)';
  }
  const details = [command.stderr, command.stdout]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' | ');
  if (!details) return 'Rust daemon start failed';
  return `Rust daemon start failed: ${details}`;
}

function resolveRustDaemonBinaryPath(): string | null {
  const binaryName = osPlatform() === 'win32' ? 'discode-daemon-rs.exe' : 'discode-daemon-rs';

  const archTag = mapArchTag(osArch());
  const platformTag = mapPlatformTag(osPlatform());
  const rawHints = [
    process.env.DISCODE_REPO,
    process.cwd(),
    resolve(import.meta.dirname, '..', '..'),
    resolve(import.meta.dirname, '..', '..', '..'),
  ].filter((value): value is string => !!value && value.length > 0);
  const repoHints = [...new Set(rawHints.map((value) => resolve(value)))];

  const candidates = [
    process.env.DISCODE_DAEMON_RS_BIN,
    ...repoHints.map((root) => resolve(root, 'daemon-rs', 'target', 'release', binaryName)),
    ...repoHints.map((root) => resolve(root, 'daemon-rs', 'target', 'debug', binaryName)),
    ...(platformTag && archTag
      ? repoHints.map((root) =>
          resolve(
            root,
            'dist',
            'release',
            'daemon',
            `discode-daemon-rs-${platformTag}-${archTag}`,
            'bin',
            binaryName,
          ),
        )
      : []),
    ...(platformTag && archTag
      ? repoHints.map((root) =>
          resolve(
            root,
            'release',
            'daemon',
            `discode-daemon-rs-${platformTag}-${archTag}`,
            'bin',
            binaryName,
          ),
        )
      : []),
    resolve(homedir(), '.discode', 'bin', binaryName),
    ...(platformTag && archTag
      ? [resolve(homedir(), '.discode', 'bin', 'daemon', `${platformTag}-${archTag}`, binaryName)]
      : []),
  ].filter((value): value is string => !!value && value.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function mapPlatformTag(platform: string): 'darwin' | 'linux' | 'windows' | null {
  if (platform === 'darwin' || platform === 'linux') return platform;
  if (platform === 'win32') return 'windows';
  return null;
}

function mapArchTag(arch: string): 'x64' | 'arm64' | null {
  if (arch === 'x64' || arch === 'arm64') return arch;
  return null;
}
