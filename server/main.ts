import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createOnlineServer } from './app';

const database = resolve(process.env.DUEL_DATABASE ?? 'data/duel.sqlite');
mkdirSync(dirname(database), { recursive: true });
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT');
const app = createOnlineServer({ database, staticRoot: resolve('dist'),
  origins: process.env.ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) });
app.http.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Duel Atelier online: http://${process.env.HOST ?? '127.0.0.1'}:${port}`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!closing) { closing = true; void app.close(); } });
