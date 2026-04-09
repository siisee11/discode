/**
 * Shared helpers for E2E tests.
 *
 * Re-exports common utilities from existing test helpers and adds
 * new factories for wiring real components together.
 */

import { vi } from 'vitest';
import type { MessagingClient } from '../../src/messaging/interface.js';
import type { IStateManager } from '../../src/types/interfaces.js';
import type { ProjectState } from '../../src/types/index.js';
import { BridgeHookServer, type BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';
import { StreamingMessageUpdater } from '../../src/bridge/streaming-message-updater.js';
import { normalizeProjectState } from '../../src/state/instances.js';

// Re-exports from existing helpers
export { postJSON, getRequest, postRaw, TEST_AUTH_TOKEN } from '../bridge/hook-server-helpers.js';

// ---------------------------------------------------------------------------
// Full mock messaging — all MessagingClient methods with call logging
// ---------------------------------------------------------------------------

let nextMessageId = 1;

export function createFullMockMessaging(platform: 'discord' | 'slack' = 'slack'): MessagingClient {
  nextMessageId = 1;
  return {
    platform,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockImplementation(async () => `msg-${nextMessageId++}`),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue(undefined),
    replyInThreadWithId: vi.fn().mockImplementation(async () => `thread-msg-${nextMessageId++}`),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    createAgentChannels: vi.fn().mockResolvedValue({ claude: 'ch-123' }),
    registerChannelMappings: vi.fn(),
    getChannelMapping: vi.fn().mockReturnValue(new Map()),
    getGuilds: vi.fn().mockReturnValue([]),
    deleteChannel: vi.fn().mockResolvedValue(true),
    sendApprovalRequest: vi.fn().mockResolvedValue(true),
    sendQuestionWithButtons: vi.fn().mockResolvedValue(null),
  } as unknown as MessagingClient;
}

// ---------------------------------------------------------------------------
// State manager with pre-loaded project
// ---------------------------------------------------------------------------

export function createStateWithProject(
  projectName: string,
  opts: {
    agentType?: string;
    channelId?: string;
    instanceId?: string;
    projectPath?: string;
  } = {},
): IStateManager {
  const agentType = opts.agentType ?? 'claude';
  const channelId = opts.channelId ?? 'ch-1';
  const instanceId = opts.instanceId ?? agentType;
  const projectPath = opts.projectPath ?? '/tmp/test-project';

  const project: ProjectState = normalizeProjectState({
    projectName,
    projectPath,
    runtimeSession: `agent-${projectName}`,
    agents: { [agentType]: true },
    discordChannels: { [agentType]: channelId },
    instances: {
      [instanceId]: {
        instanceId,
        agentType,
        channelId,
        eventHook: true,
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  } as ProjectState);

  const projects: Record<string, ProjectState> = { [projectName]: project };

  return {
    getProject: vi.fn((name: string) => projects[name]),
    setProject: vi.fn((p: ProjectState) => { projects[p.projectName] = p; }),
    listProjects: vi.fn(() => Object.values(projects)),
    reload: vi.fn(),
    removeProject: vi.fn((name: string) => { delete projects[name]; }),
    getGuildId: vi.fn(),
    setGuildId: vi.fn(),
    getWorkspaceId: vi.fn(),
    setWorkspaceId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  } as unknown as IStateManager;
}

// ---------------------------------------------------------------------------
// Full hook server with real tracker + updater + mock messaging
// ---------------------------------------------------------------------------

export interface FullHookServerResult {
  server: BridgeHookServer;
  port: number;
  messaging: MessagingClient;
  pendingTracker: PendingMessageTracker;
  streamingUpdater: StreamingMessageUpdater;
  stateManager: IStateManager;
}

export async function startFullHookServer(opts: {
  projectName?: string;
  agentType?: string;
  channelId?: string;
  platform?: 'discord' | 'slack';
  authToken?: string;
}): Promise<FullHookServerResult> {
  const projectName = opts.projectName ?? 'test-proj';
  const agentType = opts.agentType ?? 'claude';
  const channelId = opts.channelId ?? 'ch-1';
  const platform = opts.platform ?? 'slack';
  const authToken = opts.authToken ?? 'test-hook-token-for-vitest';

  const messaging = createFullMockMessaging(platform);
  const pendingTracker = new PendingMessageTracker(messaging);
  const streamingUpdater = new StreamingMessageUpdater(messaging);
  const stateManager = createStateWithProject(projectName, { agentType, channelId });

  const deps: BridgeHookServerDeps = {
    port: 0,
    messaging,
    stateManager,
    pendingTracker,
    streamingUpdater,
    reloadChannelMappings: vi.fn(),
    authToken,
  };

  const server = new BridgeHookServer(deps);
  server.start();
  await server.ready();
  const addr = server.address();
  if (!addr) throw new Error('Server did not bind');

  return { server, port: addr.port, messaging, pendingTracker, streamingUpdater, stateManager };
}

// ---------------------------------------------------------------------------
// Event posting helper
// ---------------------------------------------------------------------------

export async function postEvent(
  port: number,
  event: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: string }> {
  const { postJSON, TEST_AUTH_TOKEN } = await import('../bridge/hook-server-helpers.js');
  return postJSON(port, '/opencode-event', event, token ?? TEST_AUTH_TOKEN);
}

// ---------------------------------------------------------------------------
// Utility: wait for mock calls to reach a count
// ---------------------------------------------------------------------------

export async function waitForCalls(
  mockFn: { mock: { calls: unknown[] } },
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (mockFn.mock.calls.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForCalls: expected ${count} calls, got ${mockFn.mock.calls.length} after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Utility: filter sendToChannel calls for a specific channel
// ---------------------------------------------------------------------------

export function getChannelMessages(
  messaging: MessagingClient,
  channelId: string,
): string[] {
  const mock = messaging.sendToChannel as ReturnType<typeof vi.fn>;
  return mock.mock.calls
    .filter((call: unknown[]) => call[0] === channelId)
    .map((call: unknown[]) => call[1] as string);
}
