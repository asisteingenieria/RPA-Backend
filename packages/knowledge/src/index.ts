// Módulo de conocimiento: Brains (v1.9, docs/DECISIONS.md D-001).
// domain/: reglas puras · application/: casos de uso · infrastructure/: adaptadores.

export * from './domain/brain.js';
export * from './domain/catalog.js';
export * from './domain/injection.js';
export * from './domain/ports.js';

export * from './application/agent-catalog.js';
export * from './application/bootstrap.js';
export * from './application/catalog-versions.js';
export * from './application/ingestion.js';

export * from './infrastructure/file-detection.js';
export * from './infrastructure/pg-blob-store.js';
export * from './infrastructure/table-parser.js';
