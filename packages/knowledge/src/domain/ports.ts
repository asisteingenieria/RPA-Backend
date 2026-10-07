import type { TableData } from './catalog.js';

/**
 * Puertos del módulo de conocimiento (D-001 D6). Los adaptadores viven en `infrastructure/`
 * o en el proceso que los usa. K1 usa `TableParser` y `BlobStore`; el resto queda definido
 * para las fases K3–K5 y se implementa cuando se verifique la API externa elegida.
 */

/** Tipo REAL de un archivo (por su contenido, no por la extensión). */
export type FileKind = 'xlsx' | 'csv' | 'pdf' | 'docx' | 'txt' | 'md';

export interface DetectedFile {
  kind: FileKind;
  mime: string;
  /** Avisos de la lectura (p. ej. CSV convertido desde Windows-1252). */
  warnings: string[];
}

/** Lee una tabla (catálogo) desde un archivo ya validado. */
export interface TableParser {
  parse(bytes: Uint8Array, kind: 'xlsx' | 'csv'): Promise<{ table: TableData; warnings: string[] }>;
}

/** Texto plano de un documento (K3/K4). */
export interface DocumentParser {
  supports(kind: FileKind): boolean;
  extractText(bytes: Uint8Array, kind: FileKind): Promise<string>;
}

/** Archivos originales, cifrados en reposo. */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(ref: string): Promise<Uint8Array>;
  delete(ref: string): Promise<void>;
}

/** Proveedor de embeddings intercambiable (K4). */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>;
}

export interface VectorMatch {
  chunkId: string;
  score: number;
}

/** Búsqueda híbrida vector + texto completo (K4). */
export interface VectorStore {
  search(input: {
    brainVersionId: string;
    query: string;
    embedding: number[];
    topK: number;
    filter?: Record<string, string>;
  }): Promise<VectorMatch[]>;
}

/** Descarga de páginas web con protección SSRF (K5). */
export interface WebFetcher {
  fetch(url: string): Promise<{ finalUrl: string; mime: string; bytes: Uint8Array }>;
}
