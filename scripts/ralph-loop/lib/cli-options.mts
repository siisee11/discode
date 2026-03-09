import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { slugifyPrompt } from './prompts.mts';

export interface CliOptions {
  prompt: string;
  model: string;
  baseBranch: string;
  maxIterations: number;
  workBranch: string;
  timeoutSeconds: number;
  approvalPolicy: string;
  sandbox: string;
  preserveWorktree: boolean;
}

export function parseArgs(args: string[], repoRoot: string): CliOptions {
  const promptParts: string[] = [];
  let usePrd = false;
  const options: Omit<CliOptions, 'prompt' | 'workBranch'> & { workBranch: string } = {
    model: 'gpt-5.3-codex',
    baseBranch: 'main',
    maxIterations: 20,
    workBranch: '',
    timeoutSeconds: 21600,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    preserveWorktree: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--model':
        options.model = requireValue(args, ++index, '--model');
        break;
      case '--base-branch':
        options.baseBranch = requireValue(args, ++index, '--base-branch');
        break;
      case '--max-iterations':
        options.maxIterations = Number.parseInt(requireValue(args, ++index, '--max-iterations'), 10);
        break;
      case '--work-branch':
        options.workBranch = requireValue(args, ++index, '--work-branch');
        break;
      case '--timeout':
        options.timeoutSeconds = Number.parseInt(requireValue(args, ++index, '--timeout'), 10);
        break;
      case '--approval-policy':
        options.approvalPolicy = requireValue(args, ++index, '--approval-policy');
        break;
      case '--sandbox':
        options.sandbox = requireValue(args, ++index, '--sandbox');
        break;
      case '--preserve-worktree':
        options.preserveWorktree = true;
        break;
      case '--prd':
        usePrd = true;
        break;
      default:
        promptParts.push(arg);
        break;
    }
  }

  if (usePrd && promptParts.length > 0) {
    throw new Error('Use either a positional prompt or --prd, not both');
  }

  const prompt = usePrd ? readPromptFromPrd(repoRoot) : promptParts.join(' ').trim();
  if (!prompt) {
    throw new Error('Usage: ralph-loop "<user prompt>" [options]\n       ralph-loop --prd [options]');
  }

  return {
    prompt,
    ...options,
    workBranch: options.workBranch || `ralph/${slugifyPrompt(prompt).slice(0, 48)}`,
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function readPromptFromPrd(repoRoot: string): string {
  const prdPath = resolve(repoRoot, 'PRD.md');
  if (!existsSync(prdPath)) {
    throw new Error(`PRD file not found: ${prdPath}`);
  }
  const prompt = readFileSync(prdPath, 'utf8').trim();
  writeFileSync(prdPath, '');
  if (!prompt) {
    throw new Error(`PRD file is empty: ${prdPath}`);
  }
  return prompt;
}
