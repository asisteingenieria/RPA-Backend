/**
 * Abaya SIMULADO como servidor independiente (desarrollo y demo).
 *   pnpm demo:abaya   →  http://127.0.0.1:4010  (robot)   y   http://127.0.0.1:4010/__cliente (cliente)
 * Usuario robot: robot-ventas-01 / clave-de-prueba. Todo es sintético.
 */
import { MockAbayaServer } from './mock-server.js';

const port = Number(process.env.MOCK_ABAYA_PORT ?? 4010);
const mock = new MockAbayaServer({ chats: [] });
const url = await mock.start(port);
console.log(`Abaya simulado en ${url}  ·  cliente: ${url}/__cliente`);
process.on('SIGINT', () => void mock.stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void mock.stop().then(() => process.exit(0)));
