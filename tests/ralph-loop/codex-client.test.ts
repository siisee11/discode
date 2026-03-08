import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { CodexClient, type ChildProcessLike } from '../../scripts/ralph-loop/lib/codex-client.mts';

class FakeChild extends EventEmitter implements ChildProcessLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    this.emit('close', 0);
    return true;
  }
}

describe('codex client', () => {
  it('resolves JSON-RPC requests from stdout responses', async () => {
    const child = new FakeChild();
    const client = new CodexClient(child);

    const requestPromise = client.startThread({
      model: 'gpt-5.3-codex',
      cwd: '/tmp/repo',
      approvalPolicy: 'never',
      sandbox: 'workspaceWrite',
    });

    const written = child.stdin.read()?.toString() ?? await readOnce(child.stdin);
    const request = JSON.parse(written.trim()) as { id: number };
    child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: 'thr_123' } } })}\n`);

    await expect(requestPromise).resolves.toBe('thr_123');
    client.close();
  });

  it('collects agent message text until turn completion', async () => {
    const child = new FakeChild();
    const client = new CodexClient(child);

    const turnPromise = client.runTurn('thr_123', 'hello', 5_000);

    const request = JSON.parse((await readOnce(child.stdin)).trim()) as { id: number };
    child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: 'turn_456' } } })}\n`);
    child.stdout.write(`${JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          text: 'iteration output',
        },
      },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      method: 'turn/completed',
      params: {
        turn: { id: 'turn_456' },
        status: 'completed',
      },
    })}\n`);

    await expect(turnPromise).resolves.toMatchObject({
      status: 'completed',
      turnId: 'turn_456',
      agentText: 'iteration output',
    });
    client.close();
  });
});

async function readOnce(stream: PassThrough): Promise<string> {
  const immediate = stream.read();
  if (immediate) {
    return immediate.toString();
  }
  return new Promise((resolve) => {
    stream.once('data', (chunk) => resolve(chunk.toString()));
  });
}
