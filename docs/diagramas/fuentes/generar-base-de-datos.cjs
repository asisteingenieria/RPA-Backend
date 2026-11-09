// Genera los tres candidatos ERD de Archify (docs/diagramas) a partir de
// packages/db/prisma/schema.prisma en el commit HEAD. Uso, desde la raíz del repositorio:
//   node docs/diagramas/fuentes/generar-base-de-datos.cjs
// y luego, por cada carpeta que imprime, el finalize de Archify (ver docs/diagramas/README.md).
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const root = path.resolve(__dirname, "../../..") + "/";
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
const raw = execSync("git show HEAD:packages/db/prisma/schema.prisma", { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 });
const revision = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
const lines = raw.split(/\r?\n/);

const enums = new Set();
const models = {};
let cur = null;
lines.forEach((l, i) => {
  const ln = i + 1;
  let m;
  if ((m = l.match(/^enum (\w+)/))) enums.add(m[1]);
  if ((m = l.match(/^model (\w+)/))) { cur = { name: m[1], start: ln, fields: [], blockAttrs: [] }; models[m[1]] = cur; return; }
  if (cur && /^}/.test(l)) { cur.end = ln; cur = null; return; }
  if (!cur) return;
  const t = l.replace(/\/\/.*$/, "").trim();
  if (!t) return;
  if (t.startsWith("@@")) { cur.blockAttrs.push(t); return; }
  const f = t.match(/^(\w+)\s+([\w\[\]?]+(?:\([^)]*\))?)\s*(.*)$/);
  if (f) cur.fields.push({ name: f[1], type: f[2], attrs: f[3] });
});

const SQL = { String: "text", Int: "integer", BigInt: "bigint", Float: "double precision", Boolean: "boolean", DateTime: "timestamp", Json: "jsonb", Bytes: "bytea", Decimal: "numeric" };
const isModel = (t) => !!models[t.replace(/[\[\]?]/g, "")];

const entities = {};
const rels = [];
for (const m of Object.values(models)) {
  const fk = {};
  for (const f of m.fields) {
    const r = f.attrs.match(/@relation\(fields: \[(\w+)\], references: \[(\w+)\]/);
    if (r) fk[r[1]] = { to: f.type.replace(/[\[\]?]/g, ""), col: r[2] };
  }
  const composite = m.blockAttrs.map((a) => a.match(/^@@id\(\[([^\]]+)\]\)/)).find(Boolean);
  const pkCols = composite ? composite[1].split(",").map((s) => s.trim()) : [];
  const attributes = [];
  for (const f of m.fields) {
    if (isModel(f.type)) continue;
    const base = f.type.replace(/[\[\]?]/g, "");
    const list = f.type.includes("[]");
    const optional = f.type.endsWith("?");
    let type = enums.has(base) ? base : SQL[base] || base;
    if (list) type += "[]";
    if (optional) type += "?";
    const keys = [];
    if (/@id\b/.test(f.attrs) || pkCols.includes(f.name)) keys.push("pk");
    if (fk[f.name]) keys.push("fk");
    if (/@unique\b/.test(f.attrs)) keys.push("uk");
    const a = { name: f.name, type };
    if (keys.length) a.key = keys.length === 1 ? keys[0] : keys;
    if (fk[f.name]) a.references = `${fk[f.name].to}.${fk[f.name].col}`;
    attributes.push(a);
  }
  entities[m.name] = { id: m.name, label: m.name, attributes, sources: [{ path: "packages/db/prisma/schema.prisma", line: m.start, end_line: m.end, label: "model " + m.name }] };
  for (const [col, r] of Object.entries(fk)) {
    const childUnique = m.fields.find((f) => f.name === col).attrs.includes("@unique");
    rels.push({ from: r.to, to: m.name, col, oneToOne: childUnique, identifying: pkCols.includes(col) });
  }
}

const LABEL = { Message: "mensajes", Sale: "venta", ServiceCase: "caso de servicio", AdminSession: "sesiones", BrainVersion: "versiones", KnowledgeSource: "fuentes", AgentBrain: "agentes conectados", CatalogRecord: "planes", VersionImage: "imágenes", VersionChunk: "fragmentos", SourceChunk: "fragmentos" };
const LEER = { dot: "cyan", title: "Cómo leer las tablas", items: ["PK llave primaria · FK llave foránea · UK valor único", "Tipo con «?»: admite nulo; «[]»: lista", "Tipos con mayúscula inicial son enumeraciones"] };
const diagrams = [
  { slug: "conversaciones", title: "Base de datos (1/3): conversaciones, ventas y robots",
    domains: [
      { tag: "Conversaciones y ventas", cells: [["Conversation", 0, 0], ["Message", 0, 1], ["Sale", 0, 2], ["ServiceCase", 0, 3], ["ConsentEvidence", 0, 4]] },
      { tag: "Robots y operación", cells: [["Robot", 1, 0], ["RpaSession", 1, 1], ["RpaActionLog", 1, 2], ["OutboxEvent", 1, 3]] }],
    cards: [
      { dot: "violet", title: "Datos cifrados", items: ["Columnas *Encrypted (bytea): texto del cliente, perfil, resúmenes, audio, contraseña de Abaya y secreto MFA", "Se cifran en la aplicación (FieldCipher) antes de guardarse"] },
      { dot: "rose", title: "Cadenas de hashes", items: ["ConsentEvidence: cada «SÍ AUTORIZO» enlaza con el anterior (prevHash → hash)", "RpaActionLog: cada acción del robot, encadenada por robot"] },
      { dot: "amber", title: "Referencias sin llave foránea", items: ["robotUser enlaza Conversation, RpaSession y RpaActionLog con Robot", "ConsentEvidence.conversationId → Conversation", "Conversation.agentVersionId → AgentConfigVersion (diagrama 2)", "Message.imageId → VersionImage (diagrama 3)"] }, LEER] },
  { slug: "agente-panel", title: "Base de datos (2/3): agente, modelo de lenguaje y panel",
    domains: [
      { tag: "Agente y modelo de lenguaje", cells: [["AgentConfigVersion", 0, 0], ["AgentTestRecord", 0, 1], ["LlmCall", 0, 2], ["Plan", 1, 0], ["PromptVersion", 1, 1], ["ModelUsage", 1, 2]] },
      { tag: "Panel y administración", cells: [["AdminUser", 0, 3], ["AdminSession", 1, 3], ["AdminAuditLog", 2, 3], ["AppSetting", 3, 3]] }],
    cards: [
      { dot: "emerald", title: "Versiones del agente", items: ["AgentConfigVersion: guion, plantillas y flujo; solo una PUBLISHED la usa el motor", "Publicar pasa por la suite de evaluación (evalSummary, evalVerdict)"] },
      { dot: "amber", title: "Referencias sin llave foránea", items: ["LlmCall.conversationId → Conversation (diagrama 1)", "AgentTestRecord.versionId → AgentConfigVersion", "AgentBrain.agentKey conecta el agente con los Brains (diagrama 3)"] },
      { dot: "rose", title: "Seguridad del panel", items: ["AdminUser guarda solo el hash de la contraseña", "AdminSession guarda el hash del token de la cookie", "AdminAuditLog registra cada acción de los usuarios"] }, LEER] },
  { slug: "conocimiento", title: "Base de datos (3/3): conocimiento (Brains)",
    domains: [
      { tag: "Conocimiento (Brains)", cells: [["AgentBrain", 0, 0], ["Brain", 0, 1], ["BrainVersion", 0, 2], ["KnowledgeBlob", 0, 3], ["KnowledgeSource", 0, 4],
        ["KnowledgeUsage", 1, 0], ["CatalogRecord", 1, 1], ["VersionImage", 1, 2], ["VersionChunk", 1, 3], ["SourceChunk", 1, 4]] }],
    cards: [
      { dot: "emerald", title: "Cómo se usa", items: ["Brain: catálogo de planes; el motor lee la versión PUBLISHED", "CatalogRecord: cada plan con su precio y textos", "VersionImage: imágenes de la oferta por proceso", "SourceChunk y VersionChunk: fragmentos con embeddings para la búsqueda híbrida"] },
      { dot: "amber", title: "Referencias sin llave foránea", items: ["KnowledgeUsage registra qué datos usó cada turno (conversationId, brainVersionId)", "blobRef → KnowledgeBlob (archivo cifrado)"] }, LEER] }
];
for (const dg of diagrams) {
  const dir = ".archify/erd-" + dg.slug + "-" + stamp;
  const ids = [];
  const ents = [];
  for (const d of dg.domains) for (const [id, row, col] of d.cells) {
    if (!entities[id]) throw new Error("falta " + id);
    ents.push({ ...entities[id], tag: d.tag, row, col, width: 285 });
    ids.push(id);
  }
  const relationships = rels.filter((r) => ids.includes(r.from) && ids.includes(r.to)).map((r) => ({
    from: r.from, to: r.to, label: LABEL[r.to] || r.col,
    fromCardinality: "one", toCardinality: r.oneToOne ? "one" : "many", toOptional: true,
    ...(r.identifying ? { identifying: true } : {})
  }));
  const c = { schema_version: 1, diagram_type: "erd",
    meta: { title: dg.title, locale: "es", output: dir + "/" + dg.slug + ".html", quality_profile: "standard",
      repository: { url: "https://github.com/asisteingenieria/RPA-Backend.git", provider: "github", link_mode: "web", revision } },
    layout: { mode: "grid", gapX: 56, gapY: 36 },
    entities: ents, relationships, cards: dg.cards };
  fs.mkdirSync(root + dir, { recursive: true });
  fs.writeFileSync(root + dir + "/candidate.json", JSON.stringify(c, null, 2));
  console.log(dir, ents.length, "tablas", relationships.length, "relaciones");
}
const all = diagrams.flatMap((d) => d.domains.flatMap((x) => x.cells.map((c) => c[0])));
const missing = Object.keys(entities).filter((id) => !all.includes(id));
if (missing.length) throw new Error("sin diagrama: " + missing.join(", "));
