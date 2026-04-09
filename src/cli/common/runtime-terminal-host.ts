import { resolveNativeAttachMode, tryNativeAttach, type NativeAttachMode } from './native-attach.js';
import { openEmbeddedRuntimeTerminal } from './runtime-terminal-embedded-host.js';
import type { RuntimeSessionManager } from './runtime-session-manager.js';

export type RuntimeTerminalHostId = 'embedded' | 'native-attach';

export type RuntimeTerminalLaunchContext = {
  session: RuntimeSessionManager;
  windowId: string;
  runtimePort: number;
  nativeAttachMode?: NativeAttachMode;
};

export type RuntimeTerminalLaunchResult =
  | { launched: true; host: RuntimeTerminalHostId }
  | { launched: false; host: 'none' };

export type RuntimeTerminalHost = {
  id: RuntimeTerminalHostId;
  open: (context: RuntimeTerminalLaunchContext) => boolean | Promise<boolean>;
};

const nativeAttachHost: RuntimeTerminalHost = {
  id: 'native-attach',
  open: ({ windowId, runtimePort, nativeAttachMode }) =>
    tryNativeAttach(windowId, nativeAttachMode || resolveNativeAttachMode(), runtimePort),
};

const embeddedHost: RuntimeTerminalHost = {
  id: 'embedded',
  open: async ({ session, windowId }) => await openEmbeddedRuntimeTerminal({ session, windowId }),
};

const hostOrder: RuntimeTerminalHost[] = [
  embeddedHost,
  nativeAttachHost,
];

export async function openRuntimeTerminal(context: RuntimeTerminalLaunchContext): Promise<RuntimeTerminalLaunchResult> {
  for (const host of hostOrder) {
    if (await host.open(context)) {
      return { launched: true, host: host.id };
    }
  }
  return { launched: false, host: 'none' };
}
