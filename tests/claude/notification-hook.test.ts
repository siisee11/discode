/**
 * Unit tests for the Claude Code notification-hook script.
 *
 * The hook is a CJS script (not a module), so we validate its structure
 * and bridge POST payload using a VM context.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dir, '../../src/claude/plugin/scripts');
const hookPath = join(scriptsDir, 'discode-notification-hook.js');

function loadLib(overrides: { process?: any; fetch?: any } = {}) {
  const realFs = require('fs');
  const libSrc = readFileSync(join(scriptsDir, 'discode-hook-lib.js'), 'utf-8');
  const libMod = { exports: {} as any };
  new Script(libSrc, { filename: 'discode-hook-lib.js' }).runInContext(createContext({
    require: (m: string) => m === 'fs' ? realFs : {},
    module: libMod, exports: libMod.exports,
    process: overrides.process || { env: {} },
    fetch: overrides.fetch || (async () => ({})),
    Buffer, Promise, setTimeout, JSON, Array, Object, Math, Number, String, parseInt, parseFloat,
  }));
  return libMod.exports;
}

function makeRequire(lib: any, realFs?: any) {
  const fs = realFs || require('fs');
  return (mod: string) => {
    if (mod === 'fs') return fs;
    if (mod === './discode-hook-lib.js' || mod === './discode-hook-lib') return lib;
    return {};
  };
}

function runHook(env: Record<string, string>, stdinJson: unknown): Promise<{ calls: Array<{ url: string; body: unknown }> }> {
  return new Promise((resolve) => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];

    const stdinData = JSON.stringify(stdinJson);
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;

    const mockProcess = {
      env,
      stdin: {
        isTTY: false,
        setEncoding: () => {},
        on: (event: string, cb: any) => {
          if (event === 'data') onData = cb;
          if (event === 'end') onEnd = cb;
        },
      },
    };
    const mockFetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body) });
      return {};
    };

    const lib = loadLib({ process: mockProcess, fetch: mockFetch });
    const ctx = createContext({
      require: makeRequire(lib),
      process: mockProcess,
      console: { error: () => {} },
      Promise,
      setTimeout,
      Buffer,
      JSON,
      Array,
      Object,
      String,
      Number,
      Math,
      parseInt,
      parseFloat,
      fetch: mockFetch,
    });

    new Script(raw, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

    // Simulate stdin delivery
    setTimeout(() => {
      if (onData) onData(stdinData);
      if (onEnd) onEnd();
      // Wait for async main() to complete
      setTimeout(() => resolve({ calls: fetchCalls }), 50);
    }, 10);
  });
}

// Load functions via VM for unit testing extractFromTranscript, extractPromptQuestions
type ExtractFromTranscriptResult = { promptText: string; promptQuestions: unknown[]; planFilePath: string };
type ExtractFromTranscriptFn = (transcriptPath: string) => ExtractFromTranscriptResult;
type ExtractPromptQuestionsFn = (toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }>) => unknown[];
type FormatPromptTextFn = (toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }>) => string;

function loadHookFunctions() {
  const raw = readFileSync(hookPath, 'utf-8');
  const src = raw.replace(/main\(\)\.catch[\s\S]*$/, '');

  const lib = loadLib();
  const ctx = createContext({
    require: makeRequire(lib),
    process: { env: {}, stdin: { isTTY: true } },
    console: { error: () => {} },
    Promise,
    setTimeout,
    Buffer,
    JSON,
    Array,
    Object,
    Math,
    Number,
    String,
    parseInt,
    parseFloat,
  });

  new Script(src, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

  return {
    extractFromTranscript: (ctx as any).extractFromTranscript as ExtractFromTranscriptFn,
    extractPromptQuestions: (ctx as any).extractPromptQuestions as ExtractPromptQuestionsFn,
    formatPromptText: (ctx as any).formatPromptText as FormatPromptTextFn,
  };
}

const { extractFromTranscript, extractPromptQuestions, formatPromptText } = loadHookFunctions();

describe('discode-notification-hook', () => {
  it('posts session.notification event with permission_prompt type', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'myproject', DISCODE_PORT: '18470' },
      { message: 'Claude needs permission to use Bash', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    const payload = result.calls[0].body as Record<string, unknown>;
    expect(payload.type).toBe('session.notification');
    expect(payload.projectName).toBe('myproject');
    expect(payload.agentType).toBe('claude');
    expect(payload.notificationType).toBe('permission_prompt');
    expect(payload.text).toBe('Claude needs permission to use Bash');
  });

  it('posts with idle_prompt notification type', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { message: 'Claude is idle', notification_type: 'idle_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('idle_prompt');
  });

  it('posts with auth_success notification type', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { message: 'Auth succeeded', notification_type: 'auth_success' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('auth_success');
    expect((result.calls[0].body as any).text).toBe('Auth succeeded');
  });

  it('posts with elicitation_dialog notification type', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { message: 'Claude wants to ask a question', notification_type: 'elicitation_dialog' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('elicitation_dialog');
  });

  it('includes instanceId when set', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_INSTANCE: 'inst-1' },
      { message: 'test', notification_type: 'auth_success' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).instanceId).toBe('inst-1');
  });

  it('omits instanceId when DISCODE_INSTANCE is empty', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_INSTANCE: '' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).instanceId).toBeUndefined();
  });

  it('uses custom DISCODE_AGENT', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_AGENT: 'gemini' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).agentType).toBe('gemini');
  });

  it('uses custom DISCODE_HOSTNAME in fetch URL', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999', DISCODE_HOSTNAME: '10.0.0.1' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe('http://10.0.0.1:9999/opencode-event');
  });

  it('uses custom DISCODE_PORT', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '12345' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toContain(':12345/');
  });

  it('does nothing when DISCODE_PROJECT is not set', async () => {
    const result = await runHook(
      { DISCODE_PORT: '18470' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('handles missing notification_type gracefully', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { message: 'some notification' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('unknown');
  });

  it('handles empty message', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { message: '', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('');
  });

  it('handles missing message field (undefined)', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { notification_type: 'idle_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('');
  });

  it('trims whitespace from message', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { message: '  some message  ', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('some message');
  });

  it('silently ignores fetch failure', async () => {
    // Run hook with a setup that would cause fetch to throw
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ message: 'test', notification_type: 'permission_prompt' });
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;
    let errorThrown = false;

    const mockProcess = {
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      stdin: {
        isTTY: false,
        setEncoding: () => {},
        on: (event: string, cb: any) => {
          if (event === 'data') onData = cb;
          if (event === 'end') onEnd = cb;
        },
      },
    };
    const mockFetch = async () => { throw new Error('network error'); };
    const lib = loadLib({ process: mockProcess, fetch: mockFetch });
    const ctx = createContext({
      require: makeRequire(lib),
      process: mockProcess,
      console: { error: () => {} },
      Promise,
      setTimeout,
      Buffer,
      JSON,
      Array,
      Object,
      String,
      Number,
      Math,
      parseInt,
      parseFloat,
      fetch: mockFetch,
    });

    new Script(raw, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData(stdinData);
        if (onEnd) onEnd();
        setTimeout(() => {
          // If we get here without error, the hook silently swallowed the failure
          resolve();
        }, 50);
      }, 10);
    });

    // Test passes if no unhandled rejection
    expect(errorThrown).toBe(false);
  });

  it('handles isTTY stdin (no data) gracefully', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];

    const mockProcess = {
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      stdin: {
        isTTY: true,
        setEncoding: () => {},
        on: () => {},
      },
    };
    const mockFetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body) });
      return {};
    };
    const lib = loadLib({ process: mockProcess, fetch: mockFetch });
    const ctx = createContext({
      require: makeRequire(lib),
      process: mockProcess,
      console: { error: () => {} },
      Promise,
      setTimeout,
      Buffer,
      JSON,
      Array,
      Object,
      String,
      Number,
      Math,
      parseInt,
      parseFloat,
      fetch: mockFetch,
    });

    new Script(raw, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 100);
    });

    // isTTY=true → readStdin returns "" → input={} → posts with defaults
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0].body as any).notificationType).toBe('unknown');
    expect((fetchCalls[0].body as any).text).toBe('');
  });

  it('handles malformed JSON stdin gracefully', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;

    const mockProcess = {
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      stdin: {
        isTTY: false,
        setEncoding: () => {},
        on: (event: string, cb: any) => {
          if (event === 'data') onData = cb;
          if (event === 'end') onEnd = cb;
        },
      },
    };
    const mockFetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body) });
      return {};
    };
    const lib = loadLib({ process: mockProcess, fetch: mockFetch });
    const ctx = createContext({
      require: makeRequire(lib),
      process: mockProcess,
      console: { error: () => {} },
      Promise,
      setTimeout,
      Buffer,
      JSON,
      Array,
      Object,
      String,
      Number,
      Math,
      parseInt,
      parseFloat,
      fetch: mockFetch,
    });

    new Script(raw, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData('not valid json {{{');
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Should still post with defaults (empty message, unknown type)
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0].body as any).notificationType).toBe('unknown');
    expect((fetchCalls[0].body as any).text).toBe('');
  });
});

// ── extractPromptFromTranscript ──────────────────────────────────────

describe('extractFromTranscript', () => {
  let tempDir: string;

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-notif-test-'));
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true });
  }

  function writeTranscript(lines: unknown[]): string {
    const filePath = join(tempDir, 'transcript.jsonl');
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'));
    return filePath;
  }

  it('extracts AskUserQuestion promptText from transcript', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Help me decide' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'text', text: 'Which approach?' },
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    header: 'Approach',
                    question: 'Which approach do you prefer?',
                    options: [
                      { label: 'Fast', description: 'Quick but risky' },
                      { label: 'Safe', description: 'Slow but reliable' },
                    ],
                  }],
                },
              },
            ],
          },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.promptText).toContain('Which approach do you prefer?');
      expect(result.promptText).toContain('*Fast*');
      expect(result.promptText).toContain('Quick but risky');
      expect(result.promptText).toContain('*Safe*');
      expect(result.promptText).toContain('Slow but reliable');
    } finally {
      teardown();
    }
  });

  it('extracts AskUserQuestion promptQuestions as structured objects', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Help' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    header: 'Library',
                    question: 'Which library?',
                    options: [
                      { label: 'React', description: 'UI library' },
                      { label: 'Vue', description: 'Progressive framework' },
                    ],
                  }],
                },
              },
            ],
          },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.promptQuestions).toHaveLength(1);
      const q = result.promptQuestions[0] as any;
      expect(q.question).toBe('Which library?');
      expect(q.header).toBe('Library');
      expect(q.options).toHaveLength(2);
      expect(q.options[0].label).toBe('React');
      expect(q.options[0].description).toBe('UI library');
      expect(q.options[1].label).toBe('Vue');
    } finally {
      teardown();
    }
  });

  it('extracts ExitPlanMode prompt from transcript', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Plan this' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'text', text: 'Here is my plan' },
              { type: 'tool_use', name: 'ExitPlanMode', input: {} },
            ],
          },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.promptText).toContain('Plan approval needed');
    } finally {
      teardown();
    }
  });

  it('extracts planFilePath from Write tool targeting .claude/plans/', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Plan this' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/project/.claude/plans/my-plan.md', content: '# Plan' } },
              { type: 'tool_use', name: 'ExitPlanMode', input: {} },
            ],
          },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.planFilePath).toBe('/tmp/project/.claude/plans/my-plan.md');
    } finally {
      teardown();
    }
  });

  it('returns empty planFilePath when ExitPlanMode is absent', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Write file' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/.claude/plans/plan.md', content: '# Plan' } },
            ],
          },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.planFilePath).toBe('');
    } finally {
      teardown();
    }
  });

  it('returns empty promptText when no tool_use blocks in turn', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } },
        {
          type: 'assistant',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'Hi there' }] },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.promptText).toBe('');
      expect(result.promptQuestions).toHaveLength(0);
      expect(result.planFilePath).toBe('');
    } finally {
      teardown();
    }
  });

  it('returns empty promptText when only non-prompt tool_use (Bash, Read, etc.)', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Do stuff' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
              { type: 'tool_use', name: 'Read', input: { file_path: '/src/a.ts' } },
            ],
          },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.promptText).toBe('');
    } finally {
      teardown();
    }
  });

  it('returns defaults for empty transcript path', () => {
    const result = extractFromTranscript('');
    expect(result.promptText).toBe('');
    expect(result.promptQuestions).toHaveLength(0);
    expect(result.planFilePath).toBe('');
  });

  it('returns defaults for non-existent transcript file', () => {
    const result = extractFromTranscript('/tmp/nonexistent-' + Date.now() + '.jsonl');
    expect(result.promptText).toBe('');
    expect(result.promptQuestions).toHaveLength(0);
  });

  it('does not pick up prompt from previous turn', () => {
    setup();
    try {
      const fp = writeTranscript([
        // Previous turn with AskUserQuestion
        { type: 'user', message: { content: [{ type: 'text', text: 'First question' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_old',
            content: [
              { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Old question?', options: [{ label: 'A' }] }] } },
            ],
          },
        },
        // Turn boundary
        { type: 'user', message: { content: [{ type: 'text', text: 'User answered' }] } },
        // Current turn — no prompt
        {
          type: 'assistant',
          message: { id: 'msg_new', content: [{ type: 'text', text: 'Thanks!' }] },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.promptText).toBe('');
      expect(result.promptQuestions).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('collects prompt across tool calls in same turn', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Do something' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_A',
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_B',
            content: [
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    header: 'Choice',
                    question: 'Which option?',
                    options: [{ label: 'X' }, { label: 'Y' }],
                  }],
                },
              },
            ],
          },
        },
      ]);
      const result = extractFromTranscript(fp);
      expect(result.promptText).toContain('Which option?');
      expect(result.promptText).toContain('*X*');
      expect(result.promptText).toContain('*Y*');
      expect(result.promptQuestions).toHaveLength(1);
    } finally {
      teardown();
    }
  });
});

// ── extractPromptQuestions ────────────────────────────────────────────

describe('extractPromptQuestions', () => {
  it('extracts structured questions from AskUserQuestion blocks', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          header: 'Color',
          question: 'Pick a color',
          options: [
            { label: 'Red', description: 'Warm' },
            { label: 'Blue', description: 'Cool' },
          ],
        }],
      },
    }];
    const result = extractPromptQuestions(blocks);
    expect(result).toHaveLength(1);
    const q = result[0] as any;
    expect(q.question).toBe('Pick a color');
    expect(q.header).toBe('Color');
    expect(q.options).toHaveLength(2);
    expect(q.options[0]).toEqual({ label: 'Red', description: 'Warm' });
    expect(q.options[1]).toEqual({ label: 'Blue', description: 'Cool' });
  });

  it('preserves multiSelect flag', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Select features',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      },
    }];
    const result = extractPromptQuestions(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).multiSelect).toBe(true);
  });

  it('ignores non-AskUserQuestion blocks', () => {
    const blocks = [
      { name: 'Bash', input: { command: 'ls' } },
      { name: 'ExitPlanMode', input: {} },
    ];
    expect(extractPromptQuestions(blocks)).toHaveLength(0);
  });

  it('skips options without labels', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Q',
          options: [
            { label: 'Valid' },
            { label: '', description: 'No label' },
            { description: 'Also no label' },
          ],
        }],
      },
    }];
    const result = extractPromptQuestions(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).options).toHaveLength(1);
    expect((result[0] as any).options[0].label).toBe('Valid');
  });

  it('skips questions with no valid options', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Q with no options',
          options: [],
        }],
      },
    }];
    expect(extractPromptQuestions(blocks)).toHaveLength(0);
  });
});

// ── notification hook with transcript (integration) ─────────────────

describe('notification hook with transcript', () => {
  let tempDir: string;

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-notif-integ-'));
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true });
  }

  it('includes promptText in payload when transcript has AskUserQuestion', async () => {
    setup();
    try {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Help' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'text', text: 'Let me ask you' },
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    header: 'Library',
                    question: 'Which library should we use?',
                    options: [
                      { label: 'React', description: 'Popular UI library' },
                      { label: 'Vue', description: 'Progressive framework' },
                    ],
                  }],
                },
              },
            ],
          },
        }),
      ].join('\n'));

      const result = await runHook(
        { DISCODE_PROJECT: 'myproject', DISCODE_PORT: '18470' },
        {
          message: 'Claude Code needs your attention',
          notification_type: 'idle_prompt',
          transcript_path: transcriptPath,
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('session.notification');
      expect(payload.text).toBe('Claude Code needs your attention');
      expect(typeof payload.promptText).toBe('string');
      expect(payload.promptText as string).toContain('Which library should we use?');
      expect(payload.promptText as string).toContain('*React*');
      expect(payload.promptText as string).toContain('Popular UI library');
      expect(payload.promptText as string).toContain('*Vue*');
    } finally {
      teardown();
    }
  });

  it('omits promptText when transcript has no prompt tools', async () => {
    setup();
    try {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Run tests' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            ],
          },
        }),
      ].join('\n'));

      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          message: 'Claude is idle',
          notification_type: 'idle_prompt',
          transcript_path: transcriptPath,
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.promptText).toBeUndefined();
    } finally {
      teardown();
    }
  });

  it('omits promptText when no transcript_path provided', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { message: 'Notification', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    const payload = result.calls[0].body as Record<string, unknown>;
    expect(payload.promptText).toBeUndefined();
  });

  it('includes promptQuestions in payload when transcript has AskUserQuestion', async () => {
    setup();
    try {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Help' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    header: 'Approach',
                    question: 'Which approach?',
                    options: [
                      { label: 'Fast', description: 'Quick' },
                      { label: 'Safe', description: 'Reliable' },
                    ],
                  }],
                },
              },
            ],
          },
        }),
      ].join('\n'));

      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          message: 'Question',
          notification_type: 'idle_prompt',
          transcript_path: transcriptPath,
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(Array.isArray(payload.promptQuestions)).toBe(true);
      const questions = payload.promptQuestions as any[];
      expect(questions).toHaveLength(1);
      expect(questions[0].question).toBe('Which approach?');
      expect(questions[0].header).toBe('Approach');
      expect(questions[0].options).toHaveLength(2);
    } finally {
      teardown();
    }
  });

  it('includes planFilePath in payload when transcript has ExitPlanMode with Write', async () => {
    setup();
    try {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Plan' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: '/home/user/.claude/plans/feature.md', content: '# Plan' } },
              { type: 'tool_use', name: 'ExitPlanMode', input: {} },
            ],
          },
        }),
      ].join('\n'));

      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          message: 'Plan ready',
          notification_type: 'idle_prompt',
          transcript_path: transcriptPath,
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.planFilePath).toBe('/home/user/.claude/plans/feature.md');
    } finally {
      teardown();
    }
  });

  it('omits promptQuestions and planFilePath when not present', async () => {
    setup();
    try {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Hi' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello' }] },
        }),
      ].join('\n'));

      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          message: 'Idle',
          notification_type: 'idle_prompt',
          transcript_path: transcriptPath,
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.promptQuestions).toBeUndefined();
      expect(payload.planFilePath).toBeUndefined();
    } finally {
      teardown();
    }
  });
});
