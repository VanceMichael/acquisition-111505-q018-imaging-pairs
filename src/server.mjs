import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { collectFromSource, CollectionError } from './collect.mjs';

const configuration = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
const DEFAULT_SOURCE = process.env.SOURCE_URL || 'http://127.0.0.1:4200';

async function readJsonBody(incoming, outgoing, reply) {
  const chunks = []; let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > 1048576) { reply(413, { error: '请求体过大' }); return null; }
    chunks.push(chunk);
  }
  if (length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { reply(400, { error: 'JSON 无效' }); return null; }
}

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: ['manual', 'auto'] });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        const payload = await readJsonBody(incoming, outgoing, reply);
        if (payload === null) return;
        const source = typeof payload.source === 'string' && payload.source ? payload.source : DEFAULT_SOURCE;
        try {
          new URL(source);
        } catch {
          return reply(400, { error: '来源地址无效' });
        }
        try {
          const summary = await collectFromSource(archive, source, configuration);
          return reply(201, summary);
        } catch (error) {
          return reply(error instanceof CollectionError ? 422 : 502, { error: error.message });
        }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        const payload = await readJsonBody(incoming, outgoing, reply);
        if (payload === null) return;
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
