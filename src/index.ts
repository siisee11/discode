/**
 * Main entry point for discode
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DiscordClient } from './discord/client.js';
import { SlackClient } from './slack/client.js';
import type { MessagingClient } from './messaging/interface.js';
import type { AgentRuntime } from './runtime/interface.js';
import { createRuntimeForMode } from './runtime/factory.js';
import { stateManager as defaultStateManager } from './state/index.js';
import { config as defaultConfig } from './config/index.js';
import { agentRegistry as defaultAgentRegistry, AgentRegistry } from './agents/index.js';
import type { ProjectAgents } from './types/index.js';
import type { IStateManager } from './types/interfaces.js';
import type { BridgeConfig } from './types/index.js';
import {
  listProjectInstances,
  normalizeProjectState,
} from './state/instances.js';
import { ChromeMcpProxy } from './container/index.js';
import { ContainerSync } from './container/sync.js';
import { PendingMessageTracker } from './bridge/pending-message-tracker.js';
import { BridgeProjectBootstrap } from './bridge/project-bootstrap.js';
import { BridgeMessageRouter } from './bridge/message-router.js';
import { BridgeHookServer } from './bridge/hook-server.js';
import { StreamingMessageUpdater } from './bridge/streaming-message-updater.js';
import { RuntimeStreamServer, getDefaultRuntimeSocketPath } from './runtime/stream-server.js';
import { ClaudeSdkRunner } from './sdk/index.js';
import { setupProject, type ProjectSetupDeps } from './bridge/project-setup.js';
import { restoreRuntimeWindowsIfNeeded } from './bridge/window-restorer.js';

export interface AgentBridgeDeps {
  messaging?: MessagingClient;
  runtime?: AgentRuntime;
  stateManager?: IStateManager;
  registry?: AgentRegistry;
  config?: BridgeConfig;
}

export class AgentBridge {
  private messaging: MessagingClient;
  private runtime: AgentRuntime;
  private pendingTracker: PendingMessageTracker;
  private projectBootstrap: BridgeProjectBootstrap;
  private messageRouter: BridgeMessageRouter;
  private hookServer: BridgeHookServer;
  private streamServer: RuntimeStreamServer;
  private stateManager: IStateManager;
  private registry: AgentRegistry;
  private bridgeConfig: BridgeConfig;
  /** Active container sync instances keyed by `projectName#instanceId`. */
  private containerSyncs = new Map<string, ContainerSync>();
  /** TCP proxy bridging Chrome extension socket to containers. */
  private chromeMcpProxy: ChromeMcpProxy | null = null;
  /** SDK runner instances keyed by `projectName:instanceId`. */
  private sdkRunners = new Map<string, ClaudeSdkRunner>();
  /** Bearer token for hook server authentication. */
  private hookAuthToken: string | undefined;

  constructor(deps?: AgentBridgeDeps) {
    this.bridgeConfig = deps?.config || defaultConfig;
    this.messaging = deps?.messaging || this.createMessagingClient();
    this.runtime = deps?.runtime || this.createRuntime();
    this.stateManager = deps?.stateManager || defaultStateManager;
    this.registry = deps?.registry || defaultAgentRegistry;
    this.pendingTracker = new PendingMessageTracker(this.messaging);
    const streamingUpdater = new StreamingMessageUpdater(this.messaging);
    this.projectBootstrap = new BridgeProjectBootstrap(this.stateManager, this.messaging, this.bridgeConfig.hookServerPort || 18470);
    this.messageRouter = new BridgeMessageRouter({
      messaging: this.messaging,
      runtime: this.runtime,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      streamingUpdater,
      sanitizeInput: (content) => this.sanitizeInput(content),
      getSdkRunner: (projectName, instanceId) => this.sdkRunners.get(`${projectName}:${instanceId}`),
    });
    this.hookServer = new BridgeHookServer({
      port: this.bridgeConfig.hookServerPort || 18470,
      messaging: this.messaging,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      streamingUpdater,
      runtime: this.runtime,
      reloadChannelMappings: () => this.projectBootstrap.reloadChannelMappings(),
    });
    this.streamServer = new RuntimeStreamServer(this.runtime, getDefaultRuntimeSocketPath());
  }

  private createRuntime(): AgentRuntime {
    return createRuntimeForMode(this.bridgeConfig.runtimeMode, this.bridgeConfig.tmux.sessionPrefix);
  }

  private createMessagingClient(): MessagingClient {
    if (this.bridgeConfig.messagingPlatform === 'slack') {
      if (!this.bridgeConfig.slack) {
        throw new Error('Slack is configured as messaging platform but Slack tokens are missing. Run: discode onboard --platform slack');
      }
      return new SlackClient(this.bridgeConfig.slack.botToken, this.bridgeConfig.slack.appToken);
    }
    return new DiscordClient(this.bridgeConfig.discord.token);
  }

  /**
   * Sanitize message input before passing to runtime
   */
  public sanitizeInput(content: string): string | null {
    if (!content || content.trim().length === 0) return null;
    if (content.length > 10000) return null;

    let sanitized = content;
    // Remove null bytes
    sanitized = sanitized.replace(/\0/g, '');
    // Strip ANSI escape sequences
    sanitized = sanitized.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    // Strip other C0/C1 control characters (keep newline \x0a, tab \x09, carriage return \x0d)
    sanitized = sanitized.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    return sanitized.trim().length === 0 ? null : sanitized;
  }

  /**
   * Connect messaging client (for init command)
   */
  async connect(): Promise<void> {
    await this.messaging.connect();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting Discode...');

    // Read existing hook auth token or generate a new one.
    // Reusing the persisted token prevents auth mismatches when a daemon
    // restarts — the Codex process may still hold the previous token.
    const stateDir = join(homedir(), '.discode');
    mkdirSync(stateDir, { recursive: true });
    const tokenPath = join(stateDir, '.hook-token');
    let token: string | undefined;
    try {
      const existing = readFileSync(tokenPath, 'utf-8').trim();
      if (existing.length > 0) token = existing;
    } catch { /* file doesn't exist yet */ }
    if (!token) {
      token = randomBytes(32).toString('hex');
      writeFileSync(tokenPath, token, { mode: 0o600 });
    }
    this.hookAuthToken = token;
    this.hookServer.setAuthToken(this.hookAuthToken);

    await this.messaging.connect();
    console.log('✅ Messaging client connected');

    try {
      const proxy = new ChromeMcpProxy({ port: (this.bridgeConfig.hookServerPort || 18470) + 1 });
      if (await proxy.start()) {
        this.chromeMcpProxy = proxy;
        console.log(`🌐 Chrome MCP proxy listening on port ${proxy.getPort()}`);
      }
    } catch {
      // Non-critical
    }

    const projects = this.projectBootstrap.bootstrapProjects();
    this.injectContainerPlugins(projects);
    restoreRuntimeWindowsIfNeeded({
      runtime: this.runtime,
      stateManager: this.stateManager,
      registry: this.registry,
      bridgeConfig: this.bridgeConfig,
      containerSyncs: this.containerSyncs,
      createSdkRunner: (...args) => this.createSdkRunner(...args),
    });
    this.messageRouter.register();
    this.hookServer.start();
    this.streamServer.start();

    console.log('✅ Discode is running');
    console.log(`📡 Server listening on port ${this.bridgeConfig.hookServerPort || 18470}`);
    console.log(`🤖 Registered agents: ${this.registry.getAll().map(a => a.config.displayName).join(', ')}`);
  }

  /**
   * Inject agent plugins/hooks into existing container instances on daemon restart.
   */
  private injectContainerPlugins(projects: ReturnType<IStateManager['listProjects']>): void {
    const socketPath = this.bridgeConfig.container?.socketPath || undefined;
    for (const rawProject of projects) {
      const project = normalizeProjectState(rawProject);
      for (const instance of listProjectInstances(project)) {
        if (!instance.containerMode || !instance.containerId) continue;

        const adapter = this.registry.get(instance.agentType);
        if (adapter) {
          adapter.injectContainerPlugins(instance.containerId, socketPath);
        }
      }
    }
  }

  async setupProject(
    projectName: string,
    projectPath: string,
    agents: ProjectAgents,
    channelDisplayName?: string,
    overridePort?: number,
    options?: { instanceId?: string; skipRuntimeStart?: boolean },
  ): Promise<{ channelName: string; channelId: string; agentName: string; runtimeSession: string }> {
    const deps: ProjectSetupDeps = {
      messaging: this.messaging,
      runtime: this.runtime,
      stateManager: this.stateManager,
      registry: this.registry,
      bridgeConfig: this.bridgeConfig,
      containerSyncs: this.containerSyncs,
    };
    return setupProject(deps, projectName, projectPath, agents, channelDisplayName, overridePort, options);
  }

  /**
   * Create an SDK runner for an instance and register it in the map.
   */
  createSdkRunner(
    projectName: string,
    instanceId: string,
    agentType: string,
    projectPath: string,
    options?: { model?: string; permissionAllow?: boolean },
  ): ClaudeSdkRunner {
    const key = `${projectName}:${instanceId}`;
    const existing = this.sdkRunners.get(key);
    if (existing) return existing;

    const runner = new ClaudeSdkRunner({
      projectName,
      instanceId,
      agentType,
      projectPath,
      model: options?.model,
      permissionAllow: options?.permissionAllow ?? false,
      onEvent: (payload) => this.hookServer.handleOpencodeEvent(payload),
    });

    this.sdkRunners.set(key, runner);
    return runner;
  }

  async stop(): Promise<void> {
    if (this.chromeMcpProxy) {
      this.chromeMcpProxy.stop();
      this.chromeMcpProxy = null;
    }

    for (const [, runner] of this.sdkRunners) {
      runner.dispose();
    }
    this.sdkRunners.clear();

    for (const [, sync] of this.containerSyncs) {
      sync.stop();
    }
    this.containerSyncs.clear();

    this.streamServer.stop();
    this.hookServer.stop();
    this.runtime.dispose?.('SIGTERM');
    await this.messaging.disconnect();
  }
}

export async function main() {
  const bridge = new AgentBridge();

  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    try {
      await bridge.stop();
    } catch (error) {
      console.error('Error during shutdown:', error);
    }
    process.exit(0);
  });

  await bridge.start();
}

function isDirectExecution(): boolean {
  const bunMain = (import.meta as ImportMeta & { main?: boolean }).main;
  if (typeof bunMain === 'boolean') {
    return bunMain;
  }

  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === `file://${argv1}`;
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
