import { expect, test } from '@playwright/test';
import {
  AgentStatePage,
  ChatListPage,
  ChatPage,
  FinishPage,
  LoginPage,
} from '../../src/abaya/pages/index.js';
import { inboxHtml, loginHtml, sampleChats } from '../mock-abaya/templates.js';

// Pruebas de page objects contra el markup de ySocial simulado, con page.setContent.

test.describe('LoginPage', () => {
  test('detecta la pantalla de login', async ({ page }) => {
    await page.setContent(loginHtml());
    expect(await new LoginPage(page).isVisible()).toBe(true);
  });

  test('informa credenciales inválidas cuando aparece el error', async ({ page }) => {
    await page.setContent(loginHtml({ error: 'Usuario o contraseña incorrectos' }));
    const r = await new LoginPage(page).login({ username: 'u', password: 'p' }, 2_000);
    expect(r).toBe('INVALID_CREDENTIALS');
  });

  test('sin doble factor: el bloque de usuario y contraseña (`!login.showTwoFactor`) no es MFA', async ({
    page,
  }) => {
    // 15/10/2026, ySocial real: con `[ng-if*="showTwoFactor"]` este bloque daba «2 elements».
    await page.setContent(loginHtml());
    expect(await new LoginPage(page).requiresOtp()).toBe(false);
  });

  test('pide MFA si hay campo de código y no se entregó', async ({ page }) => {
    await page.setContent(loginHtml({ mfa: true }));
    expect(await new LoginPage(page).login({ username: 'u', password: 'p' })).toBe('MFA_REQUIRED');
  });
});

test.describe('AgentStatePage', () => {
  test('al entrar está en «Login» y pasa a «Disponible»', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats()));
    const state = new AgentStatePage(page);
    expect(await state.current()).toBe('Login');
    expect(await state.isReceiving()).toBe(false);
    expect(await state.ensureAvailable(3_000)).toBe(true);
    expect(await state.current()).toBe('Disponible');
  });
});

test.describe('ChatListPage', () => {
  test('lista los casos con no leídos y el abierto (número leído del modelo, no del DOM)', async ({
    page,
  }) => {
    await page.setContent(inboxHtml(sampleChats(), '1001'));
    const list = new ChatListPage(page);
    expect(await list.isVisible()).toBe(true);
    await expect
      .poll(() => list.listChats())
      .toEqual([
        { abayaChatId: '1001', unread: 0, active: true },
        { abayaChatId: '1002', unread: 0, active: false },
      ]);
  });

  test('abre un caso por número y el encabezado lo confirma', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), '1001'));
    const list = new ChatListPage(page);
    expect(await list.open('1002')).toBe(true);
    await expect.poll(() => new ChatPage(page).currentChatId()).toBe('1002');
    expect((await list.listChats()).find((c) => c.active)?.abayaChatId).toBe('1002');
    expect(await list.open('9999')).toBe(false);
  });
});

test.describe('ChatPage', () => {
  test('identifica el caso abierto y lee mensajes con remitente e id', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), '1001'));
    const chat = new ChatPage(page);
    await expect.poll(() => chat.currentChatId()).toBe('1001');
    expect(await chat.headingText()).toBe('Caso #1001');
    const msgs = await chat.readMessages();
    expect(msgs.map((m) => m.sender)).toEqual(['SYSTEM', 'CUSTOMER', 'AGENT', 'CUSTOMER']);
    expect(msgs[1]).toMatchObject({ messageId: '502', text: 'Hola, quiero información de planes' });
  });

  test('sin caso abierto no devuelve id ni mensajes', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats()));
    const chat = new ChatPage(page);
    expect(await chat.currentChatId()).toBeNull();
    expect(await chat.readMessages()).toEqual([]);
  });

  test('escribe y envía respetando saltos de línea y formato', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), '1001'));
    const chat = new ChatPage(page);
    await expect.poll(() => chat.currentChatId()).toBe('1001');
    const text = '*Plan M2*\nTe cuento los detalles';
    await chat.typeMessage(text);
    await chat.clickSend();
    expect(await chat.waitForAgentMessage(text, 3_000)).toBe(true);
    expect((await chat.lastAgentTexts(1))[0]).toBe(text);
  });

  test('waitForAgentMessage devuelve false si el mensaje no aparece', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), '1001'));
    expect(await new ChatPage(page).waitForAgentMessage('nunca enviado', 500)).toBe(false);
  });
});

test.describe('FinishPage', () => {
  test('venta: «Finalizar» sin cerrar y el caso sale de la bandeja', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), '1001'));
    await expect.poll(() => new ChatPage(page).currentChatId()).toBe('1001');
    await new FinishPage(page).finishKeepCase();
    const ids = (await new ChatListPage(page).listChats()).map((c) => c.abayaChatId);
    expect(ids).not.toContain('1001');
    expect(await new ChatPage(page).currentChatId()).toBeNull();
  });

  test('no venta: «Finalizar y cerrar el caso» con etiqueta', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), '1001'));
    await expect.poll(() => new ChatPage(page).currentChatId()).toBe('1001');
    await new FinishPage(page).finishCloseCase(
      'No venta - Ecommerce Movil -Cliente abandona conversación',
    );
    const ids = (await new ChatListPage(page).listChats()).map((c) => c.abayaChatId);
    expect(ids).toEqual(['1002']);
  });
});
