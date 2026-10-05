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

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export interface Credentials {
  token: string;
  user: string;
}

async function request<T>(creds: Credentials, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${creds.token}`,
      'x-admin-user': creds.user,
    },
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

export const api = {
  overview: (c: Credentials) => request<Overview>(c, '/admin/overview'),
  review: (c: Credentials) => request<ReviewQueue>(c, '/admin/review'),
  audit: (c: Credentials) => request<AuditEntry[]>(c, '/admin/audit'),
  setKillSwitch: (c: Credentials, active: boolean) =>
    request<{ killSwitch: boolean }>(c, '/admin/kill-switch', {
      method: 'POST',
      body: JSON.stringify({ active }),
    }),
  resetSession: (c: Credentials, robotUser: string) =>
    request<{ reset: boolean; note: string }>(
      c,
      `/admin/sessions/${encodeURIComponent(robotUser)}/reset`,
      {
        method: 'POST',
      },
    ),
};
