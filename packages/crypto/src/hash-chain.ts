import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Serialización canónica (claves ordenadas) para que el hash sea estable. */
export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function chainHash(prevHash: string, record: unknown): string {
  return sha256(`${prevHash}|${canonicalJson(record)}`);
}

export interface ChainedRecord<T> {
  data: T;
  prevHash: string;
  hash: string;
}

export function appendToChain<T>(prevHash: string, data: T): ChainedRecord<T> {
  return { data, prevHash, hash: chainHash(prevHash, data) };
}

/** Devuelve el índice del primer registro roto, o -1 si la cadena es íntegra. */
export function verifyChain<T>(records: ChainedRecord<T>[], genesis = GENESIS_HASH): number {
  let prev = genesis;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.prevHash !== prev || r.hash !== chainHash(r.prevHash, r.data)) return i;
    prev = r.hash;
  }
  return -1;
}
