import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../../src/types/index.js';
import {
  buildNextInstanceId,
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  listProjectAgentTypes,
  listProjectInstances,
  normalizeProjectState,
} from '../../src/state/instances.js';

function makeProject(): ProjectState {
  return {
    projectName: 'demo',
    projectPath: '/tmp/demo',
    runtimeSession: 'bridge',
    agents: { gemini: true },
    discordChannels: { gemini: 'ch-1' },
    runtimeWindows: { gemini: 'demo-gemini' },
    createdAt: new Date(),
    lastActive: new Date(),
  };
}

describe('state instances helpers', () => {
  it('normalizes runtime project into instances', () => {
    const normalized = normalizeProjectState(makeProject());
    expect(normalized.instances?.gemini).toEqual(
      expect.objectContaining({
        instanceId: 'gemini',
        agentType: 'gemini',
        channelId: 'ch-1',
        runtimeWindow: 'demo-gemini',
      }),
    );
  });

  it('builds next instance ID for same agent', () => {
    const project = normalizeProjectState(makeProject());
    expect(buildNextInstanceId(project, 'gemini')).toBe('gemini-2');
  });

  it('finds instance by channel ID', () => {
    const project = normalizeProjectState({
      ...makeProject(),
      instances: {
        gemini: {
          instanceId: 'gemini',
          agentType: 'gemini',
          channelId: 'ch-1',
        },
        'gemini-2': {
          instanceId: 'gemini-2',
          agentType: 'gemini',
          channelId: 'ch-2',
        },
      },
    });

    const instances = listProjectInstances(project);
    expect(instances).toHaveLength(2);
    expect(findProjectInstanceByChannel(project, 'ch-2')?.instanceId).toBe('gemini-2');
  });
});

describe('channelId handling', () => {
  it('finds instance by channel when using channelId', () => {
    const project: ProjectState = {
      projectName: 'lookup',
      projectPath: '/tmp/lookup',
      runtimeSession: 'bridge',
      agents: { claude: true },
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          channelId: 'ch-lookup',
        },
      },
    };

    const found = findProjectInstanceByChannel(project, 'ch-lookup');
    expect(found?.instanceId).toBe('claude');
  });

  it('rebuilds discordChannels map from instances', () => {
    const project: ProjectState = {
      projectName: 'rebuild',
      projectPath: '/tmp/rebuild',
      runtimeSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          channelId: 'ch-rebuild',
        },
      },
    };

    const normalized = normalizeProjectState(project);
    expect(normalized.discordChannels).toEqual({ claude: 'ch-rebuild' });
  });
});

describe('normalizeProjectState', () => {
  it('handles project with no instances and no legacy fields', () => {
    const project: ProjectState = {
      projectName: 'empty',
      projectPath: '/tmp/empty',
      runtimeSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
    };

    const normalized = normalizeProjectState(project);
    expect(Object.keys(normalized.instances || {})).toHaveLength(0);
    expect(normalized.discordChannels).toEqual({});
  });

  it('normalizes multi-instance project with different agents', () => {
    const project: ProjectState = {
      projectName: 'multi',
      projectPath: '/tmp/multi',
      runtimeSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          channelId: 'ch-claude',
          runtimeWindow: 'multi-claude',
          eventHook: true,
        },
        gemini: {
          instanceId: 'gemini',
          agentType: 'gemini',
          channelId: 'ch-gemini',
          runtimeWindow: 'multi-gemini',
          eventHook: true,
        },
      },
    };

    const normalized = normalizeProjectState(project);
    expect(listProjectAgentTypes(normalized)).toEqual(expect.arrayContaining(['claude', 'gemini']));
    expect(normalized.discordChannels).toEqual({ claude: 'ch-claude', gemini: 'ch-gemini' });
    expect(getPrimaryInstanceForAgent(normalized, 'claude')?.channelId).toBe('ch-claude');
    expect(getPrimaryInstanceForAgent(normalized, 'gemini')?.channelId).toBe('ch-gemini');
  });

  it('skips instances with empty agentType', () => {
    const project: ProjectState = {
      projectName: 'skip',
      projectPath: '/tmp/skip',
      runtimeSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        bad: {
          instanceId: 'bad',
          agentType: '',
          channelId: 'ch-bad',
        },
        good: {
          instanceId: 'good',
          agentType: 'claude',
          channelId: 'ch-good',
        },
      },
    };

    const instances = listProjectInstances(project);
    expect(instances).toHaveLength(1);
    expect(instances[0].instanceId).toBe('good');
  });

  it('derives eventHooks map from instances', () => {
    const project: ProjectState = {
      projectName: 'hooks',
      projectPath: '/tmp/hooks',
      runtimeSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          eventHook: true,
        },
      },
    };

    const normalized = normalizeProjectState(project);
    expect(normalized.eventHooks).toEqual({ claude: true });
  });
});
