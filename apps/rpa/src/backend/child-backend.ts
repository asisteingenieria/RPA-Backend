import type { AbayaConfig } from '@abaya/config';
import { FieldCipher } from '@abaya/crypto';
import type { AlertPort, AlertSeverity, OutboundStatus } from '@abaya/domain';
import { createLogger, type Logger } from '@abaya/logger';
import type {
  ActionLog,
  BeatResult,
  ClaimResult,
  HandoffDecision,
  HandoffRepository,
  InboundSink,
  OutboundMessage,
  OutboundRepository,
  PresenceStore,
  RecoveryRepository,
  SessionRecord,
  SessionRepository,
  SweepRepository,
} from '@abaya/robot-store';
import { z } from 'zod';
import type { KillSwitch } from '../safety/kill-switch.js';
import type { AgentFile } from '../child/agent-file.js';
import type { GatewayClient } from '../child/gateway-client.js';
import type { RobotBackend } from './robot-backend.js';

/** Lo que se configura en el propio equipo (`robot.local.env`): nada secreto. */
export const localSettingsSchema = z.object({
  RPA_PORT: z.coerce.number().int().positive().default(3001),
  ABAYA_HEADLESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SESSION_STATE_DIR: z.string().default('.secrets'),
  TRACE_DIR: z.string().default('.secrets/traces'),
  BROWSER_RECYCLE_HOURS: z.coerce.number().min(0).default(6),
  ROBOT_HOST: z.string().optional(),
  /** Solo si el servidor NO está en producción: otra URL de Abaya (pruebas de carga, demo). */
  ROBOT_DEV_ABAYA_BASE_URL: z.string().url().optional(),
});
export type LocalSettings = z.infer<typeof localSettingsSchema>;

/**
 * Backend del robot hijo (v1.6, sección 2.8): cada operación va a la pasarela del servidor.
 * El equipo nunca tiene la base de datos, Redis ni la clave de cifrado de campos.
 */
export async function createChildBackend(
  client: GatewayClient,
  agent: AgentFile,
  local: LocalSettings,
  logger: Logger = createLogger('rpa.gateway'),
): Promise<RobotBackend> {
  await client.start();
  const remote = await client.config();
  const abayaBaseUrl =
    remote.nodeEnv !== 'production' && local.ROBOT_DEV_ABAYA_BASE_URL
      ? local.ROBOT_DEV_ABAYA_BASE_URL
      : remote.abayaBaseUrl;
  const abaya: AbayaConfig = {
    baseUrl: abayaBaseUrl,
    robotUser: remote.robotUser,
    password: remote.password,
    mfaMode: remote.mfaMode,
    totpSecret: remote.totpSecret,
    headless: local.ABAYA_HEADLESS,
    sessionStateDir: local.SESSION_STATE_DIR,
    traceDir: local.TRACE_DIR,
    heartbeatMs: remote.heartbeatMs,
  };
  const call = client.rpc.bind(client);

  const alerts: AlertPort = {
    async raise(code: string, severity: AlertSeverity, detail?: Record<string, unknown>) {
      logger.error({ alert: code, severity, ...detail }, `ALERTA ${severity}: ${code}`);
      await call('alerts.raise', { code, severity, ...(detail ? { detail } : {}) }).catch(
        (err: unknown) =>
          logger.warn({ err: err instanceof Error ? err.message : 'error' }, 'alerta no enviada'),
      );
    },
  };

  // Sin conexión a la pasarela, o con kill switch/pausa: no actuar (falla cerrado).
  const killSwitch: KillSwitch = { isActive: async () => !client.acting };

  const sessions: SessionRepository = {
    async get() {
      const r = (await call('session.get', {})) as
        | (Omit<SessionRecord, 'lastHeartbeat' | 'lastLoginAt'> & {
            lastHeartbeat: string;
            lastLoginAt: string | null;
          })
        | null;
      return r
        ? {
            ...r,
            lastHeartbeat: new Date(r.lastHeartbeat),
            lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt) : null,
          }
        : null;
    },
    async save(rec) {
      await call('session.save', {
        status: rec.status,
        lastHeartbeat: rec.lastHeartbeat.toISOString(),
        lastLoginAt: rec.lastLoginAt ? rec.lastLoginAt.toISOString() : null,
        consecutiveFails: rec.consecutiveFails,
      });
    },
  };

  const actionLog: ActionLog = {
    async append(entry) {
      const r = (await call('actionLog.append', {
        action: entry.action,
        abayaChatId: entry.abayaChatId,
        result: entry.result,
        durationMs: entry.durationMs,
        traceRef: entry.traceRef,
        createdAt: entry.createdAt.toISOString(),
      })) as { prevHash: string; hash: string };
      return { ...entry, ...r };
    },
  };

  const outbound: OutboundRepository = {
    get: async (messageId) => (await call('outbound.get', { messageId })) as OutboundMessage | null,
    setStatus: async (messageId, status: OutboundStatus, incrementAttempts = false) => {
      await call('outbound.setStatus', { messageId, status, incrementAttempts });
    },
  };

  const handoff: HandoffRepository = {
    outboundStatuses: async (messageIds) =>
      (await call('handoff.outboundStatuses', { messageIds })) as OutboundStatus[],
    sale: async (conversationId) =>
      (await call('handoff.sale', { conversationId })) as {
        summary: string;
        noteOk: boolean;
      } | null,
    markNoteOk: async (conversationId) =>
      void (await call('handoff.markNoteOk', { conversationId })),
    markTransferred: async (conversationId, target) =>
      void (await call('handoff.markTransferred', { conversationId, target })),
    markNeedsReview: async (conversationId) =>
      void (await call('handoff.markNeedsReview', { conversationId })),
  };

  const recovery: RecoveryRepository = {
    pendingOutbound: async () =>
      (await call('recovery.pendingOutbound', {})) as { messageId: string; abayaChatId: string }[],
    openConversations: async () =>
      (await call('recovery.openConversations', {})) as {
        conversationId: string;
        abayaChatId: string;
      }[],
    markNeedsReview: async (conversationIds) =>
      void (await call('recovery.markNeedsReview', { conversationIds })),
  };

  const presence: PresenceStore = {
    claim: async (i) =>
      (await call('presence.claim', {
        instanceId: i.instanceId,
        host: i.host,
        version: i.version,
      })) as ClaimResult,
    beat: async (_r, instanceId) => (await call('presence.beat', { instanceId })) as BeatResult,
    release: async (_r, instanceId) => void (await call('presence.release', { instanceId })),
  };

  const sweep: SweepRepository = {
    idleChats: async (_r, abayaChatIds) =>
      (await call('sweep.idleChats', { abayaChatIds })) as string[],
  };

  const inbound: InboundSink = {
    chatAssigned: async (abayaChatId) =>
      (await call('inbound.chatAssigned', { abayaChatId })) as { created: boolean },
    store: async (m) =>
      (await call('inbound.store', { ...m, occurredAt: m.occurredAt.toISOString() })) as {
        inserted: boolean;
        conversationCreated: boolean;
      },
  };

  return {
    mode: 'child',
    abaya,
    robotHost: local.ROBOT_HOST,
    browserRecycleHours: local.BROWSER_RECYCLE_HOURS,
    // Clave propia del equipo (DPAPI): la sesión de Abaya y las trazas pendientes no se abren
    // en otro equipo ni con la clave del servidor.
    localCipher: new FieldCipher((await agent.localKey()).toString('base64')),
    alerts,
    killSwitch,
    sessions,
    actionLog,
    outbound,
    handoff,
    recovery,
    presence,
    sweep,
    inbound,
    enqueueOutbound: async (messageId, abayaChatId) =>
      void (await call('recovery.enqueueOutbound', { messageId, abayaChatId })),
    startQueues: async (h, instanceId) => {
      client.connect(instanceId, async (kind, data, retries) => {
        if (kind === 'send') return h.send((data as { messageId: string }).messageId);
        if (kind === 'transfer') {
          return (await h.transfer(data as never, retries ?? 0)) satisfies HandoffDecision;
        }
        return (await h.close(data as never)) satisfies HandoffDecision;
      });
    },
    uploadTrace: (ref, zip) => client.uploadTrace(ref, zip),
    updates: {
      fetchManifest: () => client.releaseManifest(),
      download: (path) => client.downloadRelease(path),
      report: async (status, version, message) =>
        void (await call('update.report', {
          status: status as never,
          ...(version ? { version } : {}),
          ...(message ? { message } : {}),
        })),
      onRequest: (cb) => {
        client.onUpdate = cb;
      },
    },
    close: () => client.close(),
  };
}
