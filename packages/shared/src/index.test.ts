import { describe, it, expect } from 'vitest';
import { PLAYROOM_VERSION } from './index.js';

describe('@playroom/shared', () => {
  it('exposes the version string', () => {
    expect(PLAYROOM_VERSION).toBe('0.0.1');
  });
});
