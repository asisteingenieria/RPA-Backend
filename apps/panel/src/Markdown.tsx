import type { ReactNode } from 'react';

/**
 * Vista previa del guion (v1.8). Subconjunto de Markdown suficiente para un prompt: títulos,
 * listas (con sangría), párrafos, citas, **negrita**, *énfasis*, `código` y marcadores
 * {{OFERTA:CODIGO}}. Construye elementos de React (nunca HTML crudo): sin riesgo de XSS.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\{\{[A-Z]+(?::[A-Z0-9]+)?\}\})|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    const t = m[0];
    if (m[1])
      out.push(
        <code key={k} className="marker">
          {t}
        </code>,
      );
    else if (m[2]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[3]) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else out.push(<strong key={k}>{t.slice(1, -1)}</strong>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface ListItem {
  depth: number;
  ordered: boolean;
  text: string;
}

function renderList(items: ListItem[], key: string): ReactNode {
  // Agrupa por profundidad relativa a la primera viñeta.
  const base = items[0]!.depth;
  const children: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    const nested: ListItem[] = [];
    let j = i + 1;
    while (j < items.length && items[j]!.depth > base) nested.push(items[j++]!);
    children.push(
      <li key={`${key}-${i}`}>
        {inline(item.text, `${key}-${i}`)}
        {nested.length > 0 && renderList(nested, `${key}-${i}n`)}
      </li>,
    );
    i = j;
  }
  return items[0]!.ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>;
}

/** `whatsapp`: respeta cada salto de línea, como se ve el mensaje en el chat del cliente. */
export function Markdown({ source, whatsapp = false }: { source: string; whatsapp?: boolean }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: ListItem[] = [];

  const flush = () => {
    if (para.length) {
      const k = `p${blocks.length}`;
      blocks.push(
        <p key={k}>
          {whatsapp
            ? para.flatMap((l, i) => [
                ...(i ? [<br key={`${k}-br${i}`} />] : []),
                ...inline(l, `${k}-${i}`),
              ])
            : inline(para.join(' '), k)}
        </p>,
      );
      para = [];
    }
    if (list.length) {
      blocks.push(renderList(list, `l${blocks.length}`));
      list = [];
    }
  };

  for (const raw of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(raw);
    const item = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    const quote = /^>\s?(.*)$/.exec(raw);
    if (!raw.trim()) {
      flush();
    } else if (heading) {
      flush();
      const level = heading[1]!.length;
      const k = `h${blocks.length}`;
      const content = inline(heading[2]!, k);
      blocks.push(
        level === 1 ? (
          <h3 key={k}>{content}</h3>
        ) : level === 2 ? (
          <h4 key={k}>{content}</h4>
        ) : (
          <h5 key={k}>{content}</h5>
        ),
      );
    } else if (item) {
      if (para.length) flush();
      list.push({
        depth: item[1]!.replace(/\t/g, '  ').length,
        ordered: /\d/.test(item[2]!),
        text: item[3]!,
      });
    } else if (quote) {
      flush();
      const k = `q${blocks.length}`;
      blocks.push(<blockquote key={k}>{inline(quote[1]!, k)}</blockquote>);
    } else if (list.length && /^\s+/.test(raw)) {
      // Continuación de la viñeta anterior.
      list[list.length - 1]!.text += ` ${raw.trim()}`;
    } else {
      if (list.length) flush();
      para.push(raw.trim());
    }
  }
  flush();
  return <div className="markdown">{blocks}</div>;
}
