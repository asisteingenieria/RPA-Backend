# Fixtures de Abaya

Regla 8: **los fixtures siempre van sanitizados.** Nunca se versiona HTML o tráfico con datos reales.

- `network/mock-*.json`: payloads **sintéticos** del Abaya simulado (no provienen de Abaya real).
- Los fixtures reales de F1 se guardan aquí con nombres sin prefijo `mock-`.

## Checklist de sanitización (antes de cada commit)

- [ ] Nombres, teléfonos, documentos, correos y direcciones reemplazados por valores ficticios.
- [ ] Ids de chat y de mensaje reemplazados por ids sintéticos (`CH-1001`, `m-1`…).
- [ ] Sin tokens, cookies, cabeceras de autorización ni ids de sesión.
- [ ] Sin URLs internas de Claro (usar `https://abaya.test`).
- [ ] Sin scripts de terceros ni rastreadores embebidos.
- [ ] Revisión manual de una segunda persona.
