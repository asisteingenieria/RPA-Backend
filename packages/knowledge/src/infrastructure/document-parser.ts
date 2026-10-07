import type { DocumentParser, FileKind } from '../domain/ports.js';
import { decodeText, FileRejected } from './file-detection.js';
import { htmlToText } from './html-text.js';

/**
 * Texto plano de los documentos de un Brain (K3/K4): PDF con `unpdf` (PDF.js), DOCX con
 * `mammoth.extractRawText`, TXT/MD como texto y HTML (páginas web) con `htmlToText`.
 * Las librerías se cargan solo cuando hacen falta.
 */
export class TextExtractor implements DocumentParser {
  supports(kind: FileKind): boolean {
    return ['pdf', 'docx', 'txt', 'md', 'html'].includes(kind);
  }

  async extractText(bytes: Uint8Array, kind: FileKind): Promise<string> {
    switch (kind) {
      case 'pdf': {
        const { extractText, getDocumentProxy } = await import('unpdf');
        let pdf;
        try {
          pdf = await getDocumentProxy(new Uint8Array(bytes));
        } catch {
          throw new FileRejected(
            'no se pudo leer el PDF (¿está dañado o protegido con contraseña?)',
          );
        }
        try {
          const { text } = await extractText(pdf, { mergePages: true });
          if (!text.trim())
            throw new FileRejected('el PDF no tiene texto (¿es una imagen escaneada?)');
          return text;
        } finally {
          await pdf.loadingTask.destroy();
        }
      }
      case 'docx': {
        const mammoth = (await import('mammoth')).default;
        try {
          const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
          return r.value;
        } catch {
          throw new FileRejected('no se pudo leer el documento de Word');
        }
      }
      case 'txt':
      case 'md':
        return decodeText(bytes).text;
      case 'html':
        return htmlToText(decodeText(bytes).text);
      default:
        throw new FileRejected(`no se puede extraer texto de .${kind}`);
    }
  }
}
