/**
 * Unit tests for daemon-service module.
 *
 * Covers:
 * - ensureDaemonRunning: already running path, start path
 * - getDaemonStatus: running / stopped
 * - stopDaemon: delegates to manager
 * - restartDaemonIfRunning: not running, stop fails, full restart
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const mockIsRunning = vi.fn().mockResolvedValue(false);
const mockGetPort = vi.fn().mockReturnValue(18470);
const mockGetLogFile = vi.fn().mockReturnValue('/home/user/.discode/daemon.log');
const mockGetPidFile = vi.fn().mockReturnValue('/home/user/.discode/daemon.pid');
const mockStartDaemon = vi.fn().mockReturnValue(12345);
const mockStopDaemon = vi.fn().mockReturnValue(true);
const mockWaitForReady = vi.fn().mockResolvedValue(true);
const mockSpawnSync = vi.fn();
const mockExistsSync = vi.fn().mockReturnValue(false);

vi.mock('../../src/daemon.js', () => ({
  defaultDaemonManager: {
    isRunning: (...args: any[]) => mockIsRunning(...args),
    getPort: (...args: any[]) => mockGetPort(...args),
    getLogFile: (...args: any[]) => mockGetLogFile(...args),
    getPidFile: (...args: any[]) => mockGetPidFile(...args),
    startDaemon: (...args: any[]) => mockStartDaemon(...args),
    stopDaemon: (...args: any[]) => mockStopDaemon(...args),
    waitForReady: (...args: any[]) => mockWaitForReady(...args),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: (...args: any[]) => mockSpawnSync(...args),
  };
});

// ── Import after mocks ──────────────────────────────────────────────

import {
  ensureDaemonRunning,
  getDaemonStatus,
  stopDaemon,
  restartDaemonIfRunning,
} from '../../src/app/daemon-service.js';

beforeEach(() => {
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(false);
  mockSpawnSync.mockReset();
  mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not available' });
  delete process.env.DISCODE_DAEMON_BACKEND;
});

// ── Tests ────────────────────────────────────────────────────────────

describe('ensureDaemonRunning', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCODE_DAEMON_BACKEND;
  });

  it('returns early when daemon is already running', async () => {
    mockIsRunning.mockResolvedValueOnce(true);

    const result = await ensureDaemonRunning();

    expect(result).toEqual({
      alreadyRunning: true,
      ready: true,
      port: 18470,
      logFile: '/home/user/.discode/daemon.log',
      backend: 'ts',
    });
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('starts daemon and waits for ready when not running', async () => {
    mockIsRunning.mockResolvedValueOnce(false);

    const result = await ensureDaemonRunning();

    expect(result).toEqual({
      alreadyRunning: false,
      ready: true,
      port: 18470,
      logFile: '/home/user/.discode/daemon.log',
      backend: 'ts',
    });
    expect(mockStartDaemon).toHaveBeenCalled();
    expect(mockWaitForReady).toHaveBeenCalled();
  });

  it('reports ready=false when waitForReady times out', async () => {
    mockIsRunning.mockResolvedValueOnce(false);
    mockWaitForReady.mockResolvedValueOnce(false);

    const result = await ensureDaemonRunning();

    expect(result.ready).toBe(false);
    expect(result.alreadyRunning).toBe(false);
    expect(result.backend).toBe('ts');
  });

  it('uses rust backend when feature flag is enabled and rust daemon is ready', async () => {
    process.env.DISCODE_DAEMON_BACKEND = 'rust';
    mockExistsSync.mockImplementation((value: string) => value.includes('discode-daemon-rs'));
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n', stderr: '' });

    const result = await ensureDaemonRunning();

    expect(result).toEqual({
      alreadyRunning: true,
      ready: true,
      port: 18470,
      logFile: '/tmp/r.log',
      backend: 'rust',
    });
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('falls back to TS daemon when rust daemon startup fails', async () => {
    process.env.DISCODE_DAEMON_BACKEND = 'rust';
    mockExistsSync.mockImplementation((value: string) => value.includes('discode-daemon-rs'));
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon not running\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'boot failed' });
    mockIsRunning.mockResolvedValueOnce(false);

    const result = await ensureDaemonRunning();

    expect(result.backend).toBe('ts');
    expect(result.fallbackFromRust).toBe(true);
    expect(result.fallbackReason).toContain('Rust daemon start failed');
    expect(mockStartDaemon).toHaveBeenCalled();
  });
});

describe('getDaemonStatus', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCODE_DAEMON_BACKEND;
  });

  it('returns running status with port and file paths', async () => {
    mockIsRunning.mockResolvedValueOnce(true);

    const result = await getDaemonStatus();

    expect(result).toEqual({
      running: true,
      port: 18470,
      logFile: '/home/user/.discode/daemon.log',
      pidFile: '/home/user/.discode/daemon.pid',
      backend: 'ts',
    });
  });

  it('returns not running status', async () => {
    mockIsRunning.mockResolvedValueOnce(false);

    const result = await getDaemonStatus();

    expect(result.running).toBe(false);
    expect(result.backend).toBe('ts');
  });

  it('reports rust backend status when rust daemon is running', async () => {
    process.env.DISCODE_DAEMON_BACKEND = 'rust';
    mockExistsSync.mockImplementation((value: string) => value.includes('discode-daemon-rs'));
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: 'Daemon running (port 18470)\n   Log: /tmp/rust-daemon.log\n   PID: /tmp/rust-daemon.pid\n',
      stderr: '',
    });

    const result = await getDaemonStatus();

    expect(result).toEqual({
      running: true,
      port: 18470,
      logFile: '/tmp/rust-daemon.log',
      pidFile: '/tmp/rust-daemon.pid',
      backend: 'rust',
    });
  });
});

describe('stopDaemon', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCODE_DAEMON_BACKEND;
  });

  it('delegates to defaultDaemonManager.stopDaemon', () => {
    mockStopDaemon.mockReturnValueOnce(true);
    expect(stopDaemon()).toBe(true);
    expect(mockStopDaemon).toHaveBeenCalled();
  });

  it('returns false when stop fails', () => {
    mockStopDaemon.mockReturnValueOnce(false);
    expect(stopDaemon()).toBe(false);
  });

  it('stops rust daemon when rust backend is selected', () => {
    process.env.DISCODE_DAEMON_BACKEND = 'rust';
    mockExistsSync.mockImplementation((value: string) => value.includes('discode-daemon-rs'));
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: 'Daemon stopped\n', stderr: '' });

    expect(stopDaemon()).toBe(true);
    expect(mockStopDaemon).not.toHaveBeenCalled();
  });
});

describe('restartDaemonIfRunning', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCODE_DAEMON_BACKEND;
  });

  it('does not restart when daemon is not running', async () => {
    mockIsRunning.mockResolvedValueOnce(false);

    const result = await restartDaemonIfRunning();

    expect(result.restarted).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.backend).toBe('ts');
    expect(mockStopDaemon).not.toHaveBeenCalled();
  });

  it('does not restart when stop fails', async () => {
    mockIsRunning.mockResolvedValueOnce(true);
    mockStopDaemon.mockReturnValueOnce(false);

    const result = await restartDaemonIfRunning();

    expect(result.restarted).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.backend).toBe('ts');
    expect(mockStopDaemon).toHaveBeenCalled();
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('stops and restarts when daemon is running', async () => {
    // getDaemonStatus call
    mockIsRunning.mockResolvedValueOnce(true);
    // ensureDaemonRunning call
    mockIsRunning.mockResolvedValueOnce(false);
    mockStopDaemon.mockReturnValueOnce(true);

    const result = await restartDaemonIfRunning();

    expect(result.restarted).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.backend).toBe('ts');
    expect(mockStopDaemon).toHaveBeenCalled();
    expect(mockStartDaemon).toHaveBeenCalled();
  });
});
