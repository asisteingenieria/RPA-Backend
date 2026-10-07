import { QUEUES, robotQueue, type AlertPort } from '@abaya/domain';
import { Queue } from 'bullmq';
import { alertsFromConfig } from '@abaya/alerts';
import { loadConfig, requireAbayaConfig, type AbayaConfig } from '@abaya/config';
import { cipherFromConfig, type FieldCipher } from '@abaya/crypto';
import { createPrismaClient } from '@abaya/db';
import { createLogger } from '@abaya/logger';
import {
  BullInboundQueue,
  DirectInboundSink,
  PrismaActionLog,
  PrismaHandoffRepository,
  PrismaInboundRepository,
  PrismaOutboundRepository,
  PrismaPresenceStore,
  PrismaRecoveryRepository,
  PrismaSessionRepository,
  PrismaSweepRepository,
  RobotQueueConsumers,
  type ActionLog,
  type HandoffRepository,
  type InboundSink,
  type OutboundRepository,
  type PresenceStore,
  type RecoveryRepository,
  type RobotQueueHandlers,
  type SessionRepository,
  type SweepRepository,
  type UpdateStatus,
} from '@abaya/robot-store';
import { RedisKillSwitch, type KillSwitch } from '../safety/kill-switch.js';

/**
 * Todo lo que el robot necesita del "mundo" (persistencia, colas, kill switch, alertas).
 * - Directo: base de datos, Redis y clave de cifrado en el propio proceso (desarrollo,
 *   pruebas, demo).
 * - Hijo (v1.6, sección 2.8): todo por la pasarela del servidor; el equipo no tiene la base,
 *   Redis ni la clave.
 * El resto del robot (navegador, sesión, presencia, barrido, transferencias) no distingue.
 */
export interface RobotBackend {
  readonly mode: 'direct' | 'child';
  readonly abaya: AbayaConfig;
  readonly robotHost?: string;
  readonly browserRecycleHours: number;
  /** Cifra lo que queda en el disco del equipo (sesión guardada de Abaya, trazas). */
  readonly localCipher: FieldCipher;
  readonly alerts: AlertPort;
  readonly killSwitch: KillSwitch;
  readonly sessions: SessionRepository;
  readonly actionLog: ActionLog;
  readonly outbound: OutboundRepository;
  readonly handoff: HandoffRepository;
  readonly recovery: RecoveryRepository;
  readonly presence: PresenceStore;
  readonly sweep: SweepRepository;
  readonly inbound: InboundSink;
  enqueueOutbound(messageId: string, abayaChatId: string): Promise<void>;
  /** Empieza a recibir tareas (enviar, transferir, cerrar). Tras reclamar el robot. */
  startQueues(h: RobotQueueHandlers, instanceId: string): Promise<void>;
  /** Solo hijo: sube las trazas de error al servidor. */
  uploadTrace?(ref: string, zip: Buffer): Promise<void>;
  /** Solo hijo (v1.7): actualizaciones publicadas en el servidor. */
  updates?: {
    fetchManifest(): Promise<unknown>;
    download(path: string): Promise<void>;
    report(status: UpdateStatus, version?: string, message?: string): Promise<void>;
    /** El servidor pide instalar esta versión (o null). */
    onRequest(cb: (version: string | null) => void): void;
  };
  close(): Promise<void>;
}

/** Modo directo: igual que hasta v1.5. Devuelve null si Abaya no está configurado. */
export function createDirectBackend(env: NodeJS.ProcessEnv = process.env): RobotBackend | null {
  const cfg = loadConfig(env);
  if (!cfg.ABAYA_BASE_URL) return null;
  const abaya = requireAbayaConfig(cfg);
  const cipher = cipherFromConfig(cfg);
  const prisma = createPrismaClient(cfg.DATABASE_URL);
  const inboundQueue = new BullInboundQueue(cfg.REDIS_URL);
  const killSwitch = RedisKillSwitch.fromUrl(cfg.REDIS_URL, abaya.robotUser);
  const recoveryQueue = new Queue(robotQueue(QUEUES.outbound, abaya.robotUser), {
    connection: { url: cfg.REDIS_URL },
  });
  let consumers: RobotQueueConsumers | undefined;
  return {
    mode: 'direct',
    abaya,
    robotHost: cfg.ROBOT_HOST,
    browserRecycleHours: cfg.BROWSER_RECYCLE_HOURS,
    localCipher: cipher,
    alerts: alertsFromConfig(cfg, createLogger('rpa.alerts')),
    killSwitch,
    sessions: new PrismaSessionRepository(prisma),
    actionLog: new PrismaActionLog(prisma),
    outbound: new PrismaOutboundRepository(prisma, cipher),
    handoff: new PrismaHandoffRepository(prisma, cipher),
    recovery: new PrismaRecoveryRepository(prisma),
    presence: new PrismaPresenceStore(prisma),
    sweep: new PrismaSweepRepository(prisma),
    inbound: new DirectInboundSink({
      robotUser: abaya.robotUser,
      repo: new PrismaInboundRepository(prisma),
      queue: inboundQueue,
      cipher,
    }),
    // jobId fijo por mensaje: no se apilan reencolados; el actor es idempotente.
    enqueueOutbound: async (messageId, abayaChatId) => {
      await recoveryQueue.add(
        'message',
        { messageId, abayaChatId },
        { jobId: `recover-${messageId}` },
      );
    },
    startQueues: async (h) => {
      consumers = new RobotQueueConsumers(
        cfg.REDIS_URL,
        abaya.robotUser,
        h,
        createLogger('rpa.queues'),
      );
    },
    close: async () => {
      await consumers?.close();
      await recoveryQueue.close();
      await killSwitch.close();
      await inboundQueue.close();
      await prisma.$disconnect();
    },
  };
}

let current: RobotBackend | null | undefined;

/** main.ts elige el backend antes de levantar la aplicación. */
export function setRobotBackend(b: RobotBackend | null) {
  current = b;
}

export function getRobotBackend(): RobotBackend | null {
  if (current === undefined) current = createDirectBackend();
  return current;
}
