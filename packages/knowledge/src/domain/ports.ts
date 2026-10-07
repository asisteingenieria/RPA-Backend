import type { TableData } from './catalog.js';

/**
 * Puertos del módulo de conocimiento (D-001 D6). Los adaptadores viven en `infrastructure/`
 * o en el proceso que los usa. K1 usa `TableParser` y `BlobStore`; el resto queda definido
 * para las fases K3–K5 y se implementa cuando se verifique la API externa elegida.
 */

/** Tipo REAL de un archivo (por su contenido, no por la extensión). */
export type FileKind = 'xlsx' | 'csv' | 'pdf' | 'docx' | 'txt' | 'md' | 'html';

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
  /** `openai`, `voyage`… */
  readonly id: string;
  /** Modelo: los vectores solo se comparan con los del mismo modelo. */
  readonly model: string;
  embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>;
}

export interface SearchHit {
  chunkId: string;
  brainVersionId: string;
  sourceName: string;
  text: string;
  score: number;
}

/** Búsqueda híbrida: texto completo de PostgreSQL en español + vectores (K4). */
export interface VectorStore {
  search(input: {
    versionIds: string[];
    query: string;
    /** Vector de la consulta (null = solo texto completo). */
    embedding: number[] | null;
    embeddingModel: string | null;
    topK: number;
    /** Filtro por metadatos de la fuente: el fragmento no tiene la clave o coincide. */
    filter?: Record<string, string>;
  }): Promise<SearchHit[]>;
}

/** Descarga de páginas web con protección SSRF (K5). */
export interface WebFetcher {
  fetch(url: string): Promise<{ finalUrl: string; mime: string; bytes: Uint8Array }>;
}
