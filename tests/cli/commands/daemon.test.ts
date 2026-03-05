import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getDaemonStatus = vi.fn().mockResolvedValue({
    running: true,
    port: 18470,
    logFile: '/tmp/daemon.log',
    pidFile: '/tmp/daemon.pid',
    backend: 'rust',
    runtimeStreamProtocolVersion: 2,
  });
  const ensureDaemonRunning = vi.fn();
  const stopDaemon = vi.fn();
  const ensureTmuxInstalled = vi.fn();
  const isPtyRuntimeMode = vi.fn().mockReturnValue(true);
  const config = { runtimeMode: 'pty-rust' as const };
  return {
    getDaemonStatus,
    ensureDaemonRunning,
    stopDaemon,
    ensureTmuxInstalled,
    isPtyRuntimeMode,
    config,
  };
});

vi.mock('../../../src/app/daemon-service.js', () => ({
  getDaemonStatus: mocks.getDaemonStatus,
  ensureDaemonRunning: mocks.ensureDaemonRunning,
  stopDaemon: mocks.stopDaemon,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: mocks.config,
}));

vi.mock('../../../src/cli/common/tmux.js', () => ({
  ensureTmuxInstalled: mocks.ensureTmuxInstalled,
}));

vi.mock('../../../src/runtime/mode.js', () => ({
  isPtyRuntimeMode: mocks.isPtyRuntimeMode,
}));

describe('daemonCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints runtime stream protocol version in status output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { daemonCommand } = await import('../../../src/cli/commands/daemon.js');

    await daemonCommand('status');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Daemon running (port 18470)');
    expect(output).toContain('Runtime Stream Protocol: 2');
    logSpy.mockRestore();
  });

  it('prints unknown protocol when status does not include it', async () => {
    mocks.getDaemonStatus.mockResolvedValueOnce({
      running: true,
      port: 18470,
      logFile: '/tmp/daemon.log',
      pidFile: '/tmp/daemon.pid',
      backend: 'rust',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { daemonCommand } = await import('../../../src/cli/commands/daemon.js');

    await daemonCommand('status');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Runtime Stream Protocol: unknown');
    logSpy.mockRestore();
  });
});
