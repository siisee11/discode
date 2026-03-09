import type { CodexClient, ThreadOptions } from './codex-client.mts';
import { containsCompletionSignal } from './completion.mts';
import { buildPrPrompt, type PrPromptOptions } from './prompts.mts';

export interface RunPrAgentOptions extends PrPromptOptions, ThreadOptions {
  client: CodexClient;
  timeoutMs: number;
}

export async function runPrAgent(options: RunPrAgentOptions): Promise<string> {
  const threadId = await options.client.startThread({
    model: options.model,
    cwd: options.cwd,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
  });
  const result = await options.client.runTurn(
    threadId,
    buildPrPrompt(options),
    options.timeoutMs,
  );
  if (result.status === 'failed') {
    throw new Error(`PR agent failed${result.codexErrorInfo ? `: ${result.codexErrorInfo}` : ''}`);
  }
  if (!containsCompletionSignal(result.agentText)) {
    throw new Error('PR agent completed without the required completion token');
  }
  return result.agentText;
}
