import { describe, expect, it, vi } from 'vitest';
import { CommandError, executeCommand, type CommandDeps } from './index.js';

describe('executeCommand entry', () => {
  it('rejects an empty actorId before touching Postgres', async () => {
    const query = vi.fn(() => {
      throw new Error('Postgres was touched');
    });
    const deps = {
      pool: { query },
      bus: { publish() {}, subscribe: () => () => {} },
      adapterFactory: () => {
        throw new Error('adapter constructed');
      },
      execute: () => Promise.resolve(),
    } as unknown as CommandDeps;

    await expect(
      executeCommand(
        { actorId: '', mode: 'human' },
        { kind: 'postMessage', roomId: 'r', clientMsgId: 'c', body: 'b' },
        deps,
      ),
    ).rejects.toBeInstanceOf(CommandError);
    expect(query).not.toHaveBeenCalled();
  });
});
