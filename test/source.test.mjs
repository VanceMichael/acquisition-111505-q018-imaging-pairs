import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('共享轴与稀疏像素在实际交付中独立表达', async context => {
  const { base } = await withSource(context); const xml = await (await fetch(base + '/imaging/pigment.xml')).text(); const raw = Buffer.from(await (await fetch(base + '/imaging/pigment.ibd')).arrayBuffer());
  assert.equal(raw.subarray(0, 16).toString('hex'), '0102030405060708090a0b0c0d0e0f10'); assert.equal(raw.readFloatLE(32), 0); assert.match(xml, /x="3"/); assert.doesNotMatch(xml, /x="2"/); assert.equal(raw.readDoubleLE(16), 100);
});
test('配对身份不符和区间长度不符不会修饰为正常谱图', async context => {
  const { base, control } = await withSource(context); await control({ wrongPair: true, badLength: true });
  const raw = Buffer.from(await (await fetch(base + '/imaging/pigment.ibd')).arrayBuffer()); assert.notEqual(raw[0], 1); assert.match(await (await fetch(base + '/imaging/pigment.xml')).text(), /externalLength="12"/);
});
