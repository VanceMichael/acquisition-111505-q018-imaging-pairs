import { inflateSync } from 'node:zlib';
import { digest } from './archive.mjs';
import { request, decodeJson } from './transport.mjs';
import { parseIndex, IndexError, TYPES } from './spectrum-index.mjs';

export class CollectionError extends Error {}

// 按描述读取一个字节区间：区间边界、类型宽度与长度一起核对，
// 任何越界或长度不符都直接拒绝，绝不按相邻区间继续解释。
function extract(descriptor, ibd, reference) {
  const { offset, length, count, width, compression, type } = descriptor;
  if (offset < 16) throw new CollectionError(`${reference} 与 IBD 身份段重叠或起点非法`);
  const expected = count * width;
  if (compression === 'none' && length !== expected) {
    throw new CollectionError(`${reference} 长度 ${length} 与 count=${count}、type=${type} 需要的 ${expected} 字节不符`);
  }
  const end = offset + length;
  if (length === 0 || end > ibd.length) {
    throw new CollectionError(`${reference} 字节区间 [${offset}, ${end}) 超出 IBD 长度 ${ibd.length}`);
  }
  const packed = ibd.subarray(offset, end);
  let bytes;
  if (compression === 'zlib') {
    try { bytes = inflateSync(packed); }
    catch { throw new CollectionError(`${reference} zlib 解压失败`); }
  } else {
    bytes = packed;
  }
  if (bytes.length !== expected) {
    throw new CollectionError(`${reference} 解压后 ${bytes.length} 字节，与 count=${count}、type=${type} 需要的 ${expected} 字节不符`);
  }
  const read = TYPES[type].read;
  const values = new Array(count);
  for (let index = 0; index < count; index++) values[index] = read(bytes, index * width);
  return { values, bytes };
}

// 解释一份交付。所有校验先于归档写入：只要有一个区间损坏，整份交付拒绝，
// 已解析的其他位置也不会被落盘或移位解释。
export function openDelivery({ deliveryId, revision, indexText, ibd }) {
  let index;
  try { index = parseIndex(indexText); }
  catch (error) {
    if (error instanceof IndexError) throw new CollectionError(error.message);
    throw error;
  }
  if (ibd.length < 16) throw new CollectionError('IBD 不足 16 字节，缺少身份段');
  const fileUuid = ibd.subarray(0, 16).toString('hex');
  if (fileUuid !== index.ibdUuid) {
    throw new CollectionError(`配对身份不符：索引 ibdUuid=${index.ibdUuid}，IBD 身份段=${fileUuid}`);
  }

  // 同一描述只校验、解码一次；共享轴的多个引用复用同一结果，独立数组按区间去重。
  const decoded = new Map();
  const decodeOnce = (item) => {
    const { descriptor, reference } = item;
    const key = item.shared ? `shared:${descriptor.reference}` : `${descriptor.offset}:${descriptor.length}:${descriptor.role}`;
    if (!decoded.has(key)) decoded.set(key, extract(descriptor, ibd, reference));
    return decoded.get(key);
  };

  const pixels = index.spectra.map(spectrum => {
    const values = {};
    const provenance = [];
    for (const item of spectrum.arrays) {
      const result = decodeOnce(item);
      values[item.descriptor.role] = result.values;
      provenance.push({
        role: item.descriptor.role,
        shared: item.shared,
        reference: item.reference,
        type: item.descriptor.type,
        compression: item.descriptor.compression,
        count: item.descriptor.count,
        externalOffset: item.descriptor.offset,
        externalLength: item.descriptor.length,
        rangeSha256: digest(result.bytes),
      });
    }
    return {
      coordinate: spectrum.coordinate,
      spectrumId: spectrum.id,
      values,
      provenance,
    };
  });

  return {
    ibdUuid: index.ibdUuid,
    ibdLength: ibd.length,
    pixels,
  };
}

// 把已通过全部校验的交付写入归档：原始索引与 IBD 字节按摘要保管，
// 每个像素一条收件记录，逐区间登记所用字节的摘要与位置。
export async function receiveDelivery(archive, { deliveryId, revision, indexText, ibd }) {
  const opened = openDelivery({ deliveryId, revision, indexText, ibd });
  const indexBytes = Buffer.from(indexText);
  const indexSha256 = digest(indexBytes);
  const ibdSha256 = digest(ibd);
  await archive.accept('auto:index', { delivery: deliveryId }, {
    delivery: deliveryId, revision, ibdUuid: opened.ibdUuid, indexSha256, ibdSha256, ibdLength: opened.ibdLength,
  }, indexBytes);
  await archive.accept('auto:ibd', { delivery: deliveryId, ibdUuid: opened.ibdUuid }, {
    delivery: deliveryId, revision, ibdUuid: opened.ibdUuid, length: opened.ibdLength,
  }, ibd);

  const receipts = [];
  for (const pixel of opened.pixels) {
    const identity = { delivery: deliveryId, coordinate: pixel.coordinate };
    const data = {
      delivery: deliveryId,
      revision,
      coordinate: pixel.coordinate,
      spectrumId: pixel.spectrumId,
      ibdUuid: opened.ibdUuid,
      mz: pixel.values.mz,
      intensity: pixel.values.intensity,
      provenance: {
        indexSha256,
        ibdSha256,
        ranges: pixel.provenance,
      },
    };
    const receipt = await archive.accept('auto', identity, data, Buffer.from(JSON.stringify(data)));
    receipts.push({ identity, ...receipt });
  }
  return {
    delivery: deliveryId,
    revision,
    ibdUuid: opened.ibdUuid,
    indexSha256,
    ibdSha256,
    pixels: opened.pixels.length,
    coordinates: opened.pixels.map(pixel => pixel.coordinate),
    receipts,
  };
}

// 探查来源并逐份拉取配对文件；任何一份失败都中止整套接入，已写入的像素不跨交付混编。
export async function collectFromSource(archive, sourceUrl, configuration) {
  const base = new URL(sourceUrl);
  const probe = new URL(configuration.probe, base);
  let listing;
  try { listing = decodeJson(await request(probe.href)); }
  catch (error) { throw new CollectionError(`探查来源失败: ${error.message}`); }
  if (!Array.isArray(listing) || listing.length === 0) throw new CollectionError('来源没有可接收的交付');

  const accepted = [];
  for (const entry of listing) {
    for (const field of ['id', 'revision', 'index', 'data']) {
      if (entry[field] === undefined || entry[field] === null) throw new CollectionError(`来源交付条目缺少 ${field}`);
    }
    const indexResponse = await request(new URL(entry.index, base).href);
    if (indexResponse.status < 200 || indexResponse.status > 299) {
      throw new CollectionError(`交付 ${entry.id} 索引下载返回 ${indexResponse.status}`);
    }
    const ibdResponse = await request(new URL(entry.data, base).href);
    if (ibdResponse.status < 200 || ibdResponse.status > 299) {
      throw new CollectionError(`交付 ${entry.id} 数据下载返回 ${ibdResponse.status}`);
    }
    // 先完整解释再落盘：失败时该交付不会产生任何像素记录。
    const result = await receiveDelivery(archive, {
      deliveryId: String(entry.id),
      revision: entry.revision,
      indexText: indexResponse.bytes.toString('utf8'),
      ibd: ibdResponse.bytes,
    });
    accepted.push(result);
  }
  return { source: base.origin, accepted };
}
