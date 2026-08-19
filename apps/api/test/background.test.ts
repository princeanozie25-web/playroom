import { describe, expect, it, vi } from 'vitest';
import { BackgroundWork } from '../src/background.js';

describe('BackgroundWork lifecycle ownership', () => {
  it('drains work that was accepted before shutdown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;
    const failures: unknown[] = [];
    const work = new BackgroundWork((_label, error) => failures.push(error));

    expect(
      work.run('summary', async () => {
        await gate;
        completed = true;
      }),
    ).toBe(true);
    work.stop();
    const draining = work.drain(1_000);
    await Promise.resolve();
    expect(completed).toBe(false);
    release();

    await expect(draining).resolves.toBe(true);
    expect(completed).toBe(true);
    expect(work.size).toBe(0);
    expect(failures).toEqual([]);
  });

  it('does not start new work after shutdown begins', async () => {
    const task = vi.fn(async () => undefined);
    const work = new BackgroundWork(() => undefined);
    work.stop();

    expect(work.run('late query', task)).toBe(false);
    expect(task).not.toHaveBeenCalled();
    await expect(work.drain(50)).resolves.toBe(true);
  });

  it('surfaces a task failure and still drains deterministically', async () => {
    const failures: Array<{ label: string; error: unknown }> = [];
    const work = new BackgroundWork((label, error) => failures.push({ label, error }));
    const failure = new Error('summary failed');
    work.run('summary', async () => {
      throw failure;
    });
    work.stop();

    await expect(work.drain(1_000)).resolves.toBe(true);
    expect(failures).toEqual([{ label: 'summary', error: failure }]);
  });

  it('drains an already-started event-source promise before shutdown', async () => {
    const work = new BackgroundWork(() => undefined);
    let release!: () => void;
    const task = new Promise<void>((resolve) => {
      release = resolve;
    });

    work.own('socket frame', task);
    work.stop();
    expect(work.size).toBe(1);
    release();
    await expect(work.drain(100)).resolves.toBe(true);
    expect(work.size).toBe(0);
  });
});
