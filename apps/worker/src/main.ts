/**
 * D-050: primero los secretos de la bóveda (si `SECRETS_PROVIDER=gcp`), después el arranque.
 * Va con import dinámico porque los módulos leen la configuración al cargarse.
 */
import { loadSecretsIntoEnv } from '@abaya/config/secrets';

await loadSecretsIntoEnv();
await import('./run.js');
