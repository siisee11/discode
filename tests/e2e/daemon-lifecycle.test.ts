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

describe('Daemon Lifecycle E2E', () => {
  it('runs full ensure -> status -> stop flow', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon not running\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon started\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n',
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Daemon running (port 18470)\n   Log: /tmp/r.log\n   PID: /tmp/r.pid\n',
        stderr: '',
      })
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon stopped\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'Daemon not running\n', stderr: '' });

    const start = await ensureDaemonRunning();
    const status = await getDaemonStatus();
    const stopped = stopDaemon();
    const afterStop = await getDaemonStatus();

    expect(start.ready).toBe(true);
    expect(start.backend).toBe('rust');
    expect(status.running).toBe(true);
    expect(status.backend).toBe('rust');
    expect(stopped).toBe(true);
    expect(afterStop.running).toBe(false);
  });

  it('restarts when already running', async () => {
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
