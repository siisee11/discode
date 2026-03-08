import { execFileSync } from 'node:child_process';

import type { CodexClient } from './codex-client.mts';
import { containsCompletionSignal } from './completion.mts';
import { buildCodingPrompt, buildRecoveryPrompt } from './prompts.mts';

export interface CodingLoopOptions {
  client: CodexClient;
  threadId: string;
  worktreePath: string;
  userPrompt: string;
  planPath: string;
  maxIterations: number;
  timeoutMs: number;
}

export interface CodingLoopResult {
  iterations: number;
  completed: boolean;
  finalHead: string | null;
}

export async function runCodingLoop(options: CodingLoopOptions): Promise<CodingLoopResult> {
  let iterations = 0;
  let completed = false;
  let nextPrompt = buildCodingPrompt({
    userPrompt: options.userPrompt,
    planPath: options.planPath,
  });

  for (; iterations < options.maxIterations; iterations += 1) {
    const previousHead = currentHead(options.worktreePath);
    const result = await options.client.runTurn(
      options.threadId,
      nextPrompt,
      options.timeoutMs,
    );

    if (result.status === 'failed') {
      if (result.codexErrorInfo === 'ContextWindowExceeded') {
        await options.client.compactThread(options.threadId);
      }
      nextPrompt = buildRecoveryPrompt(options.planPath);
      continue;
    }

    const updatedHead = currentHead(options.worktreePath);
    if (previousHead === updatedHead) {
      console.warn(`Ralph Loop warning: iteration ${iterations + 1} did not create a new commit.`);
    }

    if (containsCompletionSignal(result.agentText)) {
      completed = true;
      break;
    }

    nextPrompt = buildCodingPrompt({
      userPrompt: options.userPrompt,
      planPath: options.planPath,
    });
  }

  return {
    iterations: iterations + (completed ? 1 : 0),
    completed,
    finalHead: currentHead(options.worktreePath),
  };
}

function currentHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
