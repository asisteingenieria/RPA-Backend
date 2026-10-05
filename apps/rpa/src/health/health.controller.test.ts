import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('responde ok con el estado de la sesión', () => {
    const ctrl = new HealthController({ status: 'ACTIVE' });
    expect(ctrl.health()).toMatchObject({ status: 'ok', service: 'rpa', session: 'ACTIVE' });
  });
});
