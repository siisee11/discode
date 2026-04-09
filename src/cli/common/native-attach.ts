import { spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';
import { createRequire } from 'module';
import chalk from 'chalk';
import { getDefaultRuntimeSocketPath } from './runtime-stream-client.js';

export const NATIVE_ATTACH_FLAG_ENV = 'DISCODE_NATIVE_ATTACH';
export const NATIVE_ATTACH_BIN_ENV = 'DISCODE_RUNTIME_CLIENT_BIN';

export type NativeAttachMode = 'off' | 'on' | 'auto';

const requireForAttach = createRequire(import.meta.url);

export function resolveNativeAttachMode(): NativeAttachMode {
  const raw = process.env[NATIVE_ATTACH_FLAG_ENV]?.trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === '0' || raw === 'false' || raw === 'off') return 'off';
  if (raw === 'auto') return 'auto';
  return 'on';
}

function mapPlatformTag(platform: NodeJS.Platform): 'darwin' | 'linux' | 'windows' | null {
  if (platform === 'darwin' || platform === 'linux') return platform;
  if (platform === 'win32') return 'windows';
  return null;
}

function mapArchTag(arch: string): 'x64' | 'arm64' | null {
  if (arch === 'x64' || arch === 'arm64') return arch;
  return null;
}

function newestExistingPath(candidates: string[]): string | null {
  let selected: string | null = null;
  let newestMtime = -1;

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let mtime = 0;
    try {
      mtime = statSync(candidate).mtimeMs;
    } catch {
      // Keep zero so stat failures do not win over readable files.
    }
    if (selected === null || mtime > newestMtime) {
      selected = candidate;
      newestMtime = mtime;
    }
  }

  return selected;
}

export function resolveNativeAttachBinary(mode: NativeAttachMode): string | null {
  const explicit = process.env[NATIVE_ATTACH_BIN_ENV]?.trim();
  if (explicit) return explicit;

  const binaryName = process.platform === 'win32' ? 'discode-runtime-client.exe' : 'discode-runtime-client';
  const platformTag = mapPlatformTag(process.platform);
  const archTag = mapArchTag(process.arch);

  if (platformTag && archTag) {
    try {
      const pkg = `@siisee11/discode-runtime-client-${platformTag}-${archTag}`;
      const packageJsonPath = requireForAttach.resolve(`${pkg}/package.json`);
      const packageDir = resolve(packageJsonPath, '..');
      const packageBinary = join(packageDir, 'bin', binaryName);
      if (existsSync(packageBinary)) return packageBinary;
    } catch {
      // Continue to filesystem hints.
    }
  }

  const rawHints = [
    process.env.DISCODE_REPO,
    process.cwd(),
    resolve(import.meta.dirname, '..', '..', '..'),
    resolve(import.meta.dirname, '..', '..', '..', '..'),
  ].filter((value): value is string => !!value && value.length > 0);
  const repoHints = [...new Set(rawHints.map((value) => resolve(value)))];

  for (const root of repoHints) {
    const repoBuildCandidates = [
      resolve(root, 'runtime-client-rs', 'target', 'debug', binaryName),
      resolve(root, 'runtime-client-rs', 'target', 'release', binaryName),
      ...(platformTag && archTag
        ? [resolve(
          root,
          'dist',
          'release',
          'runtime-client',
          `discode-runtime-client-${platformTag}-${archTag}`,
          'bin',
          binaryName,
        )]
        : []),
      ...(platformTag && archTag
        ? [resolve(
          root,
          'node_modules',
          `@siisee11/discode-runtime-client-${platformTag}-${archTag}`,
          'bin',
          binaryName,
        )]
        : []),
    ];

    const repoBinary = newestExistingPath(repoBuildCandidates);
    if (repoBinary) return repoBinary;
  }

  const homeCandidates = [
    resolve(homedir(), '.discode', 'bin', binaryName),
    ...(platformTag && archTag
      ? [join(homedir(), '.discode', 'bin', 'runtime-client', `${platformTag}-${archTag}`, binaryName)]
      : []),
  ];

  for (const candidate of homeCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  if (mode === 'on') {
    return 'discode-runtime-client';
  }
  return null;
}

export function tryNativeAttach(windowId: string, mode: NativeAttachMode, port: number): boolean {
  if (mode === 'off') return false;

  const binary = resolveNativeAttachBinary(mode);
  if (!binary) return false;

  const runtimeSocket = getDefaultRuntimeSocketPath();
  const result = spawnSync(
    binary,
    ['--socket', runtimeSocket, '--window-id', windowId, '--daemon-port', String(port)],
    { stdio: 'inherit' },
  );

  if (result.error) {
    if (mode === 'on') {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      console.log(chalk.yellow(`⚠️ Native attach unavailable (${message}).`));
    }
    return false;
  }

  if (result.status === 0) return true;
  if (mode === 'on') {
    console.log(chalk.yellow(`⚠️ Native attach exited with status ${result.status ?? 'unknown'}.`));
  }
  return false;
}
