import { describe, expect, it } from 'vitest';
import { StateManager } from '../../src/state/index.js';
import type { IStorage } from '../../src/types/interfaces.js';
import type { ProjectState } from '../../src/types/index.js';

class MockStorage implements IStorage {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  readFile(path: string, _encoding: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  writeFile(path: string, data: string): void {
    this.files.set(path, data);
  }

  chmod(_path: string, _mode: number): void {}

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  mkdirp(path: string): void {
    this.dirs.add(path);
  }

  unlink(path: string): void {
    this.files.delete(path);
  }

  openSync(_path: string, _flags: string): number {
    return 0;
  }

  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }
}

describe('StateManager state persistence', () => {
  const stateDir = '/test/state';
  const stateFile = '/test/state/state.json';

  it('normalizes runtime project maps into instances on load', () => {
    const storage = new MockStorage();
    storage.setFile(
      stateFile,
      JSON.stringify({
        projects: {
          demo: {
            projectName: 'demo',
            projectPath: '/tmp/demo',
            runtimeSession: 'agent-demo',
            agents: { claude: true },
            discordChannels: { claude: 'ch-1' },
            runtimeWindows: { claude: 'demo-claude' },
            eventHooks: { claude: true },
            createdAt: new Date('2026-03-01T00:00:00.000Z'),
            lastActive: new Date('2026-03-01T00:00:00.000Z'),
          },
        },
      }),
    );

    const manager = new StateManager(storage, stateDir, stateFile);
    const project = manager.getProject('demo');

    expect(project?.instances?.claude).toEqual(expect.objectContaining({
      instanceId: 'claude',
      agentType: 'claude',
      channelId: 'ch-1',
      runtimeWindow: 'demo-claude',
      eventHook: true,
    }));
  });

  it('preserves unknown fields and normalizes current multi-instance fixture', () => {
    const storage = new MockStorage();
    storage.setFile(
      stateFile,
      JSON.stringify({
        projects: {
          demo: {
            projectName: 'demo',
            projectPath: '/tmp/demo',
            runtimeSession: 'agent-demo',
            agents: { opencode: true, claude: true },
            discordChannels: { opencode: 'ch-opencode', claude: 'legacy-ch-claude' },
            runtimeWindows: { opencode: 'demo-opencode', claude: 'demo-claude' },
            customProject: { value: 1 },
            instances: {
              opencode: {
                instanceId: 'opencode',
                agentType: 'opencode',
                runtimeWindow: 'demo-opencode',
                channelId: 'ch-opencode',
                eventHook: true,
              },
              claude: {
                instanceId: 'claude',
                agentType: 'claude',
                runtimeWindow: 'demo-claude',
                channelId: 'legacy-ch-claude',
                eventHook: false,
              },
            },
            createdAt: new Date('2026-03-01T00:00:00.000Z'),
            lastActive: new Date('2026-03-01T00:00:00.000Z'),
          },
        },
      }),
    );

    const manager = new StateManager(storage, stateDir, stateFile);
    const project = manager.getProject('demo') as any;

    expect(project.customProject?.value).toBe(1);
    expect(project.instances?.claude?.channelId).toBe('legacy-ch-claude');
    expect(project.discordChannels?.claude).toBe('legacy-ch-claude');
  });

  it('persists normalized state on setProject', () => {
    const storage = new MockStorage();
    const manager = new StateManager(storage, stateDir, stateFile);

    const project: ProjectState = {
      projectName: 'demo',
      projectPath: '/tmp/demo',
      runtimeSession: 'agent-demo',
      agents: {},
      discordChannels: {},
      instances: {
        'claude-2': {
          instanceId: 'claude-2',
          agentType: 'claude',
          runtimeWindow: 'demo-claude-2',
          channelId: 'ch-2',
          eventHook: true,
        },
      },
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      lastActive: new Date('2026-03-01T00:00:00.000Z'),
    };

    manager.setProject(project);

    const savedState = JSON.parse(storage.readFile(stateFile, 'utf-8')) as {
      projects: Record<string, any>;
    };
    const savedProject = savedState.projects.demo;

    expect(savedProject.instances['claude-2'].channelId).toBe('ch-2');
    expect(savedProject.instances['claude-2'].runtimeWindow).toBe('demo-claude-2');
    expect(savedProject.agents.claude).toBe(true);
    expect(savedProject.discordChannels.claude).toBe('ch-2');
    expect(savedProject.runtimeSession).toBe('agent-demo');
    expect(savedProject.runtimeWindows.claude).toBe('demo-claude-2');
    expect(savedProject.eventHooks.claude).toBe(true);
  });
});
