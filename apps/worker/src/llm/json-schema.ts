/**
 * Ajusta el JSON Schema generado por zod a lo que aceptan los modos de salida estructurada
 * de los proveedores: quita `$schema` y restricciones de longitud/patrón que no todos
 * soportan. La validación completa la hace zod después (validador 1), así que no se pierde
 * ninguna regla.
 */
const DROP = new Set(['$schema', 'minLength', 'maxLength', 'pattern', 'format']);

export function providerJsonSchema(schema: unknown): Record<string, unknown> {
  return strip(schema) as Record<string, unknown>;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!DROP.has(k)) out[k] = strip(v);
  }
  return out;
}
