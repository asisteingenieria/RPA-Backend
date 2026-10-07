import { planTitle } from '@abaya/knowledge';
import type { Plan } from '../catalog/catalog.js';
import { bogotaDateTime } from '../engine/templates/templates.js';
import type { Profile } from '../engine/types.js';

export interface SaleSummaryInput {
  conversationId: string;
  abayaChatId: string;
  profile: Profile;
  plan: Plan | undefined;
  consentAt: Date;
}

/**
 * Resumen estructurado para el backoffice (sección 6.5). Va en la nota interna de Abaya.
 * BORRADOR: el formato definitivo se acuerda con Claro (pregunta 14).
 */
export function buildSaleSummary(i: SaleSummaryInput): string {
  const p = i.profile;
  return [
    '*VENTA AGENTE RPA*',
    `Proceso: ${p.process ?? 'N/D'}`,
    `Plan: ${p.planCode ?? 'N/D'}${i.plan ? ` - ${planTitle(i.plan)}` : ''}`,
    `Cliente: ${p.name ?? 'N/D'}`,
    ...(p.process === 'PORTABILIDAD' ? [`Operador actual: ${p.currentOperator ?? 'N/D'}`] : []),
    'Número: el del chat de Abaya',
    `Autorización de datos: ${bogotaDateTime(i.consentAt)} (hora de Bogotá)`,
    `Chat Abaya: ${i.abayaChatId}`,
    `Conversación: ${i.conversationId}`,
  ].join('\n');
}
