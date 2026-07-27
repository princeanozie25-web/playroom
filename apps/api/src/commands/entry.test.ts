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

describe('the summon constructor (S05b-2)', () => {
  // Extracting the constructor added a way to REACH it: anything holding deps.execute can
  // now dispatch { kind: 'summon' }, where before the only path ran downstream of
  // summonRuling and could not name an agent. root_is_human: true would then be a
  // hardcoded claim behind an open door. These assert the door is shut, and — the part
  // that matters — that it shuts BEFORE any row is written, not after.
  function stubDeps() {
    const query = vi.fn(() => {
      throw new Error('Postgres was touched');
    });
    const warn = vi.fn();
    const deps = {
      pool: { query },
      bus: {
        publish() {
          throw new Error('published');
        },
        subscribe: () => () => {},
      },
      log: { info: vi.fn(), warn, error: vi.fn() },
      adapterFactory: () => {
        throw new Error('adapter constructed');
      },
      execute: vi.fn(() => Promise.resolve()),
    } as unknown as CommandDeps;
    return { deps, query, warn, execute: deps.execute as unknown as ReturnType<typeof vi.fn> };
  }

  it('refuses an AGENT as the root of a summon, before touching Postgres', async () => {
    const { deps, query, warn, execute } = stubDeps();
    await executeCommand(
      { actorId: 'claude-main', mode: 'hosted' },
      { kind: 'summon', roomId: 'r', member: 'sol', causeSeq: 1, intent: '@sol hello' },
      deps,
    );
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled(); // and no turn was triggered
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ requested_by: 'claude-main', member: 'sol' }),
      'summon refused: only a human may root a summon',
    );
  });

  it('refuses `system` as the root of a summon', async () => {
    const { deps, query, warn } = stubDeps();
    await executeCommand(
      { actorId: 'system', mode: 'system' },
      { kind: 'summon', roomId: 'r', member: 'claude-main', causeSeq: 1, intent: '@claude hello' },
      deps,
    );
    expect(query).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
