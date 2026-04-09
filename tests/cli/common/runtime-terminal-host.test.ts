import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openEmbeddedRuntimeTerminal: vi.fn<() => Promise<boolean>>(),
  resolveNativeAttachMode: vi.fn(() => 'auto' as const),
  tryNativeAttach: vi.fn(() => false),
}));

vi.mock('../../../src/cli/common/runtime-terminal-embedded-host.js', () => ({
  openEmbeddedRuntimeTerminal: mocks.openEmbeddedRuntimeTerminal,
}));

vi.mock('../../../src/cli/common/native-attach.js', () => ({
  resolveNativeAttachMode: mocks.resolveNativeAttachMode,
  tryNativeAttach: mocks.tryNativeAttach,
}));

describe('openRuntimeTerminal', () => {
  const context = {
    session: {} as any,
    windowId: 'bridge:demo',
    runtimePort: 18470,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveNativeAttachMode.mockReturnValue('auto');
    mocks.tryNativeAttach.mockReturnValue(false);
    mocks.openEmbeddedRuntimeTerminal.mockResolvedValue(false);
  });

  it('prefers embedded host when available', async () => {
    mocks.openEmbeddedRuntimeTerminal.mockResolvedValue(true);
    const { openRuntimeTerminal } = await import('../../../src/cli/common/runtime-terminal-host.js');

    const result = await openRuntimeTerminal(context);

    expect(result).toEqual({ launched: true, host: 'embedded' });
    expect(mocks.openEmbeddedRuntimeTerminal).toHaveBeenCalledWith({
      session: context.session,
      windowId: context.windowId,
    });
    expect(mocks.tryNativeAttach).not.toHaveBeenCalled();
  });

  it('falls back to native attach when embedded host is unavailable', async () => {
    mocks.openEmbeddedRuntimeTerminal.mockResolvedValue(false);
    mocks.tryNativeAttach.mockReturnValue(true);
    const { openRuntimeTerminal } = await import('../../../src/cli/common/runtime-terminal-host.js');

    const result = await openRuntimeTerminal(context);

    expect(result).toEqual({ launched: true, host: 'native-attach' });
    expect(mocks.tryNativeAttach).toHaveBeenCalledWith(context.windowId, 'auto', context.runtimePort);
  });

  it('returns none when neither host can launch', async () => {
    const { openRuntimeTerminal } = await import('../../../src/cli/common/runtime-terminal-host.js');

    const result = await openRuntimeTerminal(context);

    expect(result).toEqual({ launched: false, host: 'none' });
  });
});
