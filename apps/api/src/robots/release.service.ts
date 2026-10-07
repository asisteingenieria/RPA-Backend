import { existsSync, readFileSync, statSync } from 'node:fs';
import { verifyRelease, type ReleaseManifest, type SignedRelease } from '@abaya/robot-store';

export interface PublishedRelease {
  version: string;
  size: number;
  builtAt: string;
  /** El zip publicado coincide con su manifiesto firmado (versión, tamaño). */
  signatureValid: boolean;
  signed: SignedRelease;
  manifest: ReleaseManifest | null;
}

/**
 * Versión publicada para los robots (v1.7, sección 2.9): el zip del instalador y su manifiesto
 * firmado. El servidor verifica la firma con la clave pública (la misma que traen los robots)
 * antes de ofrecerla; si no es válida, no se ofrece a ningún robot.
 */
export class ReleaseService {
  private cache?: { mtimeMs: number; value: PublishedRelease | null };

  constructor(
    private readonly packageFile: string | null,
    private readonly publicKeyFile: string | null,
  ) {}

  get file(): string | null {
    return this.packageFile;
  }

  published(): PublishedRelease | null {
    const manifestFile = this.packageFile ? `${this.packageFile}.manifest.json` : null;
    if (
      !this.packageFile ||
      !manifestFile ||
      !existsSync(this.packageFile) ||
      !existsSync(manifestFile)
    ) {
      return null;
    }
    const mtimeMs = statSync(manifestFile).mtimeMs + statSync(this.packageFile).mtimeMs;
    if (this.cache?.mtimeMs === mtimeMs) return this.cache.value;
    let value: PublishedRelease | null;
    try {
      const signed = JSON.parse(readFileSync(manifestFile, 'utf8')) as SignedRelease;
      const pub =
        this.publicKeyFile && existsSync(this.publicKeyFile)
          ? readFileSync(this.publicKeyFile, 'utf8')
          : null;
      const manifest = pub ? verifyRelease(signed, pub) : null;
      const size = statSync(this.packageFile).size;
      const unsigned = JSON.parse(signed.manifest) as Partial<ReleaseManifest>;
      value = {
        version: manifest?.version ?? String(unsigned.version ?? 'desconocida'),
        size,
        builtAt: manifest?.builtAt ?? String(unsigned.builtAt ?? ''),
        signatureValid: !!manifest && manifest.size === size,
        signed,
        manifest,
      };
    } catch {
      value = null;
    }
    this.cache = { mtimeMs, value };
    return value;
  }

  /** Versión que los robots pueden instalar (solo si la firma es válida). */
  installable(): string | null {
    const p = this.published();
    return p?.signatureValid ? p.version : null;
  }
}
