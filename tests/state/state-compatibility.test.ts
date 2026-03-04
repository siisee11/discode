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

describe('StateManager compatibility', () => {
  const stateDir = '/test/state';
  const stateFile = '/test/state/state.json';

  it('normalizes legacy project maps into instances on load', () => {
    const storage = new MockStorage();
    storage.setFile(stateFile, JSON.stringify({
      projects: {
        demo: {
          projectName: 'demo',
          projectPath: '/tmp/demo',
          tmuxSession: 'agent-demo',
          agents: { claude: true },
          discordChannels: { claude: 'ch-1' },
          tmuxWindows: { claude: 'demo-claude' },
          eventHooks: { claude: true },
          createdAt: '2026-03-01T00:00:00.000Z',
          lastActive: '2026-03-01T00:00:00.000Z',
        },
      },
    }));

    const manager = new StateManager(storage, stateDir, stateFile);
    const project = manager.getProject('demo');

    expect(project?.instances?.claude).toEqual(expect.objectContaining({
      instanceId: 'claude',
      agentType: 'claude',
      channelId: 'ch-1',
      tmuxWindow: 'demo-claude',
      eventHook: true,
    }));
  });

  it('maps legacy instances.discordChannelId to channelId', () => {
    const storage = new MockStorage();
    storage.setFile(stateFile, JSON.stringify({
      projects: {
        demo: {
          projectName: 'demo',
          projectPath: '/tmp/demo',
          tmuxSession: 'agent-demo',
          agents: {},
          discordChannels: {},
          instances: {
            claude: {
              instanceId: 'claude',
              agentType: 'claude',
              discordChannelId: 'legacy-ch-1',
            },
          },
          createdAt: '2026-03-01T00:00:00.000Z',
          lastActive: '2026-03-01T00:00:00.000Z',
        },
      },
    }));

    const manager = new StateManager(storage, stateDir, stateFile);
    const project = manager.getProject('demo');

    expect(project?.instances?.claude?.channelId).toBe('legacy-ch-1');
    expect(project?.discordChannels?.claude).toBe('legacy-ch-1');
  });

  it('persists normalized state on setProject', () => {
    const storage = new MockStorage();
    const manager = new StateManager(storage, stateDir, stateFile);

    const project: ProjectState = {
      projectName: 'demo',
      projectPath: '/tmp/demo',
      tmuxSession: 'agent-demo',
      agents: {},
      discordChannels: {},
      instances: {
        'claude-2': {
          instanceId: 'claude-2',
          agentType: 'claude',
          tmuxWindow: 'demo-claude-2',
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
    expect(savedProject.agents.claude).toBe(true);
    expect(savedProject.discordChannels.claude).toBe('ch-2');
    expect(savedProject.tmuxWindows.claude).toBe('demo-claude-2');
    expect(savedProject.eventHooks.claude).toBe(true);
  });
});
