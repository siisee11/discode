import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawnSync = vi.fn();
const mockExistsSync = vi.fn();

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

import {
  ensureDaemonRunning,
  getDaemonStatus,
  restartDaemonIfRunning,
  stopDaemon,
} from '../../src/app/daemon-service.js';

beforeEach(() => {
  process.env.DISCODE_STATE_DIR = '/home/user/.discode';
  mockExistsSync.mockReset();
  mockExistsSync.mockImplementation((value: string) => value.includes('discode-daemon-rs'));
  mockSpawnSync.mockReset();
});

afterEach(() => {
  delete process.env.DISCODE_STATE_DIR;
  vi.clearAllMocks();
});

describe('ensureDaemonRunning', () => {
  it('returns already running when rust daemon status is running', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n',
      stderr: '',
    });

    const result = await ensureDaemonRunning();

    expect(result).toEqual({
      alreadyRunning: true,
      ready: true,
      port: 18470,
      logFile: '/tmp/r.log',
      backend: 'rust',
    });
  });

  it('starts rust daemon when status is not running', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon not running\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon started\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n',
        stderr: '',
      });

    const result = await ensureDaemonRunning();

    expect(result).toEqual({
      alreadyRunning: false,
      ready: true,
      port: 18470,
      logFile: '/tmp/r.log',
      backend: 'rust',
      fallbackReason: undefined,
    });
  });

  it('returns failure reason when rust start command fails', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon not running\n', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'boot failed' });

    const result = await ensureDaemonRunning();

    expect(result.ready).toBe(false);
    expect(result.backend).toBe('rust');
    expect(result.fallbackReason).toContain('Rust daemon start failed');
  });

  it('uses debug binary path when release binary is missing', async () => {
    mockExistsSync.mockImplementation((value: string) => value.includes('/target/debug/discode-daemon-rs'));
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n',
      stderr: '',
    });

    const result = await ensureDaemonRunning();

    expect(result.backend).toBe('rust');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      expect.stringContaining('/target/debug/discode-daemon-rs'),
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('returns actionable reason when daemon binary is missing', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await ensureDaemonRunning();

    expect(result.ready).toBe(false);
    expect(result.fallbackReason).toContain('DISCODE_DAEMON_RS_BIN');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

describe('getDaemonStatus', () => {
  it('reports parsed rust daemon status fields', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n   Runtime Stream Protocol: 2\n',
      stderr: '',
    });

    const status = await getDaemonStatus();

    expect(status).toEqual({
      running: true,
      port: 18470,
      logFile: '/tmp/r.log',
      pidFile: '/tmp/r.pid',
      runtimeStreamProtocolVersion: 2,
      backend: 'rust',
    });
  });
});

describe('stopDaemon', () => {
  it('returns true when rust daemon stop succeeds', () => {
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: 'Daemon stopped\n', stderr: '' });
    expect(stopDaemon()).toBe(true);
  });

  it('returns false when rust daemon stop fails', () => {
    mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'stop failed' });
    expect(stopDaemon()).toBe(false);
  });
});

describe('restartDaemonIfRunning', () => {
  it('does not restart when rust daemon is not running', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: 'Daemon not running\n', stderr: '' });

    const result = await restartDaemonIfRunning();

    expect(result).toEqual({
      restarted: false,
      ready: false,
      port: 18470,
      logFile: '/home/user/.discode/daemon.log',
      backend: 'rust',
    });
  });

  it('restarts rust daemon when running', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n',
        stderr: '',
      })
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon stopped\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon not running\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon started\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n',
        stderr: '',
      });

    const result = await restartDaemonIfRunning();

    expect(result).toEqual({
      restarted: true,
      ready: true,
      port: 18470,
      logFile: '/tmp/r.log',
      backend: 'rust',
    });
  });
});
