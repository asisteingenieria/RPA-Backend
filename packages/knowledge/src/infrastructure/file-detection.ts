import { fileTypeFromBuffer } from 'file-type';
import type { DetectedFile, FileKind } from '../domain/ports.js';

const EXTENSIONS: Record<string, FileKind> = {
  xlsx: 'xlsx',
  csv: 'csv',
  pdf: 'pdf',
  docx: 'docx',
  txt: 'txt',
  md: 'md',
};

const BINARY: Partial<Record<FileKind, string>> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const TEXT_MIME: Partial<Record<FileKind, string>> = {
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
};

export class FileRejected extends Error {
  override name = 'FileRejected';
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * Tipo REAL por contenido (D-001 D10). Los formatos binarios se reconocen por su firma con
 * `file-type` (XLSX, DOCX, PDF) y debe coincidir con la extensión. Los de texto (CSV, TXT, MD)
 * no tienen firma: no pueden tener firma binaria ni bytes nulos y deben decodificarse como
 * UTF-8 (o Windows-1252, que es como Excel guarda el CSV en Windows).
 */
export async function detectFile(
  bytes: Uint8Array,
  filename: string,
  allowed: readonly FileKind[],
): Promise<DetectedFile> {
  const kind = EXTENSIONS[extensionOf(filename)];
  if (!kind || !allowed.includes(kind)) {
    throw new FileRejected(
      `tipo de archivo no permitido (usa ${allowed.map((k) => `.${k}`).join(', ')})`,
    );
  }
  if (!bytes.length) throw new FileRejected('el archivo está vacío');
  const sniffed = await fileTypeFromBuffer(bytes);

  const expected = BINARY[kind];
  if (expected) {
    if (sniffed?.ext !== kind) {
      throw new FileRejected(
        `el contenido no es un .${kind} válido${sniffed ? ` (parece .${sniffed.ext})` : ''}`,
      );
    }
    return { kind, mime: expected, warnings: [] };
  }

  if (sniffed) {
    throw new FileRejected(`el contenido no es texto: parece un .${sniffed.ext}`);
  }
  if (bytes.includes(0)) throw new FileRejected('el contenido no es texto (bytes nulos)');
  const { warnings } = decodeText(bytes);
  return { kind, mime: TEXT_MIME[kind]!, warnings };
}

/** UTF-8 estricto; si no lo es, Windows-1252 con aviso. */
export function decodeText(bytes: Uint8Array): { text: string; warnings: string[] } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), warnings: [] };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(bytes),
      warnings: ['el archivo no estaba en UTF-8: se leyó como Windows-1252 (revisa las tildes)'],
    };
  }
}
