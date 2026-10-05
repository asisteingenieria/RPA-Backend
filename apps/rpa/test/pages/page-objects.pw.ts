import { expect, test } from '@playwright/test';
import {
  ChatListPage,
  ChatPage,
  LoginPage,
  NotePage,
  TransferPage,
} from '../../src/abaya/pages/index.js';
import { inboxHtml, loginHtml, sampleChats } from '../mock-abaya/templates.js';

// Pruebas de page objects contra el markup (F1) con page.setContent.

test.describe('LoginPage', () => {
  test('detecta la pantalla de login', async ({ page }) => {
    await page.setContent(loginHtml());
    expect(await new LoginPage(page).isVisible()).toBe(true);
  });

  test('informa credenciales inválidas cuando aparece el error', async ({ page }) => {
    await page.setContent(loginHtml({ error: 'Usuario o contraseña incorrectos' }));
    // En modo estático el formulario no navega: el error ya está visible.
    await page.evaluate(() =>
      document.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault()),
    );
    const r = await new LoginPage(page).login({ username: 'u', password: 'p' }, 2_000);
    expect(r).toBe('INVALID_CREDENTIALS');
  });

  test('pide MFA si hay campo de código y no se entregó', async ({ page }) => {
    await page.setContent(loginHtml({ mfa: true }));
    expect(await new LoginPage(page).login({ username: 'u', password: 'p' })).toBe('MFA_REQUIRED');
  });
});

test.describe('ChatListPage', () => {
  test('lista chats con no leídos y chat activo', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), 'CH-1001'));
    const list = new ChatListPage(page);
    expect(await list.isVisible()).toBe(true);
    expect(await list.listChats()).toEqual([
      { abayaChatId: 'CH-1001', unread: 2, active: true },
      { abayaChatId: 'CH-1002', unread: 0, active: false },
    ]);
  });

  test('abre un chat por id', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), 'CH-1001'));
    const list = new ChatListPage(page);
    await list.open('CH-1002');
    const chats = await list.listChats();
    expect(chats.find((c) => c.active)?.abayaChatId).toBe('CH-1002');
  });
});

test.describe('ChatPage', () => {
  test('identifica el chat abierto y lee mensajes con remitente', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), 'CH-1001'));
    const chat = new ChatPage(page);
    expect(await chat.currentChatId()).toBe('CH-1001');
    expect(await chat.headingText()).toBe('Chat CH-1001');
    const msgs = await chat.readMessages();
    expect(msgs.map((m) => m.sender)).toEqual(['SYSTEM', 'CUSTOMER', 'AGENT', 'CUSTOMER']);
    expect(msgs[1]).toMatchObject({ messageId: 'm-2', text: 'Hola, quiero información de planes' });
  });

  test('sin chat abierto no devuelve id ni mensajes', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats()));
    const chat = new ChatPage(page);
    expect(await chat.currentChatId()).toBeNull();
    expect(await chat.readMessages()).toEqual([]);
  });

  test('escribe y envía respetando saltos de línea y formato', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), 'CH-1001'));
    const chat = new ChatPage(page);
    const text = '*Plan M2*\nTe cuento los detalles';
    await chat.typeMessage(text);
    await chat.clickSend();
    expect(await chat.waitForAgentMessage(text, 3_000)).toBe(true);
    expect((await chat.lastAgentTexts(1))[0]).toBe(text);
  });

  test('waitForAgentMessage devuelve false si el mensaje no aparece', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), 'CH-1001'));
    expect(await new ChatPage(page).waitForAgentMessage('nunca enviado', 500)).toBe(false);
  });
});

test.describe('NotePage y TransferPage', () => {
  test('escribe una nota interna', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), 'CH-1001'));
    expect(await new NotePage(page).writeNote('Venta: portabilidad, plan M2')).toBe(true);
  });

  test('transfiere a backoffice y el chat sale de la bandeja', async ({ page }) => {
    await page.setContent(inboxHtml(sampleChats(), 'CH-1001'));
    await new TransferPage(page).transferTo();
    const ids = (await new ChatListPage(page).listChats()).map((c) => c.abayaChatId);
    expect(ids).not.toContain('CH-1001');
    expect(await new ChatPage(page).currentChatId()).toBeNull();
  });
});
