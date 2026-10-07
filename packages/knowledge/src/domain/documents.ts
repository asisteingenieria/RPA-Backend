import { instructionLikeWarning } from './injection.js';
import type { KnowledgeUse } from './brain.js';

/**
 * Documentos de un Brain (K3 contexto completo, K4 búsqueda; D-001 §7). Texto libre que se
 * guarda en fragmentos. El modelo lo recibe SIEMPRE como dato delimitado y su salida pasa por
 * los validadores: un documento nunca puede poner precios ni cambiar el flujo (reglas 10–12).
 */

export type DocumentUse = Exclude<KnowledgeUse, 'CATALOG'>;

export interface ChunkData {
  ord: number;
  text: string;
  tokens: number;
  embedding: number[];
  embeddingModel: string | null;
}

/** Fragmento congelado en una versión. */
export interface VersionChunkData extends ChunkData {
  use: DocumentUse;
  sourceName: string;
  sourceHash: string;
  metadata: Record<string, string> | null;
}

/** Aproximación conservadora (español): ~4 caracteres por token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Texto limpio: saltos de línea normalizados, sin espacios sobrantes ni caracteres de control. */
export function normalizeDocumentText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Fragmentos de ~`target` caracteres que respetan párrafos y títulos; un párrafo más largo se
 * corta por oraciones. Cada fragmento repite el final del anterior (`overlap`) para no perder
 * contexto en los bordes.
 */
export function chunkText(text: string, target = 900, overlap = 150): string[] {
  const clean = normalizeDocumentText(text);
  if (!clean) return [];
  const pieces: string[] = [];
  for (const para of clean.split(/\n{2,}|\n(?=#{1,6} )/)) {
    if (para.length <= target) {
      pieces.push(para);
      continue;
    }
    let buf = '';
    for (const sentence of para.split(/(?<=[.!?¿¡:;])\s+/)) {
      if (buf && buf.length + sentence.length + 1 > target) {
        pieces.push(buf);
        buf = '';
      }
      // Oración sin puntos más larga que el objetivo: corte duro.
      for (let i = 0; i < sentence.length; i += target) {
        const part = sentence.slice(i, i + target);
        buf = buf ? `${buf} ${part}` : part;
        if (buf.length >= target) {
          pieces.push(buf);
          buf = '';
        }
      }
    }
    if (buf) pieces.push(buf);
  }
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > target) {
      chunks.push(cur);
      // Ojo: slice(-0) devolvería todo el texto.
      const tail = overlap > 0 ? cur.slice(-overlap) : '';
      const cut = tail.indexOf(' ');
      const carry = cut >= 0 ? tail.slice(cut + 1) : tail;
      cur = carry ? `${carry}\n\n${p}` : p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Avisos de texto con forma de instrucción, por párrafo (no bloquean). */
export function documentWarnings(text: string, max = 5): string[] {
  const out: string[] = [];
  for (const para of normalizeDocumentText(text).split(/\n{2,}/)) {
    const w = instructionLikeWarning(para);
    if (w) out.push(`«${para.slice(0, 60)}${para.length > 60 ? '…' : ''}»: ${w}`);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Contenido de un documento para meterlo en `<documento>`: conserva los saltos de línea pero
 * no puede abrir ni cerrar etiquetas ni marcadores.
 */
export function escapeDocument(text: string, maxLength = 8_000): string {
  return text
    .replace(/[<>]/g, ' ')
    .replace(/\{\{|\}\}/g, ' ')
    .slice(0, maxLength)
    .trim();
}

/** Atributo de una etiqueta del prompt (nombre de Brain o fuente). */
export function escapeAttribute(text: string): string {
  return text
    .replace(/["<>{}\n\r]/g, ' ')
    .slice(0, 120)
    .trim();
}

// ---------- diferencias de documentos entre versiones ----------

export interface DocumentDiff {
  added: { source: string; use: DocumentUse; chunks: number }[];
  removed: { source: string; use: DocumentUse; chunks: number }[];
  /** Misma fuente (por nombre), contenido distinto. */
  changed: { source: string; use: DocumentUse; chunksBefore: number; chunksAfter: number }[];
}

type Grouped = Map<string, { hash: string; use: DocumentUse; chunks: number }>;

function group(
  chunks: readonly Pick<VersionChunkData, 'sourceName' | 'sourceHash' | 'use'>[],
): Grouped {
  const m: Grouped = new Map();
  for (const c of chunks) {
    const key = `${c.use}:${c.sourceName}`;
    const g = m.get(key);
    if (g) g.chunks++;
    else m.set(key, { hash: c.sourceHash, use: c.use, chunks: 1 });
  }
  return m;
}

export function diffDocuments(
  before: readonly Pick<VersionChunkData, 'sourceName' | 'sourceHash' | 'use'>[],
  after: readonly Pick<VersionChunkData, 'sourceName' | 'sourceHash' | 'use'>[],
): DocumentDiff {
  const prev = group(before);
  const next = group(after);
  const name = (key: string) => key.slice(key.indexOf(':') + 1);
  const diff: DocumentDiff = { added: [], removed: [], changed: [] };
  for (const [key, n] of next) {
    const p = prev.get(key);
    if (!p) diff.added.push({ source: name(key), use: n.use, chunks: n.chunks });
    else if (p.hash !== n.hash) {
      diff.changed.push({
        source: name(key),
        use: n.use,
        chunksBefore: p.chunks,
        chunksAfter: n.chunks,
      });
    }
  }
  for (const [key, p] of prev) {
    if (!next.has(key)) diff.removed.push({ source: name(key), use: p.use, chunks: p.chunks });
  }
  return diff;
}

export function isEmptyDocumentDiff(d: DocumentDiff | undefined): boolean {
  return !d || (!d.added.length && !d.removed.length && !d.changed.length);
}

// ---------- búsqueda ----------

/**
 * Consulta de texto completo segura para `to_tsquery('spanish', …)`: solo palabras (letras y
 * números) de 3+ caracteres, unidas con OR. Sin operadores del usuario: no se puede inyectar
 * sintaxis de tsquery.
 */
export function searchTerms(query: string, max = 12): string[] {
  const words = query
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  return [...new Set(words)].slice(0, max);
}

/** Fusión por rango recíproco (RRF) de varias listas ordenadas de ids. */
export function reciprocalRankFusion(lists: string[][], k = 60): { id: string; score: number }[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
