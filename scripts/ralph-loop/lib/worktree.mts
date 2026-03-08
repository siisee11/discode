import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface InitWorktreeOptions {
  repoRoot: string;
  baseBranch: string;
  workBranch: string;
}

export interface WorktreeInitMetadata {
  worktree_id: string;
  worktree_path: string;
  work_branch: string;
  base_branch: string;
  deps_installed: boolean;
  build_verified: boolean;
  runtime_root: string;
}

export async function initWorktree(options: InitWorktreeOptions): Promise<WorktreeInitMetadata> {
  const scriptPath = resolve(options.repoRoot, 'scripts/harness/init.sh');
  const result = await runProcess(scriptPath, [
    '--base-branch',
    options.baseBranch,
    '--work-branch',
    options.workBranch,
  ], {
    cwd: options.repoRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `init.sh failed with exit code ${result.exitCode}`);
  }

  try {
    return JSON.parse(result.stdout) as WorktreeInitMetadata;
  } catch (error) {
    throw new Error(`Failed to parse init.sh output as JSON: ${String(error)}`);
  }
}

export function resolveRuntimeRoot(worktree: WorktreeInitMetadata): string {
  return resolve(worktree.worktree_path, worktree.runtime_root);
}

export function ensureRalphLogPath(worktree: WorktreeInitMetadata): string {
  const logPath = resolve(resolveRuntimeRoot(worktree), 'logs/ralph-loop.log');
  mkdirSync(dirname(logPath), { recursive: true });
  return logPath;
}

export async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  if (resolve(repoRoot) === resolve(worktreePath)) {
    return;
  }

  const result = await runProcess(
    'git',
    ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath],
    { cwd: repoRoot },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Failed to remove worktree ${worktreePath}`);
  }
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
