import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../../src/types/index.js';
import { resolveProjectWindowName, toProjectScopedName, toSharedWindowName } from '../../src/policy/window-naming.js';

function createProject(overrides?: Partial<ProjectState>): ProjectState {
  return {
    projectName: 'my-project',
    projectPath: '/tmp/project',
    runtimeSession: 'agent-bridge',
    agents: { claude: true },
    discordChannels: { claude: 'ch-1' },
    createdAt: new Date(),
    lastActive: new Date(),
    ...overrides,
  };
}

describe('window naming policy', () => {
  it('builds shared window names with sanitization', () => {
    expect(toSharedWindowName('my project', 'claude:2')).toBe('my-project-claude-2');
  });

  it('builds project-scoped name from base + instance', () => {
    expect(toProjectScopedName('my-project', 'claude', 'claude')).toBe('my-project-claude');
    expect(toProjectScopedName('my-project', 'claude', 'claude-2')).toBe('my-project-claude-2');
    expect(toProjectScopedName('my-project', 'claude', '2')).toBe('my-project-claude-2');
  });

  it('resolves mapped window first, then shared-session fallback', () => {
    const mapped = createProject({
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          runtimeWindow: 'explicit-window',
        },
      },
    });
    expect(resolveProjectWindowName(mapped, 'claude', { sessionPrefix: 'agent-', sharedSessionName: 'bridge' }, 'claude'))
      .toBe('explicit-window');

    const shared = createProject({
      instances: {
        'claude-2': {
          instanceId: 'claude-2',
          agentType: 'claude',
        },
      },
    });
    expect(resolveProjectWindowName(shared, 'claude', { sessionPrefix: 'agent-', sharedSessionName: 'bridge' }, 'claude-2'))
      .toBe('my-project-claude-2');
  });
});
