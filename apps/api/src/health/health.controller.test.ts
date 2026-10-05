import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('responde ok', () => {
    expect(new HealthController().health()).toMatchObject({ status: 'ok', service: 'api' });
  });
});
