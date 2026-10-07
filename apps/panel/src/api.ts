export interface Session {
  robotUser: string;
  status: string;
  lastHeartbeat: string;
  lastLoginAt: string | null;
  consecutiveFails: number;
}

export interface Overview {
  generatedAt: string;
  killSwitch: boolean;
  sessions: Session[];
  conversations: {
    active: number;
    transferring: number;
    needsReview: number;
    byStatus: Record<string, number>;
  };
  sales: { today: number; transferredToday: number };
  recentErrors: {
    robotUser: string;
    action: string;
    abayaChatId: string | null;
    result: string;
    createdAt: string;
  }[];
}

export interface ReviewQueue {
  conversations: {
    id: string;
    abayaChatId: string;
    robotUser: string;
    stage: string;
    updatedAt: string;
  }[];
  uncertainMessages: {
    id: string;
    attempts: number;
    createdAt: string;
    conversation: { id: string; abayaChatId: string; robotUser: string };
  }[];
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  createdAt: string;
}

export type Role = 'ADMIN' | 'OPERADOR';

export interface Me {
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface PanelUser {
  id: string;
  username: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface TemporaryPassword {
  user: PanelUser;
  temporaryPassword: string;
}

export type RobotStatus =
  'EN_LINEA' | 'RECONECTANDO' | 'CAIDO' | 'SIN_SENAL' | 'APAGADO' | 'DESHABILITADO';
export type Range = 'hoy' | '7d' | '30d';

export interface RobotSummary {
  robotUser: string;
  status: RobotStatus;
  sessionStatus: string | null;
  paused: boolean;
  enabled: boolean;
  host: string | null;
  version: string | null;
  startedAt: string | null;
  lastSeenAt: string | null;
  stoppedAt: string | null;
  installed: boolean;
  enrolledAt: string | null;
  pendingCodeUntil: string | null;
  hasCredentials: boolean;
  mfaMode: string;
  lastRejectedHost: string | null;
  lastRejectedAt: string | null;
  /** v1.7: última actualización pedida y lo que reportó el robot. */
  update: {
    requested: boolean;
    status: string;
    version: string | null;
    message: string | null;
    at: string | null;
  } | null;
}

export interface RobotListItem extends RobotSummary {
  /** Chats que siguen en su bandeja (v1.5). */
  openChats: number;
  metrics: {
    responseP50Ms: number | null;
    responseP95Ms: number | null;
    responses: number;
    conversations: number;
    sales: number;
    transferred: number;
    conversionPct: number | null;
    needsReview: number;
    actions: number;
    errors: number;
    uncertain: number;
    sendP95Ms: number | null;
  };
}

export interface RobotList {
  range: Range;
  from: string;
  generatedAt: string;
  maxChatsPerRobot: number;
  published: { version: string; size: number; builtAt: string; signatureValid: boolean } | null;
  robots: RobotListItem[];
}

export interface RobotDetail {
  range: Range;
  from: string;
  robot: RobotSummary;
  openChats: number;
  maxChatsPerRobot: number;
  response: { samples: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  session: {
    status: string;
    lastHeartbeat: string;
    lastLoginAt: string | null;
    consecutiveFails: number;
  } | null;
  metrics: {
    conversations: number;
    byStatus: Record<string, number>;
    sales: number;
    transferred: number;
    conversionPct: number | null;
  };
  actions: {
    action: string;
    total: number;
    ok: number;
    errors: number;
    uncertain: number;
    blocked: number;
    p50: number | null;
    p95: number | null;
  }[];
  recentActions: {
    createdAt: string;
    action: string;
    abayaChatId: string | null;
    result: string;
    durationMs: number;
  }[];
}

export interface EnrollmentCode {
  robotUser: string;
  enrollmentCode: string;
  expiresAt: string;
}

export interface RobotCredentials {
  abayaPassword?: string;
  mfaMode?: 'none' | 'totp';
  totpSecret?: string;
}

// ---------- configuración del agente (v1.8) ----------

export type AgentStatus = 'DRAFT' | 'EVALUATING' | 'PUBLISHED' | 'ARCHIVED' | 'REJECTED';

export interface AgentFields {
  agentName: string;
  companyName: string;
  companyInfo: string;
  welcome: string;
  prompt: string;
  model: string | null;
  temperature: number;
}

export interface EvalSummary {
  provider?: string;
  model?: string | null;
  cases?: number;
  passed?: number;
  invented?: number;
  p95?: number;
  regenRate?: string;
  fallbackRate?: string;
  problems?: string[];
  failedCases?: { id: string; failures: string[] }[];
  finishedAt?: string;
}

export interface AgentVersionInfo {
  id: string;
  version: number;
  status: AgentStatus;
  agentName: string;
  model: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  evalSummary: EvalSummary | null;
}

export type AgentVersion = AgentVersionInfo & AgentFields;

export interface AgentPlan {
  code: string;
  process: string;
  name: string;
  dataGb: number;
  priceCop: number;
  benefits: string[];
  discountText: string | null;
  validTo: string | null;
}

export interface AgentOverview {
  /** Sin versiones en la base: la v1 del código (`builtIn`). */
  published: (AgentFields & { version: number; status: AgentStatus; builtIn?: boolean }) &
    Partial<AgentVersionInfo>;
  working: AgentVersion | null;
  systemRules: string;
  menuOptions: string;
  stages: string[];
  limits: {
    agentName: number;
    companyName: number;
    companyInfo: number;
    welcome: number;
    prompt: number;
    temperatureMin: number;
    temperatureMax: number;
  };
  provider: string;
  canPublish: boolean;
  publishBlocker: string | null;
  temperatureApplies: boolean;
  defaultModel: string | null;
  models: string[];
  catalog: AgentPlan[];
}

export interface AgentTestState {
  stage: string;
  profile: Record<string, string>;
  history: { role: 'customer' | 'bot'; text: string }[];
}

export interface AgentTestResult {
  stage: string;
  profile: Record<string, string>;
  replies: string[];
  events: string[];
  validation: string;
  llm: { provider: string; model: string; latencyMs: number; validationResult: string }[];
}

export interface AgentIssue {
  field: keyof AgentFields;
  line?: number;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** Problemas de revisión de la configuración del agente (400). */
    readonly issues?: AgentIssue[],
  ) {
    super(message);
  }
}

/**
 * La sesión viaja en una cookie httpOnly (el panel nunca ve ni guarda el token).
 * `x-requested-with` es la defensa CSRF que exige la API en peticiones que cambian algo.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'abaya-panel' },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: unknown;
      code?: string;
      issues?: AgentIssue[];
    };
    const message = Array.isArray(body.message) ? body.message.join('. ') : body.message;
    throw new ApiError(
      res.status,
      typeof message === 'string' ? message : `HTTP ${res.status}`,
      body.code,
      Array.isArray(body.issues) ? body.issues : undefined,
    );
  }
  return (await res.json()) as T;
}

const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const api = {
  login: (username: string, password: string) =>
    request<Me>('/admin/auth/login', send({ username, password })),
  logout: () => request<{ ok: true }>('/admin/auth/logout', send({})),
  me: () => request<Me>('/admin/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/admin/auth/password', send({ currentPassword, newPassword })),

  overview: () => request<Overview>('/admin/overview'),
  review: () => request<ReviewQueue>('/admin/review'),
  audit: () => request<AuditEntry[]>('/admin/audit'),
  setKillSwitch: (active: boolean) =>
    request<{ killSwitch: boolean }>('/admin/kill-switch', send({ active })),
  resetSession: (robotUser: string) =>
    request<{ reset: boolean; note: string }>(
      `/admin/sessions/${encodeURIComponent(robotUser)}/reset`,
      send({}),
    ),

  users: () => request<PanelUser[]>('/admin/users'),
  createUser: (username: string, role: Role) =>
    request<TemporaryPassword>('/admin/users', send({ username, role })),
  updateUser: (id: string, patch: { role?: Role; active?: boolean }) =>
    request<PanelUser>(`/admin/users/${encodeURIComponent(id)}`, send(patch, 'PATCH')),
  resetPassword: (id: string) =>
    request<TemporaryPassword>(`/admin/users/${encodeURIComponent(id)}/reset-password`, send({})),
  robots: (range: Range) => request<RobotList>(`/admin/robots?rango=${range}`),
  robot: (robotUser: string, range: Range) =>
    request<RobotDetail>(`/admin/robots/${encodeURIComponent(robotUser)}?rango=${range}`),
  createRobot: (robotUser: string, creds: RobotCredentials) =>
    request<EnrollmentCode>('/admin/robots', send({ robotUser, ...creds })),
  robotCredentials: (robotUser: string, creds: RobotCredentials) =>
    request<{ ok: true; note: string }>(
      `/admin/robots/${encodeURIComponent(robotUser)}/credentials`,
      send(creds, 'PATCH'),
    ),
  enrollmentCode: (robotUser: string) =>
    request<EnrollmentCode>(
      `/admin/robots/${encodeURIComponent(robotUser)}/enrollment-code`,
      send({}),
    ),
  robotTraces: (robotUser: string) =>
    request<{ ref: string; bytes: number; at: string }[]>(
      `/admin/robots/${encodeURIComponent(robotUser)}/traces`,
    ),
  updateRobot: (robotUser: string) =>
    request<{ version: string }>(`/admin/robots/${encodeURIComponent(robotUser)}/update`, send({})),
  cancelUpdate: (robotUser: string) =>
    request<{ cancelled: boolean }>(
      `/admin/robots/${encodeURIComponent(robotUser)}/update/cancel`,
      send({}),
    ),
  updateAll: () =>
    request<{ version: string; robots: number }>('/admin/robots/update-all', send({})),
  pauseRobot: (robotUser: string, paused: boolean) =>
    request<{ paused: boolean }>(
      `/admin/robots/${encodeURIComponent(robotUser)}/pause`,
      send({ paused }),
    ),
  agent: () => request<AgentOverview>('/admin/agent'),
  agentVersions: () => request<AgentVersionInfo[]>('/admin/agent/versions'),
  agentVersion: (id: string) =>
    request<AgentVersion>(`/admin/agent/versions/${encodeURIComponent(id)}`),
  reviewAgent: (fields: AgentFields) =>
    request<{ issues: AgentIssue[] }>('/admin/agent/review', send(fields)),
  saveAgentDraft: (fields: AgentFields) =>
    request<AgentVersion>('/admin/agent/draft', send(fields, 'PUT')),
  publishAgent: () =>
    request<{ version: number; status: AgentStatus }>('/admin/agent/draft/publish', send({})),
  testAgent: (body: {
    source: 'editor' | 'published';
    fields?: AgentFields;
    state: AgentTestState;
    message: string;
  }) => request<AgentTestResult>('/admin/agent/test', send(body)),
  restoreAgentVersion: (id: string) =>
    request<AgentVersion>(`/admin/agent/versions/${encodeURIComponent(id)}/restore`, send({})),

  enableRobot: (robotUser: string, enabled: boolean) =>
    request<{ enabled: boolean; note?: string }>(
      `/admin/robots/${encodeURIComponent(robotUser)}/enabled`,
      send({ enabled }),
    ),
};
