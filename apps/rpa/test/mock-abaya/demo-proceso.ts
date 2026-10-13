/* eslint-disable no-console -- demostración por línea de comandos */
/**
 * Demostración visual del proceso del robot contra el Abaya (ySocial) SIMULADO. Datos sintéticos.
 *   npx tsx test/mock-abaya/demo-proceso.ts      (desde apps/rpa)
 * Abre dos ventanas: la consola del asesor que maneja el robot (en cámara lenta, con un letrero
 * del paso) y el «WhatsApp» del cliente simulado. No toca Abaya real.
 */
import { chromium, type Page } from 'playwright';
import { AgentStatePage } from '../../src/abaya/pages/state.page.js';
import { ChatListPage } from '../../src/abaya/pages/chat-list.page.js';
import { ChatPage } from '../../src/abaya/pages/chat.page.js';
import { FinishPage } from '../../src/abaya/pages/finish.page.js';
import { LoginPage } from '../../src/abaya/pages/login.page.js';
import { MockAbayaServer } from './mock-server.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mock = new MockAbayaServer({ chats: [] });
const url = await mock.start(4010);
console.log(`Abaya simulado en ${url}/agent/  ·  cliente: ${url}/__cliente`);

const browser = await chromium.launch({
  headless: false,
  slowMo: 350,
  args: ['--window-position=0,0', '--window-size=1300,820'],
});
const robotCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const robot = await robotCtx.newPage();

const clienteBrowser = await chromium.launch({
  headless: false,
  args: ['--window-position=1310,0', '--window-size=560,820'],
});
const cliente = await (await clienteBrowser.newContext()).newPage();

/** Letrero del paso, abajo a la derecha de la consola del robot. */
async function paso(page: Page, texto: string) {
  console.log(`▶ ${texto}`);
  await page
    .evaluate((t) => {
      let el = document.getElementById('__demo');
      if (!el) {
        el = document.createElement('div');
        el.id = '__demo';
        el.style.cssText =
          'position:fixed;left:12px;bottom:12px;z-index:99999;max-width:560px;padding:10px 14px;' +
          'background:#1b2a4a;color:#fff;font:600 15px system-ui;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3)';
        document.body.appendChild(el);
      }
      el.textContent = '🤖 ' + t;
    }, texto)
    .catch(() => undefined);
}

async function responder(texto: string) {
  const chat = new ChatPage(robot);
  await chat.typeMessage(texto);
  await wait(800);
  await chat.clickSend();
  await chat.waitForAgentMessage(texto, 5_000);
  await wait(1_200);
}

async function esperarCaso(caseId: string) {
  const list = new ChatListPage(robot);
  for (let i = 0; i < 40; i++) {
    if ((await list.listChats()).some((c) => c.abayaChatId === caseId)) return;
    await wait(250);
  }
}

try {
  // ---------- 1. Login ----------
  await robot.goto(`${url}/agent/`);
  await cliente.goto(`${url}/__cliente`);
  await paso(robot, 'Abro la consola del asesor (SMCC Web Agent) e inicio sesión');
  await wait(1_500);
  await new LoginPage(robot).login({ username: mock.username, password: mock.password });
  await robot.waitForLoadState('load');

  // ---------- 2. Disponible ----------
  await paso(robot, 'Entré en estado «Login»: me pongo «Disponible» para recibir burbujas');
  await wait(2_000);
  await new AgentStatePage(robot).ensureAvailable();
  await paso(robot, 'Disponible. Esperando burbujas…');
  await wait(2_500);

  // ---------- 3. Llega una venta ----------
  const venta = '9000000123';
  mock.addCustomerMessage(venta, 'Hola, quiero portar mi número a Claro');
  await esperarCaso(venta);
  await paso(robot, 'Llegó una burbuja nueva: acepto el aviso y abro el caso');
  await wait(2_000);
  await new ChatListPage(robot).open(venta);
  await wait(1_500);
  await paso(robot, 'Verifico que el encabezado diga «Caso #9000000123» antes de escribir');
  await wait(2_000);

  await paso(robot, 'Respondo según el guion');
  await responder('¡Hola! Con Claro lo puedes todo. 💪\n¿Con qué operador estás actualmente?');

  mock.addCustomerMessage(venta, 'Estoy con Tigo');
  await paso(robot, 'El cliente respondió: le ofrezco el plan');
  await wait(2_500);
  await responder(
    'Por portarte hoy te ofrezco el *Plan Porta Básico (DEMO)*: 20 GB, minutos ilimitados.\n¿Lo tomamos?',
  );

  mock.addCustomerMessage(venta, 'Sí, lo tomo');
  await wait(2_000);
  await responder(
    'Perfecto. Me confirmas tu número de documento, nombre completo y correo para enviarte la autorización.',
  );

  mock.addCustomerMessage(venta, '1000000000\nCliente Demo\ncliente.demo@ejemplo.test');
  await paso(robot, 'El cliente dio sus datos: envío el link de autorización');
  await wait(2_500);
  await responder(
    '* Te envié un link por mensaje de texto o correo para que autorices el tratamiento de tus datos. ¡Gracias por elegir Claro!',
  );

  await paso(robot, 'Venta lista: FINALIZAR → «Finalizar» (el caso pasa a la cola de backoffice)');
  await wait(2_500);
  await new FinishPage(robot).finishKeepCase();
  await paso(robot, 'Caso finalizado: salió de mi bandeja. Vuelvo a esperar burbujas…');
  await wait(4_000);

  // ---------- 4. Una no venta ----------
  const noVenta = '9000000456';
  mock.addCustomerMessage(noVenta, 'Buenas, ¿cuánto cuesta el plan más barato?');
  await esperarCaso(noVenta);
  await paso(robot, 'Otra burbuja: la abro');
  await wait(1_500);
  await new ChatListPage(robot).open(noVenta);
  await wait(1_500);
  await responder(
    '¡Hola! El plan más económico para portabilidad es el *Plan Porta Básico (DEMO)*.\n¿Te gustaría tomarlo?',
  );

  mock.addCustomerMessage(noVenta, 'No gracias, prefiero prepago');
  await wait(2_000);
  await responder('Entiendo. Si cambias de opinión, aquí estaremos. ¡Feliz día!');

  await paso(robot, 'No hubo venta: FINALIZAR → «Finalizar y cerrar el caso» con su etiqueta');
  await wait(2_500);
  await new FinishPage(robot).finishCloseCase(
    'No venta - Ecommerce Movil - Cliente prefiere Prepago',
  );
  await paso(
    robot,
    'Caso cerrado con etiqueta. Fin de la demostración (cierra las ventanas cuando quieras)',
  );

  console.log('\nResumen del simulador:');
  console.log('  Ventas entregadas al backoffice (Finalizar):', mock.transfers);
  console.log('  Casos cerrados:', mock.closed, 'etiquetas:', mock.tags);
  console.log('\nCierra las ventanas para terminar.');
  await Promise.race([
    new Promise((r) => robot.on('close', r)),
    new Promise((r) => cliente.on('close', r)),
    wait(10 * 60_000),
  ]);
} catch (err) {
  console.error('La demostración se detuvo:', err instanceof Error ? err.message : err);
  await wait(60_000);
} finally {
  await browser.close().catch(() => undefined);
  await clienteBrowser.close().catch(() => undefined);
  await mock.stop();
}
