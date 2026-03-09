import { existsSync } from 'node:fs';

import type { CodexClient, ThreadOptions } from './codex-client.mts';
import { containsCompletionSignal } from './completion.mts';
import { buildSetupPrompt, type SetupPromptOptions } from './prompts.mts';

export interface RunSetupAgentOptions extends SetupPromptOptions, ThreadOptions {
  client: CodexClient;
  timeoutMs: number;
}

export interface SetupAgentResult {
  threadId: string;
  planPath: string;
  output: string;
}

export async function runSetupAgent(options: RunSetupAgentOptions): Promise<SetupAgentResult> {
  const threadId = await options.client.startThread({
    model: options.model,
    cwd: options.cwd,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
  });

  const prompt = buildSetupPrompt(options);
  const result = await options.client.runTurn(threadId, prompt, options.timeoutMs);
  if (result.status === 'failed') {
    throw new Error(`Setup agent failed${result.codexErrorInfo ? `: ${result.codexErrorInfo}` : ''}`);
  }
  if (!containsCompletionSignal(result.agentText)) {
    throw new Error('Setup agent completed without the required completion token');
  }
  if (!existsSync(options.planPath)) {
    throw new Error(`Setup agent did not create the plan file: ${options.planPath}`);
  }

  return {
    threadId,
    planPath: options.planPath,
    output: result.agentText,
  };
}
