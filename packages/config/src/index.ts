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
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
  /** Modelo fijado (sección 13: versión de modelo fijada). Lo elige la suite de evaluación. */
  LLM_MODEL: optionalString,
  /** Espera sin mensajes nuevos antes de procesar una ráfaga (sección 6.3.1). */
  BURST_QUIET_MS: z.coerce.number().int().positive().default(4_000),
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
});

export type AppConfig = z.infer<typeof envSchema>;

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
  return result.data;
}
