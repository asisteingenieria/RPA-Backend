/**
 * Contenido principal de una página HTML como texto (K5). Sin dependencias: quita scripts,
 * estilos, navegación, encabezados, pies y formularios; si hay `<main>` o `<article>`, usa
 * solo eso. No ejecuta nada de la página.
 */

const DROP = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
];
const BLOCK =
  /<\/?(p|div|section|article|main|li|ul|ol|tr|table|h[1-6]|br|hr|blockquote|pre|dd|dt|figcaption)\b[^>]*>/gi;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  iexcl: '¡',
  iquest: '¿',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : ' ';
    }
    return ENTITIES[e] ?? m;
  });
}

export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m
    ? decodeEntities(m[1]!.replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim()
    : '';
  return t || null;
}

export function htmlToText(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP) {
    h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(h);
  if (main) h = main[2]!;
  else {
    const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(h);
    if (body) h = body[1]!;
  }
  h = h
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n## ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(h)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
