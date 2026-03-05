/**
 * Unit tests for the Claude Code stop-hook script.
 *
 * The hook is a CJS script (not a module), so we load it into a VM
 * context and extract the pure functions for testing.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dir, '../../src/claude/plugin/scripts');
const hookPath = join(scriptsDir, 'discode-stop-hook.js');

type ExtractTextBlocksFn = (node: unknown, depth?: number) => string[];
type ExtractThinkingBlocksFn = (node: unknown, depth?: number) => string[];
type ExtractToolUseBlocksFn = (node: unknown, depth?: number) => Array<{ name: string; input: Record<string, unknown> }>;
type FormatPromptTextFn = (toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }>) => string;
type ReadAssistantEntryFn = (entry: unknown) => { messageId: string; text: string; thinking: string; toolUse: Array<{ name: string; input: Record<string, unknown> }> } | null;
type ParseTurnTextsFn = (tail: string) => { displayText: string; intermediateText: string; turnText: string; thinking: string; promptText: string };
type ReadTailFn = (filePath: string, maxBytes: number) => string;

function loadLib() {
  const realFs = require('fs');
  const libSrc = readFileSync(join(scriptsDir, 'discode-hook-lib.js'), 'utf-8');
  const libMod = { exports: {} as any };
  new Script(libSrc, { filename: 'discode-hook-lib.js' }).runInContext(createContext({
    require: (m: string) => m === 'fs' ? realFs : {},
    module: libMod, exports: libMod.exports,
    process: { env: {} },
    Buffer, Promise, setTimeout, JSON, Array, Object, Math, Number, String, parseInt, parseFloat,
  }));
  return libMod.exports;
}

function loadHookFunctions() {
  const raw = readFileSync(hookPath, 'utf-8');
  // Strip the self-executing main() so it doesn't run
  const src = raw.replace(/main\(\)\.catch[\s\S]*$/, '');

  const realFs = require('fs');
  const lib = loadLib();
  const ctx = createContext({
    require: (mod: string) => {
      if (mod === 'fs') return realFs;
      if (mod === './discode-hook-lib.js' || mod === './discode-hook-lib') return lib;
      return {};
    },
    process: { env: {}, stdin: { isTTY: true } },
    console: { error: () => {} },
    Promise,
    setTimeout,
    Buffer,
    fetch: async () => ({}),
    JSON,
    Array,
    Object,
    Math,
    Number,
    String,
    parseInt,
    parseFloat,
  });

  new Script(src, { filename: 'discode-stop-hook.js' }).runInContext(ctx);

  return {
    extractTextBlocks: (ctx as any).extractTextBlocks as ExtractTextBlocksFn,
    extractThinkingBlocks: (ctx as any).extractThinkingBlocks as ExtractThinkingBlocksFn,
    extractToolUseBlocks: (ctx as any).extractToolUseBlocks as ExtractToolUseBlocksFn,
    formatPromptText: (ctx as any).formatPromptText as FormatPromptTextFn,
    readAssistantEntry: (ctx as any).readAssistantEntry as ReadAssistantEntryFn,
    parseTurnTexts: (ctx as any).parseTurnTexts as ParseTurnTextsFn,
    readTail: (ctx as any).readTail as ReadTailFn,
  };
}

const { parseTurnTexts } = loadHookFunctions();

describe('parseTurnTexts', () => {
  function line(obj: unknown): string {
    return JSON.stringify(obj);
  }

  it('returns empty for null/empty input', () => {
    expect(parseTurnTexts('')).toEqual({ displayText: '', intermediateText: '', turnText: '', thinking: '', promptText: '', promptQuestions: [], planFilePath: '' });
    expect(parseTurnTexts(null as any)).toEqual({ displayText: '', intermediateText: '', turnText: '', thinking: '', promptText: '', promptQuestions: [], planFilePath: '' });
  });

  it('extracts text from single assistant entry', () => {
    const tail = line({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Done!' }] },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Done!');
    expect(result.turnText).toBe('Done!');
  });

  it('combines multiple entries with same messageId', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Part 1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Part 2' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Part 1\nPart 2');
    expect(result.turnText).toBe('Part 1\nPart 2');
  });

  it('uses latest messageId for displayText but all for turnText', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'First thinking' }] } }),
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Final answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Final answer');
    expect(result.turnText).toBe('First thinking\nFinal answer');
    expect(result.intermediateText).toBe('First thinking');
  });

  it('returns intermediateText from earlier messageIds (before tool calls)', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: '현재 분석 인프라를 파악하겠습니다.' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Task', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: '분석 결과입니다.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('분석 결과입니다.');
    expect(result.intermediateText).toBe('현재 분석 인프라를 파악하겠습니다.');
  });

  it('returns empty intermediateText when only one messageId has text', () => {
    const tail = line({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Only response' }] },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Only response');
    expect(result.intermediateText).toBe('');
  });

  it('collects intermediateText from multiple earlier messageIds', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'Step 1 narration' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Step 2 narration' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'text', text: 'Final result' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Final result');
    expect(result.intermediateText).toBe('Step 1 narration\nStep 2 narration');
  });

  it('does not include intermediateText from previous turn', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Old narration' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'New question' }] } }),
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'New answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('New answer');
    expect(result.intermediateText).toBe('');
  });

  it('intermediateText is empty when only tool_use (no text) in earlier messages', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Result' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Result');
    expect(result.intermediateText).toBe('');
  });

  it('intermediateText with whitespace-only earlier message is empty', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: '   \n  ' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Done' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Done');
    // Whitespace-only text is not extracted by extractTextBlocks, so intermediateText should be empty
    expect(result.intermediateText).toBe('');
  });

  it('intermediateText with unicode and special characters preserved', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: '코드를 분석하겠습니다 🔍' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: '결과입니다' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.intermediateText).toBe('코드를 분석하겠습니다 🔍');
  });

  it('intermediateText preserves order of multiple earlier messages across tool calls', () => {
    // msg_A: text1 + tool → msg_B: text2 + tool → msg_C: final
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'First' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Second' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'text', text: 'Third' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'tool_use', id: 'tu_3', name: 'Edit', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3' }] } }),
      line({ type: 'assistant', message: { id: 'msg_D', content: [{ type: 'text', text: 'Final' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Final');
    expect(result.intermediateText).toBe('First\nSecond\nThird');
  });

  it('stops at user message with text content', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Old question' }] } }),
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Old answer' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'New question' }] } }),
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'New answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    // Should only see text after the last real user message
    expect(result.displayText).toBe('New answer');
    expect(result.turnText).toBe('New answer');
  });

  it('skips tool_result user entries (continues scanning)', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Run tests' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Running...' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Tests passed!' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    // tool_result is skipped, turn boundary is "Run tests"
    expect(result.displayText).toBe('Running...\nTests passed!');
    expect(result.turnText).toBe('Running...\nTests passed!');
  });

  it('skips system-injected Skill context messages (not a turn boundary)', () => {
    const tail = [
      // Real user prompt
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Check the repo' }] } }),
      // Intermediate text before tool calls
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: '먼저 레포지토리 정보를 조사하겠습니다.' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      // Claude uses Skill tool
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: '스킬을 사용하겠습니다.' }] } }),
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'blog-writer' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      // System-injected Skill context — should be SKIPPED, not a turn boundary
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Base directory for this skill: /Users/gui/.claude/skills/blog-writer\n\n# Blog Writer' }] } }),
      // Claude continues after Skill context
      line({ type: 'assistant', message: { id: 'msg_3', content: [{ type: 'text', text: '글을 작성하겠습니다.' }] } }),
      line({ type: 'assistant', message: { id: 'msg_3', content: [{ type: 'tool_use', name: 'Write', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3' }] } }),
      // Final response
      line({ type: 'assistant', message: { id: 'msg_4', content: [{ type: 'text', text: '작성 완료했습니다.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    // displayText = final response (latestMessageId)
    expect(result.displayText).toBe('작성 완료했습니다.');
    // intermediateText should include ALL intermediate text, including text BEFORE the Skill injection
    expect(result.intermediateText).toContain('먼저 레포지토리 정보를 조사하겠습니다.');
    expect(result.intermediateText).toContain('스킬을 사용하겠습니다.');
    expect(result.intermediateText).toContain('글을 작성하겠습니다.');
  });

  it('skips [Request interrupted by user] messages (not a turn boundary)', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Do something' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Working on it...' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Resumed and done.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Resumed and done.');
    expect(result.intermediateText).toBe('Working on it...');
  });

  it('skips <system-reminder> messages (not a turn boundary)', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Help me' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'First I will check.' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>Some context info</system-reminder>' }] } }),
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Here is the result.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Here is the result.');
    expect(result.intermediateText).toBe('First I will check.');
  });

  it('skips auto-compact continuation messages (not a turn boundary)', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Fix the bug' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Investigating...' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context.' }] } }),
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Bug fixed.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Bug fixed.');
    expect(result.intermediateText).toBe('Investigating...');
  });

  it('still stops at genuine user prompt after Skill context', () => {
    const tail = [
      // Previous turn (should not be included)
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Old response' }] } }),
      // Real user prompt — this IS a turn boundary
      line({ type: 'user', message: { content: [{ type: 'text', text: 'New question' }] } }),
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'New answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('New answer');
    expect(result.turnText).toBe('New answer');
    // Old response should NOT appear
    expect(result.intermediateText).toBe('');
  });

  it('skips progress and system entries', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Working...' }] } }),
      line({ type: 'progress', data: { percent: 50 } }),
      line({ type: 'system', message: 'rate limit' }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Done!' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Working...\nDone!');
    expect(result.turnText).toBe('Working...\nDone!');
  });

  it('handles malformed JSON lines gracefully', () => {
    const tail = [
      'not json at all',
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Valid' }] } }),
      '{ broken json',
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Valid');
  });

  it('returns empty when no assistant entries found', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('');
    expect(result.turnText).toBe('');
  });

  it('handles trailing empty lines', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Answer' }] } }),
      '',
      '',
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Answer');
  });

  it('stops at user message with mixed system-reminder and real text blocks', () => {
    // Claude Code often wraps user messages with <system-reminder> tags in
    // separate content blocks. The turn boundary detection must check each
    // text block individually — if ANY block is real user text, it's a boundary.
    const tail = [
      // Previous turn (should NOT be included)
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Previous question' }] } }),
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Previous answer with details' }] } }),
      // Current turn — user message has BOTH system-reminder AND real text
      line({ type: 'user', message: { content: [
        { type: 'text', text: '<system-reminder>gitStatus: clean</system-reminder>' },
        { type: 'text', text: '다시 보내줘' },
      ] } }),
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'Done!' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Done!');
    expect(result.turnText).toBe('Done!');
    // Previous turn text should NOT leak into intermediate
    expect(result.intermediateText).toBe('');
  });

  it('stops at user message with string content (not array of blocks)', () => {
    // Claude Code may store message.content as a plain string instead of
    // an array of content blocks. This must still act as a turn boundary.
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Previous response' }] } }),
      line({ type: 'user', message: { role: 'user', content: 'git status 확인' } }),
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'Here is the status' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Here is the status');
    expect(result.turnText).toBe('Here is the status');
    expect(result.intermediateText).toBe('');
  });

  it('stops at string-content user message with intermediate text in current turn', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_prev', content: [{ type: 'text', text: 'Old answer' }] } }),
      line({ type: 'user', message: { role: 'user', content: '빌드해줘' } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'Building...' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Build complete' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Build complete');
    expect(result.intermediateText).toBe('Building...');
    // Previous turn text must NOT leak
    expect(result.turnText).not.toContain('Old answer');
  });

  it('skips system-injected string-content user message', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Previous' }] } }),
      line({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } }),
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'Continuing...' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    // Continuation message is system-injected — scanner should pass through it
    expect(result.displayText).toBe('Continuing...');
    expect(result.intermediateText).toBe('Previous');
  });


  it('handles assistant entry without messageId', () => {
    const tail = line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'No ID entry' }] },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('No ID entry');
    expect(result.turnText).toBe('No ID entry');
  });
});
