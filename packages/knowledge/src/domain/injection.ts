/**
 * Detección de texto con forma de instrucción dentro del contenido de un Brain (D-001 D5).
 * Solo AVISA: el contenido siempre se trata como dato (va delimitado y escapado en el contexto
 * del modelo, y la salida del modelo pasa por los validadores igual). Sirve para que quien carga
 * el archivo vea algo raro antes de publicar.
 */
const PATTERNS: { re: RegExp; what: string }[] = [
  {
    re: /\bignor[ae]\w*\b.{0,40}\b(instruccion|regla|indicacion|anterior|sistema)/i,
    what: 'pide ignorar instrucciones',
  },
  {
    re: /\b(olvida|omite|desobedece)\w*\b.{0,40}\b(instruccion|regla|anterior)/i,
    what: 'pide ignorar instrucciones',
  },
  {
    re: /\b(ahora eres|actua como|act as|you are now|from now on|a partir de ahora)\b/i,
    what: 'intenta cambiar el rol del agente',
  },
  {
    re: /\b(system prompt|prompt del sistema|jailbreak|developer mode)\b/i,
    what: 'menciona el prompt del sistema',
  },
  {
    re: /<\/?\s*(system|assistant|user|datos_catalogo|documento)\b/i,
    what: 'contiene etiquetas de control',
  },
  { re: /https?:\/\/|www\./i, what: 'contiene un enlace' },
];

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');

export function instructionLikeWarning(text: string): string | null {
  const t = fold(text);
  const hit = PATTERNS.find((p) => p.re.test(t));
  return hit
    ? `${hit.what}: se tratará como dato, nunca como instrucción; revísalo antes de publicar`
    : null;
}

/**
 * Escapa contenido de un Brain para meterlo dentro de un bloque delimitado del prompt: no puede
 * abrir ni cerrar etiquetas (`<`, `>`) ni marcadores (`{{`, `}}`), y no lleva saltos de línea.
 */
export function escapeForPrompt(text: string, maxLength = 300): string {
  return text
    .replace(/[<>]/g, ' ')
    .replace(/\{\{|\}\}/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}
