import { describe, expect, it } from 'vitest';
import { extractSaleData, hasSaleData, missingDataText, saleDataSummary } from './sale-data.js';

describe('13/10/2026: datos del cliente tras el «SÍ»', () => {
  it.each([
    [
      '1000000000 Ana Demo ana@ejemplo.test',
      { document: '1000000000', fullName: 'Ana Demo', email: 'ana@ejemplo.test' },
    ],
    ['3333', { document: '3333' }],
    ['C.C. 1.020.304.050', { document: '1020304050' }],
    ['mi nombre es maría de los ángeles pérez', { fullName: 'María de los Ángeles Pérez' }],
    ['Correo: Ana.Perez@Correo.COM', { email: 'ana.perez@correo.com' }],
    ['cel 3001234567 y cédula 52345678', { phone: '3001234567', document: '52345678' }],
    ['3001234567', { phone: '3001234567' }],
    ['no tengo correo', {}],
    ['ya te lo envié', {}],
    ['Juan Pérez', { fullName: 'Juan Pérez' }],
  ])('«%s»', (text, expected) => {
    expect(extractSaleData(text)).toEqual(expected);
  });

  it('el nombre dicho antes cuenta solo si es completo', () => {
    expect(hasSaleData({ name: 'Ana' }, 'NOMBRE')).toBe(false);
    expect(hasSaleData({ name: 'Ana Pérez' }, 'NOMBRE')).toBe(true);
    expect(hasSaleData({ saleFullName: 'Ana Pérez' }, 'NOMBRE')).toBe(true);
  });

  it('lo que falta se redacta para la plantilla y queda en el resumen de la venta', () => {
    expect(missingDataText(['NOMBRE', 'CORREO'])).toBe(
      'tu nombre completo y tu correo electrónico',
    );
    expect(missingDataText(['CORREO'])).toBe('tu correo electrónico');
    const s = saleDataSummary({ saleDocument: '3333' }, ['DOCUMENTO', 'NOMBRE', 'CORREO']);
    expect(s).toContain('Documento: 3333');
    expect(s).toContain('Faltó: tu nombre completo y tu correo electrónico');
  });
});

describe('D-033: captura del blueprint (nombre, cédula, línea a activar y ciudad)', () => {
  it('la respuesta a la plantilla de captura, renglón por renglón', () => {
    expect(
      extractSaleData(
        'Nombre completo: Ana Demo Prueba\nNúmero de cédula: 1.020.304.050\nLínea activar: 300 123 4567\nCiudad: Bogotá',
      ),
    ).toEqual({
      fullName: 'Ana Demo Prueba',
      document: '1020304050',
      phone: '3001234567',
      city: 'Bogotá',
    });
  });

  it('la ciudad sin etiqueta solo si va sola entre comas o en su renglón', () => {
    expect(extractSaleData('Ana Demo, 52345678, 3001234567, Medellín')).toEqual({
      fullName: 'Ana Demo',
      document: '52345678',
      phone: '3001234567',
      city: 'Medellín',
    });
    expect(extractSaleData('vivo en santa marta')).toEqual({ city: 'Santa Marta' });
    // «Pereira» dentro del nombre es un apellido, no la ciudad.
    expect(extractSaleData('Juan Pereira')).toEqual({ fullName: 'Juan Pereira' });
  });

  it('la ciudad cuenta como dato del flujo y va en el resumen', () => {
    expect(hasSaleData({ saleCity: 'Cali' }, 'CIUDAD')).toBe(true);
    expect(missingDataText(['CIUDAD'])).toBe('la ciudad donde te encuentras');
    expect(saleDataSummary({ saleCity: 'Cali' }, ['CIUDAD'])).toContain('Ciudad: Cali');
  });
});
