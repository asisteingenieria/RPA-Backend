import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  FIELD_ENCRYPTION_KEY: z
    .string()
    .min(1, 'FIELD_ENCRYPTION_KEY es obligatoria')
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'FIELD_ENCRYPTION_KEY debe ser base64 de 32 bytes',
    }),
  /** Id de la clave actual (1–255). Al rotar: nueva clave con id nuevo, la vieja a PREVIOUS. */
  FIELD_ENCRYPTION_KEY_ID: z.coerce.number().int().min(1).max(255).default(1),
  /** Claves anteriores `id:base64,id:base64`, solo para descifrar durante una rotación. */
  FIELD_ENCRYPTION_PREVIOUS_KEYS: optionalString,
  API_PORT: z.coerce.number().int().positive().default(3000),
  RPA_PORT: z.coerce.number().int().positive().default(3001),
  ABAYA_BASE_URL: optionalString,
  ABAYA_USER: optionalString,
  ABAYA_PASSWORD: optionalString,
  /** MFA del usuario robot (pregunta 3 a Claro): sin MFA o TOTP con secreto en el gestor. */
  ABAYA_MFA_MODE: z.enum(['none', 'totp']).default('none'),
  ABAYA_TOTP_SECRET: optionalString,
  ABAYA_HEADLESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Carpeta del storageState cifrado (fuera del control de versiones). */
  SESSION_STATE_DIR: z.string().default('.secrets'),
  /** Trazas cifradas de errores (retención 7 días). */
  TRACE_DIR: z.string().default('.secrets/traces'),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Nombre del equipo donde corre este robot (por defecto, el nombre de la máquina). */
  ROBOT_HOST: optionalString,
  /** Vida del token de acceso de los robots hijos (v1.6). Bajarla solo para pruebas. */
  ROBOT_ACCESS_TTL_MS: z.coerce.number().int().min(30_000).default(3_600_000),
  /** Clave pública de publicación (v1.7) para verificar el paquete antes de ofrecerlo. */
  ROBOT_RELEASE_PUBLIC_KEY: optionalString,
  /** Paquete instalador de los robots hijos que el panel ofrece para descargar. */
  ROBOT_PACKAGE_FILE: optionalString,
  /** `simulado`: cerebro heurístico sin red, SOLO para desarrollo (rechazado en producción). */
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'gemini', 'simulado']).default('anthropic'),
  /** Modelo fijado (sección 13: versión de modelo fijada). Lo elige la suite de evaluación. */
  LLM_MODEL: optionalString,
  /**
   * Modelos del proveedor principal que se pueden elegir en la configuración del agente
   * (v1.8), separados por coma. Vacío = solo el de LLM_MODEL. Cambiar de modelo también pasa
   * por la suite de evaluación al publicar (regla 13).
   */
  LLM_ALLOWED_MODELS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** Carpeta de los casos YAML de la suite de evaluación (por defecto `evals/conversations`). */
  EVALS_DIR: optionalString,
  /** Espera sin mensajes nuevos antes de procesar una ráfaga (sección 6.3.1). */
  BURST_QUIET_MS: z.coerce.number().int().positive().default(4_000),
  /** Webhook entrante (Slack/Teams) para alertas; vacío = solo logs. */
  ALERT_WEBHOOK_URL: optionalString,
  /** Capacidad por robot (v1.5): chats simultáneos esperados; por encima, alerta. */
  MAX_CHATS_PER_ROBOT: z.coerce.number().int().positive().default(3),
  /** Alerta si el p95 del tiempo de respuesta de un robot supera esto (15 min de ventana). */
  RESPONSE_P95_ALERT_MS: z.coerce.number().int().positive().default(20_000),
  /** Timeout por llamada al modelo (1 reintento). */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  /** Solo con LLM_PROVIDER=simulado: latencia media simulada del modelo (pruebas de carga). */
  LLM_SIMULATED_DELAY_MS: z.coerce.number().int().min(0).default(0),
  /** Proveedor de respaldo si el principal falla (vacío = sin respaldo). */
  LLM_FALLBACK_PROVIDER: z
    .enum(['anthropic', 'openai'])
    .optional()
    .or(z.literal('').transform(() => undefined)),
  LLM_FALLBACK_MODEL: optionalString,
  /** El robot recicla su navegador tras estas horas, solo con la bandeja vacía (0 = nunca). */
  BROWSER_RECYCLE_HOURS: z.coerce.number().min(0).default(6),
  /** Cierre por inactividad del cliente (sección 6.6). */
  INACTIVITY_MINUTES: z.coerce.number().int().positive().default(120),
  /**
   * Trazabilidad (D-002): días que se conserva el contenido de las conversaciones cerradas
   * (mensajes, perfil, resumen de la venta y respuesta del consentimiento). Vacío = no se borra.
   */
  CONVERSATION_RETENTION_DAYS: z
    .union([z.literal('').transform(() => undefined), z.coerce.number().int().positive()])
    .optional(),
  /**
   * Cookie de sesión del panel con `Secure` (solo viaja por HTTPS; los navegadores la aceptan
   * también en http://localhost). `false` únicamente para desarrollo por HTTP en otra máquina.
   */
  ADMIN_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  // ---------- Brains (v1.9, docs/DECISIONS.md D-001) ----------
  /**
   * Embeddings para la búsqueda de los Brains (K4). `none` = búsqueda solo por texto completo de
   * PostgreSQL en español. `openai` usa OPENAI_API_KEY; `voyage` usa VOYAGE_API_KEY.
   */
  EMBEDDINGS_PROVIDER: z.enum(['none', 'openai', 'voyage']).default('none'),
  /** Modelo de embeddings (vacío = text-embedding-3-small u voyage-4 según el proveedor). */
  EMBEDDINGS_MODEL: optionalString,
  VOYAGE_API_KEY: optionalString,
  /** Contenido de uso "contexto completo" por encima de esto se rechaza (usa Búsqueda). */
  KNOWLEDGE_FULL_CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(2_000),
  /** Fragmentos que la búsqueda entrega al modelo por turno. */
  KNOWLEDGE_SEARCH_TOP_K: z.coerce.number().int().min(1).max(20).default(4),
  /** Tamaño máximo de un archivo de fuente (MB). */
  KNOWLEDGE_MAX_FILE_MB: z.coerce.number().positive().max(50).default(10),
});

export type AppConfig = z.infer<typeof envSchema>;

/** Reglas que cruzan variables (se aplican después del esquema). */
function crossChecks(cfg: AppConfig): string[] {
  const issues: string[] = [];
  if (cfg.EMBEDDINGS_PROVIDER === 'openai' && !cfg.OPENAI_API_KEY) {
    issues.push('EMBEDDINGS_PROVIDER=openai requiere OPENAI_API_KEY');
  }
  if (cfg.EMBEDDINGS_PROVIDER === 'voyage' && !cfg.VOYAGE_API_KEY) {
    issues.push('EMBEDDINGS_PROVIDER=voyage requiere VOYAGE_API_KEY');
  }
  if (cfg.NODE_ENV === 'production' && cfg.LLM_PROVIDER === 'simulado') {
    issues.push('LLM_PROVIDER: "simulado" no está permitido en producción');
  }
  if (cfg.NODE_ENV === 'production' && !cfg.ADMIN_COOKIE_SECURE) {
    issues.push('ADMIN_COOKIE_SECURE: debe ser "true" en producción (panel solo por HTTPS)');
  }
  return issues;
}

/** Configuración mínima del robot en Abaya; falla si falta algo obligatorio. */
export function requireAbayaConfig(cfg: AppConfig) {
  const missing: string[] = (['ABAYA_BASE_URL', 'ABAYA_USER', 'ABAYA_PASSWORD'] as const).filter(
    (k) => !cfg[k],
  );
  if (cfg.ABAYA_MFA_MODE === 'totp' && !cfg.ABAYA_TOTP_SECRET) missing.push('ABAYA_TOTP_SECRET');
  if (missing.length) throw new Error(`Faltan variables de Abaya: ${missing.join(', ')}`);
  return {
    baseUrl: cfg.ABAYA_BASE_URL!,
    robotUser: cfg.ABAYA_USER!,
    password: cfg.ABAYA_PASSWORD!,
    mfaMode: cfg.ABAYA_MFA_MODE,
    totpSecret: cfg.ABAYA_TOTP_SECRET,
    headless: cfg.ABAYA_HEADLESS,
    sessionStateDir: cfg.SESSION_STATE_DIR,
    traceDir: cfg.TRACE_DIR,
    heartbeatMs: cfg.HEARTBEAT_INTERVAL_MS,
  };
}

export type AbayaConfig = ReturnType<typeof requireAbayaConfig>;

/**
 * Valida variables de entorno. El error lista solo los nombres de las variables
 * inválidas, nunca sus valores (regla 7).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${issues}`);
  }
  const cross = crossChecks(result.data);
  if (cross.length) throw new Error(`Configuración inválida: ${cross.join('; ')}`);
  return result.data;
}
