import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createIntake } from '../src/server.mjs';
import { Archive } from '../src/archive.mjs';
import { createProvider } from '../provider/server.mjs';
import { collectFromSource, openDelivery } from '../src/collect.mjs';
import { parseIndex } from '../src/spectrum-index.mjs';

const configuration = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));

async function withPair(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    intakeUrl: `http://127.0.0.1:${intake.address().port}`,
    sourceUrl: `http://127.0.0.1:${provider.address().port}`,
    control: value => fetch(`http://127.0.0.1:${provider.address().port}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }),
  };
}

test('自动采集按坐标落盘像素并保留共享轴、零强度与原始字节出处', async context => {
  const { directory, intakeUrl, sourceUrl } = await withPair(context);
  const response = await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceUrl }) });
  assert.equal(response.status, 201);
  const summary = await response.json();
  assert.equal(summary.accepted.length, 1);
  assert.deepEqual(summary.accepted[0].coordinates, [[1, 1, 1], [3, 1, 1]]);

  const archive = await new Archive(directory).initialize();
  const records = await archive.list();
  const pixels = records.filter(record => record.source === 'auto');
  assert.equal(pixels.length, 2);
  const first = pixels.find(record => record.identity.coordinate.join(',') === '1,1,1').versions[0].data;
  assert.deepEqual(first.mz, [100, 101]);
  assert.deepEqual(first.intensity, [0, 4]); // 合法零强度保留，没有被丢弃或补造
  const second = pixels.find(record => record.identity.coordinate.join(',') === '3,1,1').versions[0].data;
  assert.deepEqual(second.intensity, [5, 6]);

  // 共享质量轴：两个像素引用同一区间与同一份字节摘要
  const firstAxis = first.provenance.ranges.find(item => item.role === 'mz');
  const secondAxis = second.provenance.ranges.find(item => item.role === 'mz');
  assert.equal(firstAxis.shared, true);
  assert.equal(firstAxis.externalOffset, 16);
  assert.equal(firstAxis.rangeSha256, secondAxis.rangeSha256);
  const intensityRange = first.provenance.ranges.find(item => item.role === 'intensity');
  assert.equal(intensityRange.type, 'float32');
  assert.equal(intensityRange.externalOffset, 32);

  // 每个像素可追溯到具体的索引与 IBD 原始字节
  const indexRecord = records.find(record => record.source === 'auto:index');
  const ibdRecord = records.find(record => record.source === 'auto:ibd');
  assert.equal(indexRecord.versions[0].data.ibdSha256, first.provenance.ibdSha256);
  assert.equal(ibdRecord.versions[0].data.ibdUuid, first.ibdUuid);
  const storedIbd = await archive.bytes(first.provenance.ibdSha256);
  const fixtureIbd = await readFile(new URL('../fixtures/pigment.ibd', import.meta.url));
  assert.ok(storedIbd.equals(fixtureIbd));
  const storedIndex = await archive.bytes(first.provenance.indexSha256);
  assert.match(storedIndex.toString('utf8'), /ibdUuid="0102030405060708090a0b0c0d0e0f10"/);
});

test('重复采集复用版本，来源修订后保留新版本且可追溯', async context => {
  const { intakeUrl, sourceUrl, control } = await withPair(context);
  const first = await (await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceUrl }) })).json();
  assert.equal(first.accepted[0].receipts.every(item => item.duplicate === false), true);
  const again = await (await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceUrl }) })).json();
  assert.equal(again.accepted[0].receipts.every(item => item.duplicate === true), true);

  await control({ revision: 2 });
  const revised = await (await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceUrl }) })).json();
  assert.equal(revised.accepted[0].revision, 2);
  // 用 HTTP 查询确认同一像素身份下保留了两个版本
  const records = await (await fetch(intakeUrl + '/api/records')).json();
  const pixel = records.find(record => record.source === 'auto' && record.identity.coordinate.join(',') === '1,1,1');
  assert.equal(pixel.versions.length, 2);
  assert.equal(pixel.versions[0].data.revision, 1);
  assert.equal(pixel.versions[1].data.revision, 2);
});

test('配对身份不符时整套拒绝且不写入任何像素', async context => {
  const { directory, intakeUrl, sourceUrl, control } = await withPair(context);
  await control({ wrongPair: true });
  const response = await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceUrl }) });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /配对身份不符/);
  const archive = await new Archive(directory).initialize();
  assert.deepEqual(await archive.list(), []);
});

test('区间长度与类型/count 不符时拒绝，不把相邻字节移位解释', async context => {
  const { directory, intakeUrl, sourceUrl, control } = await withPair(context);
  await control({ badLength: true });
  const response = await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceUrl }) });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /长度 12 .* 需要的 8 字节不符/);
  const archive = await new Archive(directory).initialize();
  assert.deepEqual(await archive.list(), []);
});

test('区间越界（截断的 IBD）时整套拒绝', async context => {
  const { directory, intakeUrl, sourceUrl, control } = await withPair(context);
  await control({ truncated: true });
  const response = await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceUrl }) });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /超出 IBD 长度/);
  const archive = await new Archive(directory).initialize();
  assert.deepEqual(await archive.list(), []);
});

test('默认来源地址与非法来源都被明确拒绝', async context => {
  const { intakeUrl } = await withPair(context);
  const badSource = await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'http://127.0.0.1:9' }) });
  assert.equal(badSource.status, 422);
  assert.match((await badSource.json()).error, /探查来源失败/);
  const malformed = await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const invalidUrl = await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'not-a-url' }) });
  assert.equal(invalidUrl.status, 400);
  assert.match((await invalidUrl.json()).error, /来源地址无效/);
});

test('自动与人工来源互不混淆', async context => {
  const { intakeUrl, sourceUrl } = await withPair(context);
  await fetch(intakeUrl + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceUrl }) });
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const manual = await fetch(intakeUrl + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  assert.equal(manual.status, 201);
  const records = await (await fetch(intakeUrl + '/api/records')).json();
  const matching = records.filter(record => ['auto', 'manual'].includes(record.source) && record.identity.delivery === 'pigment-a' && (record.identity.coordinate ?? [1, 1, 1]).join(',') === '1,1,1');
  assert.deepEqual(matching.map(record => record.source).sort(), ['auto', 'manual']);
});

// ---- 直接单元测试：独立轴、zlib 与结构校验，不依赖来源服务 ----

function buildIbd(uuid, sections) {
  const parts = [Buffer.from(uuid, 'hex')];
  let cursor = 16;
  const descriptors = sections.map(section => {
    const offset = cursor;
    parts.push(section.bytes);
    cursor += section.bytes.length;
    return { ...section, offset, length: section.bytes.length };
  });
  return { ibd: Buffer.concat(parts), descriptors };
}

test('独立质量轴与 zlib 压缩数组可被解释，稀疏位置不补零', () => {
  const uuid = '11223344556677889900aabbccddeeff';
  const mz = Buffer.alloc(16); mz.writeDoubleLE(10, 0); mz.writeDoubleLE(20, 8);
  const intensityValues = Buffer.alloc(8); intensityValues.writeFloatLE(0, 0); intensityValues.writeFloatLE(7, 4);
  const packed = deflateSync(intensityValues);
  const { ibd, descriptors } = buildIbd(uuid, [{ bytes: mz }, { bytes: packed }]);
  const xml = `<?xml version="1.0"?><imaging ibdUuid="${uuid}"><spectrumList>`
    + `<spectrum id="s7"><coordinate x="7" y="2" z="1"/>`
    + `<binaryDataArray externalOffset="${descriptors[0].offset}" externalLength="${descriptors[0].length}" count="2" type="float64" role="mz" compression="none"/>`
    + `<binaryDataArray externalOffset="${descriptors[1].offset}" externalLength="${descriptors[1].length}" count="2" type="float32" role="intensity" compression="zlib"/>`
    + `</spectrum></spectrumList></imaging>`;
  const opened = openDelivery({ deliveryId: 'd', revision: 1, indexText: xml, ibd });
  assert.equal(opened.pixels.length, 1);
  assert.deepEqual(opened.pixels[0].values.mz, [10, 20]);
  assert.deepEqual(opened.pixels[0].values.intensity, [0, 7]);
  const intensityProvenance = opened.pixels[0].provenance.find(item => item.role === 'intensity');
  assert.equal(intensityProvenance.compression, 'zlib');
  assert.equal(intensityProvenance.externalLength, packed.length);
  assert.equal(intensityProvenance.rangeSha256, createHash('sha256').update(intensityValues).digest('hex'));
});

test('结构与引用错误在解释阶段被拒绝', () => {
  const uuid = '11223344556677889900aabbccddeeff';
  const ibd = Buffer.from(uuid, 'hex');
  const base = (body, id = uuid) => `<?xml version="1.0"?><imaging ibdUuid="${id}">${body}</imaging>`;
  assert.throws(() => parseIndex(base('<spectrumList></spectrumList>')), /没有任何已采集位置/);
  assert.throws(() => parseIndex(base('<spectrumList><spectrum><coordinate x="1" y="1" z="1"/><binaryDataArray arrayRef="missing"/></spectrum></spectrumList>')), /引用了不存在的数组/);
  assert.throws(() => parseIndex(base('<spectrumList><spectrum><coordinate x="1" y="1" z="1"/></spectrum></spectrumList>')), /mz 与 intensity/);
  assert.throws(() => parseIndex(base('<spectrumList><spectrum><coordinate x="1" y="1" z="1"/><binaryDataArray externalOffset="16" externalLength="4" count="1" type="float32" role="mz" compression="none"/></spectrum></spectrumList>')), /mz 与 intensity/);
  assert.throws(() => parseIndex('<?xml version="1.0"?><imaging><spectrumList/></imaging>'), /ibdUuid/);
  assert.throws(() => openDelivery({ deliveryId: 'd', revision: 1, indexText: base('<spectrumList><spectrum><coordinate x="1" y="1" z="1"/><binaryDataArray externalOffset="16" externalLength="4" count="1" type="float32" role="mz" compression="none"/><binaryDataArray externalOffset="20" externalLength="4" count="1" type="float32" role="intensity" compression="none"/></spectrum></spectrumList>'), ibd }), /超出 IBD 长度/);
  const wrongUuid = '00000000000000000000000000000000';
  assert.throws(() => openDelivery({ deliveryId: 'd', revision: 1, indexText: base('<spectrumList><spectrum><coordinate x="1" y="1" z="1"/><binaryDataArray externalOffset="16" externalLength="4" count="1" type="float32" role="mz" compression="none"/><binaryDataArray externalOffset="20" externalLength="4" count="1" type="float32" role="intensity" compression="none"/></spectrum></spectrumList>', wrongUuid), ibd }), /配对身份不符/);
});

test('探查返回空清单时拒绝接入', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-empty-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = await new Archive(directory).initialize();
  await assert.rejects(collectFromSource(archive, 'http://127.0.0.1:9', configuration), /探查来源失败|来源没有可接收的交付/);
});
