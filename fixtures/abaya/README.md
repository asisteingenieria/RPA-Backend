# Fixtures de Abaya

Regla 8: **los fixtures siempre van sanitizados.** Nunca se versiona HTML o tráfico con datos reales.

- `network/ysocial-*.json`: payloads con la **forma real** de ySocial (observada el 09/10/2026),
  escritos a mano con valores **sintéticos**: ids, textos, teléfonos y URLs inventados. Las
  grabaciones crudas quedan fuera del repositorio, en el equipo de quien grabó, y se borran al
  terminar.

## Checklist de sanitización (antes de cada commit)

- [ ] Nombres, teléfonos, documentos, correos y direcciones reemplazados por valores ficticios.
- [ ] Ids de caso y de mensaje reemplazados por ids sintéticos (`9000000001`, `7000000001`…).
- [ ] Sin tokens, cookies, firmas SAS, cabeceras de autorización ni ids de sesión.
- [ ] Sin URLs internas de Claro ni del tenant de ySocial (usar `https://abaya.test`).
- [ ] Sin scripts de terceros ni rastreadores embebidos.
- [ ] Revisión manual de una segunda persona.
