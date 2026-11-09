import 'reflect-metadata';
import { Controller, Get, Module, Req, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, describe, expect, it } from 'vitest';
import { FailedAuthLimiter } from './admin/admin-auth.guard.js';
import { HSTS, parseTrustProxy, securityHeaders } from './security-headers.js';

@Controller('ip')
class IpController {
  @Get()
  ip(@Req() req: { ip?: string }) {
    return { ip: req.ip };
  }
}

@Module({ controllers: [IpController] })
class IpModule {}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Arranca la API mínima como en main.ts y devuelve la IP que ve Express para un X-Forwarded-For. */
async function seenIp(trustProxy: string, forwardedFor?: string): Promise<string> {
  const a = await NestFactory.create<NestExpressApplication>(IpModule, { logger: false });
  a.set('trust proxy', parseTrustProxy(trustProxy));
  a.use(securityHeaders);
  await a.listen(0, '127.0.0.1');
  app = a;
  const res = await fetch(`${await a.getUrl()}/ip`, {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });
  expect(res.headers.get('strict-transport-security')).toBe(HSTS);
  return ((await res.json()) as { ip: string }).ip;
}

describe('trust proxy (nginx en el mismo servidor)', () => {
  it('con loopback, cada cliente tiene su IP real detrás de nginx', async () => {
    expect(await seenIp('loopback', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('un X-Forwarded-For falsificado por el cliente no gana: vale la IP que agrega nginx', async () => {
    // nginx ($proxy_add_x_forwarded_for) agrega la IP real al final de lo que mandó el cliente.
    expect(await seenIp('loopback', '10.0.0.1, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('sin la cabecera (nginx viejo) se comporta como antes: la IP del proxy', async () => {
    expect(await seenIp('loopback')).toMatch(/127\.0\.0\.1$/);
  });

  it('con false ignora la cabecera', async () => {
    expect(await seenIp('false', '203.0.113.7')).toMatch(/127\.0\.0\.1$/);
  });

  it('los intentos fallidos de una IP ya no bloquean a otra', async () => {
    const limiter = new FailedAuthLimiter();
    const atacante = await seenIp('loopback', '198.51.100.9');
    await app?.close();
    app = undefined;
    const robot = await seenIp('loopback', '203.0.113.7');
    for (let i = 0; i < 20; i++) limiter.fail(atacante);
    expect(limiter.isBlocked(atacante)).toBe(true);
    expect(limiter.isBlocked(robot)).toBe(false);
  });
});

describe('parseTrustProxy', () => {
  it('interpreta los valores de TRUST_PROXY sin hacer caer el arranque', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('true')).toBe(1);
    expect(parseTrustProxy(' loopback, 10.0.0.0/8 ')).toBe('loopback, 10.0.0.0/8');
  });
});
