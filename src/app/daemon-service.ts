import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { arch as osArch, homedir, platform as osPlatform } from 'os';
import { resolve } from 'path';
import { defaultDaemonManager } from '../daemon.js';

export type DaemonBackend = 'ts' | 'rust';

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

const DEFAULT_DAEMON_BACKEND: DaemonBackend = 'ts';
const DAEMON_STATE_DIR = process.env.DISCODE_STATE_DIR || resolve(homedir(), '.discode');
const RUST_DAEMON_TIMEOUT_MS = 5000;

export type EnsureDaemonRunningResult = {
  alreadyRunning: boolean;
  ready: boolean;
  port: number;
  logFile: string;
  backend: DaemonBackend;
  fallbackFromRust?: boolean;
  fallbackReason?: string;
};

export async function ensureDaemonRunning(): Promise<EnsureDaemonRunningResult> {
  const preferredBackend = getConfiguredDaemonBackend();
  if (preferredBackend === 'rust') {
    const rustResult = ensureRustDaemonRunning();
    if (rustResult.ready) {
      return rustResult;
    }

    const tsFallback = await ensureTsDaemonRunning();
    return {
      ...tsFallback,
      fallbackFromRust: true,
      fallbackReason: rustResult.fallbackReason || 'Rust daemon unavailable',
    };
  }

  return ensureTsDaemonRunning();
}

export async function getDaemonStatus(): Promise<{
  running: boolean;
  port: number;
  logFile: string;
  pidFile: string;
  backend: DaemonBackend;
}> {
  const preferredBackend = getConfiguredDaemonBackend();
  const order: DaemonBackend[] = preferredBackend === 'rust' ? ['rust', 'ts'] : ['ts', 'rust'];
  const statusByBackend = {
    ts: await getTsDaemonStatus(),
    rust: getRustDaemonStatus(),
  };

  for (const backend of order) {
    const status = statusByBackend[backend];
    if (status.running) {
      return {
        ...status,
        backend,
      };
    }
  }

  const selected = statusByBackend[order[0]];
  return {
    ...selected,
    backend: order[0],
  };
}

export function stopDaemon(): boolean {
  const preferredBackend = getConfiguredDaemonBackend();
  const order: DaemonBackend[] = preferredBackend === 'rust' ? ['rust', 'ts'] : ['ts', 'rust'];

  for (const backend of order) {
    if (backend === 'rust') {
      if (stopRustDaemon()) return true;
      continue;
    }
    if (defaultDaemonManager.stopDaemon()) return true;
  }

  return false;
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

async function ensureTsDaemonRunning(): Promise<EnsureDaemonRunningResult> {
  const port = defaultDaemonManager.getPort();
  const logFile = defaultDaemonManager.getLogFile();
  const running = await defaultDaemonManager.isRunning();

  if (running) {
    return {
      alreadyRunning: true,
      ready: true,
      port,
      logFile,
      backend: 'ts',
    };
  }

  const repoHints = [process.env.DISCODE_REPO, process.cwd()].filter(
    (value): value is string => !!value && value.length > 0,
  );

  const entryPointCandidates = [
    ...repoHints.map((root) => resolve(root, 'dist/src/daemon-entry.js')),
    ...repoHints.map((root) => resolve(root, 'dist/daemon-entry.js')),
    resolve(import.meta.dirname, '../src/daemon-entry.js'),
    resolve(import.meta.dirname, '../daemon-entry.js'),
    ...repoHints.map((root) => resolve(root, 'src/daemon-entry.ts')),
    resolve(import.meta.dirname, '../daemon-entry.ts'),
    resolve(import.meta.dirname, '../src/daemon-entry.ts'),
  ];
  const entryPoint =
    entryPointCandidates.find((candidate) => existsSync(candidate)) ?? entryPointCandidates[0];
  defaultDaemonManager.startDaemon(entryPoint);
  const ready = await defaultDaemonManager.waitForReady();

  return {
    alreadyRunning: false,
    ready,
    port,
    logFile,
    backend: 'ts',
  };
}

async function getTsDaemonStatus(): Promise<{
  running: boolean;
  port: number;
  logFile: string;
  pidFile: string;
}> {
  const running = await defaultDaemonManager.isRunning();
  return {
    running,
    port: defaultDaemonManager.getPort(),
    logFile: defaultDaemonManager.getLogFile(),
    pidFile: defaultDaemonManager.getPidFile(),
  };
}

function ensureRustDaemonRunning(): EnsureDaemonRunningResult {
  const port = defaultDaemonManager.getPort();
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

function getRustDaemonStatus(): RustDaemonStatus & { port: number; pidFile: string } {
  const command = runRustDaemonCommand('status');
  const port = defaultDaemonManager.getPort();
  const defaults = {
    running: false,
    logFile: defaultDaemonManager.getLogFile(),
    pidFile: defaultDaemonManager.getPidFile(),
    port,
  };

  if (!command.ok) {
    return defaults;
  }

  const running = /Daemon running/i.test(command.stdout);
  const logFile = command.stdout.match(/^\s*Log:\s*(.+)$/m)?.[1]?.trim() || defaults.logFile;
  const pidFile = command.stdout.match(/^\s*PID:\s*(.+)$/m)?.[1]?.trim() || defaults.pidFile;

  return {
    running,
    logFile,
    pidFile,
    port,
  };
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

  const port = defaultDaemonManager.getPort();
  const result = spawnSync(
    binaryPath,
    [
      action,
      '--port',
      String(port),
      '--state-dir',
      DAEMON_STATE_DIR,
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
  if (!command.binaryPath) return 'Rust daemon binary not found';
  const details = [command.stderr, command.stdout]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' | ');
  if (!details) return 'Rust daemon start failed';
  return `Rust daemon start failed: ${details}`;
}

function getConfiguredDaemonBackend(): DaemonBackend {
  const raw = process.env.DISCODE_DAEMON_BACKEND?.trim().toLowerCase();
  if (raw === 'rust') return 'rust';
  return DEFAULT_DAEMON_BACKEND;
}

function resolveRustDaemonBinaryPath(): string | null {
  const binaryName = osPlatform() === 'win32' ? 'discode-daemon-rs.exe' : 'discode-daemon-rs';

  const archTag = mapArchTag(osArch());
  const platformTag = mapPlatformTag(osPlatform());
  const repoHints = [process.env.DISCODE_REPO, process.cwd()].filter(
    (value): value is string => !!value && value.length > 0,
  );

  const candidates = [
    process.env.DISCODE_DAEMON_RS_BIN,
    ...repoHints.map((root) => resolve(root, 'daemon-rs', 'target', 'release', binaryName)),
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
