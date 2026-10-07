import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { WebFetcher } from '../domain/ports.js';

/**
 * Descarga de páginas web para los Brains (K5) con protección SSRF:
 * - solo `https:` en el puerto 443, sin usuario ni contraseña en la URL;
 * - el nombre se resuelve y se RECHAZA si alguna dirección es privada, de loopback, link-local,
 *   CGNAT, multicast, reservada o de metadatos de nube; la conexión usa la dirección ya
 *   validada (no hay segunda resolución: evita DNS rebinding);
 * - redirecciones manuales (máx. 3), cada una validada igual;
 * - tamaño y tiempo máximos, y solo HTML o texto.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** ¿Se puede conectar a esta dirección desde el servidor? */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4 dentro de IPv6 (::ffff:10.0.0.1, 64:ff9b::10.0.0.1): se valida la IPv4.
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^(?:::ffff:|64:ff9b::)[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return false;
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

export class WebFetchError extends Error {
  override name = 'WebFetchError';
}

export interface SafeWebFetcherOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Para pruebas: resolución de nombres. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
  userAgent?: string;
}

const ALLOWED_TYPES = ['text/html', 'text/plain', 'application/xhtml+xml'];

/** Valida una URL antes de cualquier conexión. */
export function checkWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebFetchError('la dirección no es una URL válida');
  }
  if (url.protocol !== 'https:') throw new WebFetchError('solo se permiten direcciones https://');
  if (url.username || url.password)
    throw new WebFetchError('la URL no puede llevar usuario ni contraseña');
  if (url.port && url.port !== '443') throw new WebFetchError('solo se permite el puerto 443');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host))
    throw new WebFetchError('la dirección apunta a una red interna');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) {
    throw new WebFetchError('la dirección apunta a una red interna');
  }
  return url;
}

export class SafeWebFetcher implements WebFetcher {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly resolve: (host: string) => Promise<LookupAddress[]>;

  constructor(private readonly opts: SafeWebFetcherOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRedirects = opts.maxRedirects ?? 3;
    this.resolve =
      opts.resolve ??
      ((host) =>
        new Promise((ok, fail) =>
          dnsLookup(host, { all: true, verbatim: true }, (err, addrs) =>
            err ? fail(err) : ok(addrs),
          ),
        ));
  }

  /** Dirección pública validada para el host (todas deben ser públicas). */
  async resolvePublic(host: string): Promise<LookupAddress> {
    const bare = host.replace(/^\[|\]$/g, '');
    if (isIP(bare)) {
      if (!isPublicAddress(bare)) throw new WebFetchError('la dirección apunta a una red interna');
      return { address: bare, family: isIP(bare) };
    }
    let addrs: LookupAddress[];
    try {
      addrs = await this.resolve(bare);
    } catch {
      throw new WebFetchError(`no se pudo resolver ${bare}`);
    }
    if (!addrs.length) throw new WebFetchError(`no se pudo resolver ${bare}`);
    if (addrs.some((a) => !isPublicAddress(a.address))) {
      throw new WebFetchError('la dirección apunta a una red interna');
    }
    return addrs[0]!;
  }

  async fetch(raw: string) {
    let url = checkWebUrl(raw);
    for (let hop = 0; ; hop++) {
      const target = await this.resolvePublic(url.hostname);
      const res = await this.get(url, target);
      if (res.redirect) {
        if (hop >= this.maxRedirects) throw new WebFetchError('demasiadas redirecciones');
        url = checkWebUrl(new URL(res.redirect, url).toString());
        continue;
      }
      return { finalUrl: url.toString(), mime: res.mime, bytes: res.bytes };
    }
  }

  private get(
    url: URL,
    target: LookupAddress,
  ): Promise<{ redirect?: string; mime: string; bytes: Uint8Array }> {
    // La conexión usa SOLO la dirección validada; el nombre queda para TLS (SNI y certificado).
    const lookup: LookupFunction = (_host, options, cb) => {
      if ((options as { all?: boolean }).all) cb(null, [target]);
      else cb(null, target.address, target.family);
    };
    return new Promise((ok, fail) => {
      const req = request(
        url,
        {
          method: 'GET',
          lookup,
          timeout: this.timeoutMs,
          headers: {
            'user-agent': this.opts.userAgent ?? 'AbayaRPA-Brains/1.0 (+contenido de referencia)',
            accept: 'text/html,text/plain;q=0.9',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            ok({ redirect: res.headers.location, mime: '', bytes: new Uint8Array() });
            return;
          }
          if (status !== 200) {
            res.resume();
            fail(new WebFetchError(`la página respondió ${status}`));
            return;
          }
          const mime = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
          if (!ALLOWED_TYPES.includes(mime)) {
            res.resume();
            fail(new WebFetchError(`tipo de contenido no permitido (${mime || 'desconocido'})`));
            return;
          }
          const declared = Number(res.headers['content-length'] ?? 0);
          if (declared > this.maxBytes) {
            res.destroy();
            fail(new WebFetchError('la página es demasiado grande'));
            return;
          }
          const parts: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > this.maxBytes) {
              res.destroy();
              fail(new WebFetchError('la página es demasiado grande'));
              return;
            }
            parts.push(c);
          });
          res.on('end', () => ok({ mime, bytes: new Uint8Array(Buffer.concat(parts)) }));
          res.on('error', () => fail(new WebFetchError('la descarga se interrumpió')));
        },
      );
      req.on('timeout', () => req.destroy(new WebFetchError('la página no respondió a tiempo')));
      req.on('error', (err) =>
        fail(
          err instanceof WebFetchError
            ? err
            : new WebFetchError('no se pudo conectar con la página'),
        ),
      );
      req.end();
    });
  }
}
