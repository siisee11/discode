import type { RuntimeMode } from '../types/index.js';

export type RuntimeModeInput = RuntimeMode;

export function normalizeRuntimeMode(_value: unknown): RuntimeMode {
  return 'pty-rust';
}

export function parseRuntimeModeInput(value: unknown): RuntimeMode | undefined {
  if (value === 'pty-rust') return 'pty-rust';
  return undefined;
}

export function isPtyRuntimeMode(mode: RuntimeModeInput | undefined): boolean {
  return normalizeRuntimeMode(mode) === 'pty-rust';
}
