#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CodexClient } from './lib/codex-client.mts';
import { runCodingLoop } from './lib/coding-loop.mts';
import { defaultPlanFilename, slugifyPrompt } from './lib/prompts.mts';
import { runPrAgent } from './lib/pr-agent.mts';
import { runSetupAgent } from './lib/setup-agent.mts';
import { cleanupWorktree, ensureRalphLogPath, initWorktree } from './lib/worktree.mts';

interface CliOptions {
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();

  const worktree = await initWorktree({
    repoRoot,
    baseBranch: options.baseBranch,
    workBranch: options.workBranch,
  });

  const logFile = ensureRalphLogPath(worktree);
  const planPath = resolve(
    worktree.worktree_path,
    'docs/exec-plans/active',
    defaultPlanFilename(options.prompt),
  );

  const sandbox = resolveSandbox(options.sandbox, worktree.worktree_path);
  const turnTimeoutMs = Math.min(options.timeoutSeconds * 1000, 30 * 60 * 1000);

  let setupClient: CodexClient | undefined;
  let codingClient: CodexClient | undefined;
  let prClient: CodexClient | undefined;

  try {
    console.log(`Phase 1/3: setup agent in ${worktree.worktree_path}`);
    setupClient = CodexClient.spawn({ logFile });
    await setupClient.initialize();
    await runSetupAgent({
      client: setupClient,
      model: options.model,
      cwd: worktree.worktree_path,
      approvalPolicy: options.approvalPolicy,
      sandbox,
      timeoutMs: turnTimeoutMs,
      userPrompt: options.prompt,
      planPath,
      worktreePath: worktree.worktree_path,
      worktreeId: worktree.worktree_id,
      workBranch: worktree.work_branch,
      baseBranch: worktree.base_branch,
    });
    setupClient.close();
    setupClient = undefined;

    console.log(`Phase 2/3: coding loop on ${worktree.work_branch}`);
    codingClient = CodexClient.spawn({ logFile });
    await codingClient.initialize();
    const codingThreadId = await codingClient.startThread({
      model: options.model,
      cwd: worktree.worktree_path,
      approvalPolicy: options.approvalPolicy,
      sandbox,
    });
    const codingResult = await runCodingLoop({
      client: codingClient,
      threadId: codingThreadId,
      worktreePath: worktree.worktree_path,
      userPrompt: options.prompt,
      planPath,
      maxIterations: options.maxIterations,
      timeoutMs: turnTimeoutMs,
    });
    if (!codingResult.completed) {
      throw new Error(`Ralph Loop reached ${options.maxIterations} iterations without completion`);
    }
    codingClient.close();
    codingClient = undefined;

    console.log('Phase 3/3: PR agent');
    prClient = CodexClient.spawn({ logFile });
    await prClient.initialize();
    const prOutput = await runPrAgent({
      client: prClient,
      model: options.model,
      cwd: worktree.worktree_path,
      approvalPolicy: options.approvalPolicy,
      sandbox,
      timeoutMs: turnTimeoutMs,
      planPath,
      baseBranch: options.baseBranch,
    });
    prClient.close();
    prClient = undefined;

    console.log('Ralph Loop completed.');
    console.log(prOutput);
  } catch (error) {
    const tail = readTail(logFile, 40);
    throw new Error(`${String(error)}\n\nLast Ralph loop log lines:\n${tail}`);
  } finally {
    setupClient?.close();
    codingClient?.close();
    prClient?.close();
    if (!options.preserveWorktree) {
      await cleanupWorktree(repoRoot, worktree.worktree_path).catch((error) => {
        console.error(`Failed to clean up worktree ${worktree.worktree_path}: ${String(error)}`);
      });
    }
  }
}

function parseArgs(args: string[]): CliOptions {
  const promptParts: string[] = [];
  const options: Omit<CliOptions, 'prompt'> = {
    model: 'gpt-5.3-codex',
    baseBranch: 'main',
    maxIterations: 20,
    workBranch: '',
    timeoutSeconds: 21600,
    approvalPolicy: 'never',
    sandbox: 'workspaceWrite',
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
      default:
        promptParts.push(arg);
        break;
    }
  }

  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    throw new Error('Usage: ralph-loop "<user prompt>" [options]');
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

function resolveSandbox(mode: string, worktreePath: string): string | Record<string, unknown> {
  if (mode === 'workspaceWrite') {
    return {
      type: 'workspaceWrite',
      writableRoots: [worktreePath],
      networkAccess: true,
    };
  }
  return mode;
}

function findRepoRoot(): string {
  if (existsSync(resolve(process.cwd(), '.git'))) {
    return process.cwd();
  }
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

function readTail(path: string, lines: number): string {
  if (!existsSync(path)) {
    return '(no Ralph loop log written)';
  }
  const content = readFileSync(path, 'utf8').trimEnd();
  return content.split('\n').slice(-lines).join('\n');
}

void main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
