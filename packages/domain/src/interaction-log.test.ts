import { describe, expect, it } from 'vitest';
import { storedFlow } from './agent-flow.js';
import { interactionRows, maskPhone, stepsForTurn, stepsFromStages } from './interaction-log.js';

const T0 = new Date('2026-11-12T15:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const base = {
  id: 'c1',
  abayaChatId: 'CH-1',
  robotUser: 'robot',
  startedAt: T0,
  endedAt: at(10),
  closeTag: null,
};

describe('D-045: pasos por turno', () => {
  it('entrar a un estado deja su paso; el menú no es un paso', () => {
    expect(
      stepsForTurn({ from: 'MENU', to: 'PERFIL', secondReadingShown: false, dataRequested: false }),
    ).toEqual([{ step: 'PERFILAMIENTO' }]);
    expect(
      stepsForTurn({
        from: 'PERFIL',
        to: 'PERFIL',
        secondReadingShown: false,
        dataRequested: false,
      }),
    ).toEqual([]);
    expect(
      stepsForTurn({ from: 'PERFIL', to: 'MENU', secondReadingShown: false, dataRequested: false }),
    ).toEqual([]);
  });

  it('lecturas de tratamiento de datos, rechazo y captura de datos', () => {
    expect(
      stepsForTurn({
        from: 'OFERTA',
        to: 'AUTORIZACION',
        secondReadingShown: false,
        dataRequested: false,
      }),
    ).toEqual([{ step: 'LECTURA_DATOS', detail: '1' }]);
    expect(
      stepsForTurn({
        from: 'AUTORIZACION',
        to: 'AUTORIZACION',
        secondReadingShown: true,
        dataRequested: false,
      }),
    ).toEqual([{ step: 'LECTURA_DATOS', detail: '2' }]);
    expect(
      stepsForTurn({
        from: 'AUTORIZACION',
        to: 'AUTORIZACION',
        secondReadingShown: false,
        dataRequested: true,
      }),
    ).toEqual([{ step: 'CAPTURA_DATOS' }]);
    expect(
      stepsForTurn({
        from: 'AUTORIZACION',
        to: 'AUTORIZACION',
        secondReadingShown: false,
        dataRequested: false,
        declinedReading: 2,
      }),
    ).toEqual([{ step: 'LECTURA_DATOS', result: 'RECHAZO', detail: '2' }]);
  });
});

describe('D-045: filas del log', () => {
  it('venta: cada paso EXITOSO, línea enmascarada y destino el backoffice', () => {
    const rows = interactionRows({
      ...base,
      status: 'TRANSFERRED_BACKOFFICE',
      phone: '+57 300 123 4567',
      steps: [
        { step: 'PERFILAMIENTO', result: null, detail: null, at: at(1) },
        { step: 'OFERTA', result: null, detail: null, at: at(2) },
        { step: 'LECTURA_DATOS', result: null, detail: '1', at: at(3) },
        { step: 'CAPTURA_DATOS', result: null, detail: null, at: at(4) },
        { step: 'TRANSFERENCIA', result: null, detail: null, at: at(5) },
      ],
    });
    expect(rows.map((r) => [r.step, r.result])).toEqual([
      ['SALUDO', 'EXITOSO'],
      ['PERFILAMIENTO', 'EXITOSO'],
      ['OFERTA', 'EXITOSO'],
      ['LECTURA_DATOS', 'EXITOSO'],
      ['CAPTURA_DATOS', 'EXITOSO'],
      ['TRANSFERENCIA', 'EXITOSO'],
    ]);
    expect(rows[0]!.maskedLine).toBe('300****567');
    expect(rows[0]!.destination).toContain('backoffice');
    expect(JSON.stringify(rows)).not.toContain('1234567');
  });

  it('no autorizó: la lectura queda RECHAZO (sin fila extra); abandono por inactividad', () => {
    const rows = interactionRows({
      ...base,
      status: 'CLOSED_INACTIVE',
      steps: [
        { step: 'OFERTA', result: null, detail: null, at: at(1) },
        { step: 'LECTURA_DATOS', result: null, detail: '1', at: at(2) },
        { step: 'LECTURA_DATOS', result: 'RECHAZO', detail: '1', at: at(3) },
      ],
    });
    expect(rows.map((r) => [r.step, r.result])).toEqual([
      ['SALUDO', 'EXITOSO'],
      ['OFERTA', 'EXITOSO'],
      ['LECTURA_DATOS', 'RECHAZO'],
    ]);
    const idle = interactionRows({ ...base, status: 'CLOSED_INACTIVE', steps: [] });
    expect(idle.map((r) => r.result)).toEqual(['ABANDONO']);
  });

  it('resultado del último paso según el estado final', () => {
    const last = (status: string, closeTag: string | null = null) =>
      interactionRows({ ...base, status, closeTag, steps: [] }).at(-1)!.result;
    expect(last('NEEDS_REVIEW')).toBe('ERROR');
    expect(last('CLOSED_NO_SALE', 'NO_VENTA_ABANDONA')).toBe('ABANDONO');
    expect(last('CLOSED_NO_SALE', 'NO_VENTA_PREFIERE_PREPAGO')).toBe('EXITOSO');
    expect(last('CLOSED_EXTERNALLY')).toBe('CERRADA_EN_AVAYA');
    expect(last('ACTIVE')).toBe('EN_CURSO');
  });

  it('conversaciones anteriores: pasos desde los estados de las llamadas al modelo', () => {
    expect(
      stepsFromStages([
        { stage: 'PERFIL', at: at(1) },
        { stage: 'PERFIL', at: at(2) },
        { stage: 'OFERTA', at: at(3) },
      ]).map((s) => s.step),
    ).toEqual(['PERFILAMIENTO', 'OFERTA']);
  });

  it('enmascara la línea; sin número suficiente queda vacía', () => {
    expect(maskPhone('3001234567')).toBe('300****567');
    expect(maskPhone('573001234567')).toBe('300****567');
    expect(maskPhone('123')).toBe('');
    expect(maskPhone(undefined)).toBe('');
  });
});

describe('D-044: lecturas del tratamiento de datos en el flujo', () => {
  it('versiones anteriores: una lectura; solo acepta 1 o 2', () => {
    expect(storedFlow({}).consentReadings).toBe(1);
    expect(storedFlow({ consentReadings: 2 }).consentReadings).toBe(2);
    expect(storedFlow({ consentReadings: 3 }).consentReadings).toBe(1);
    expect(storedFlow({ consentReadings: '2' }).consentReadings).toBe(1);
  });
});
