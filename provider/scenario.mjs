export const initialState = () => ({ name: '材料成像交付', revision: 1 });

import { readFile } from 'node:fs/promises';
export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/deliveries') { json(200, [{ id: 'pigment-a', revision: state.revision, index: '/imaging/pigment.xml', data: '/imaging/pigment.ibd' }]); return true; }
  if (url.pathname === '/imaging/pigment.xml') { let xml = await readFile(new URL('../fixtures/pigment.xml', import.meta.url), 'utf8'); if (state.badLength) xml = xml.replace('externalOffset="40" externalLength="8"', 'externalOffset="40" externalLength="12"'); bytes(200, xml, 'application/xml'); return true; }
  if (url.pathname === '/imaging/pigment.ibd') { let raw = await readFile(new URL('../fixtures/pigment.ibd', import.meta.url)); if (state.wrongPair) { raw = Buffer.from(raw); raw[0] ^= 1; } if (state.truncated) raw = raw.subarray(0, -3); bytes(200, raw); return true; }
  return false;
}
