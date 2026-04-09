import { resolveNativeAttachMode, tryNativeAttach, type NativeAttachMode } from './native-attach.js';

export type RuntimeTerminalHostId = 'embedded' | 'native-attach';

export type RuntimeTerminalLaunchContext = {
  windowId: string;
  runtimePort: number;
  nativeAttachMode?: NativeAttachMode;
};

export type RuntimeTerminalLaunchResult =
  | { launched: true; host: RuntimeTerminalHostId }
  | { launched: false; host: 'none' };

export type RuntimeTerminalHost = {
  id: RuntimeTerminalHostId;
  open: (context: RuntimeTerminalLaunchContext) => boolean;
};

const nativeAttachHost: RuntimeTerminalHost = {
  id: 'native-attach',
  open: ({ windowId, runtimePort, nativeAttachMode }) =>
    tryNativeAttach(windowId, nativeAttachMode || resolveNativeAttachMode(), runtimePort),
};

const hostOrder: RuntimeTerminalHost[] = [
  // Milestone-1 seam freeze: embedded host will be added ahead of native attach.
  nativeAttachHost,
];

export function openRuntimeTerminal(context: RuntimeTerminalLaunchContext): RuntimeTerminalLaunchResult {
  for (const host of hostOrder) {
    if (host.open(context)) {
      return { launched: true, host: host.id };
    }
  }
  return { launched: false, host: 'none' };
}
