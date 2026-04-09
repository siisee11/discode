import type { RuntimeMode } from '../types/index.js';
import type { AgentRuntime } from './interface.js';
import { PtyRustRuntime } from './pty-rust-runtime.js';

export function createRuntimeForMode(_mode: RuntimeMode | undefined, _sessionPrefix: string): AgentRuntime {
  return new PtyRustRuntime();
}
