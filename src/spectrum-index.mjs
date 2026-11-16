// imzML 受限配对的索引解释：只解析合作来源约定内的 XML 结构，
// 不做峰识别或材料判定。解析失败一律抛错，由上层拒绝整份交付。

class IndexError extends Error {}

const TYPES = {
  float32: { width: 4, read: (buffer, offset) => buffer.readFloatLE(offset) },
  float64: { width: 8, read: (buffer, offset) => buffer.readDoubleLE(offset) },
};
const ROLES = ['mz', 'intensity'];
const COMPRESSIONS = ['none', 'zlib'];

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 返回根元素节点：{ name, attributes, children }
export function parseXml(text) {
  let position = 0;
  const whitespace = () => { while (position < text.length && /\s/.test(text[position])) position += 1; };
  const parseAttributes = (raw) => {
    const attributes = {};
    let cursor = 0;
    while (cursor < raw.length) {
      while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
      if (cursor === raw.length) break;
      const nameStart = cursor;
      while (cursor < raw.length && /[\w.-]/.test(raw[cursor])) cursor += 1;
      const name = raw.slice(nameStart, cursor);
      if (!/^[A-Za-z_]/.test(name)) throw new IndexError('索引 XML 属性格式无效');
      while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
      if (raw[cursor] !== '=') throw new IndexError('索引 XML 属性格式无效');
      cursor += 1;
      while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
      if (raw[cursor] !== '"') throw new IndexError('索引 XML 属性值应使用双引号');
      const valueStart = cursor + 1;
      const valueEnd = raw.indexOf('"', valueStart);
      if (valueEnd === -1) throw new IndexError('索引 XML 属性值未闭合');
      attributes[name] = decodeEntities(raw.slice(valueStart, valueEnd));
      cursor = valueEnd + 1;
    }
    return attributes;
  };
  const parseElement = () => {
    if (text[position] !== '<') throw new IndexError('索引 XML 缺少元素起始标记');
    position += 1;
    const start = position;
    while (position < text.length && /[\w.-]/.test(text[position])) position += 1;
    const name = text.slice(start, position);
    if (!name) throw new IndexError('索引 XML 元素名无效');
    const headerStart = position;
    while (position < text.length && text[position] !== '>') {
      if (text[position] === '<') throw new IndexError('索引 XML 标记未闭合');
      position += 1;
    }
    if (position >= text.length) throw new IndexError('索引 XML 标记未闭合');
    const header = text.slice(headerStart, position);
    const selfClosing = header.endsWith('/');
    const attributes = parseAttributes(selfClosing ? header.slice(0, -1) : header);
    position += 1;
    const children = [];
    if (!selfClosing) {
      for (;;) {
        whitespace();
        if (text.startsWith('</', position)) {
          position += 2;
          const closeStart = position;
          while (position < text.length && text[position] !== '>') position += 1;
          const closeName = text.slice(closeStart, position).trim();
          if (closeName !== name || position >= text.length) throw new IndexError('索引 XML 结束标记不匹配');
          position += 1;
          break;
        }
        if (text.startsWith('<!--', position)) {
          const end = text.indexOf('-->', position + 4);
          if (end === -1) throw new IndexError('索引 XML 注释未闭合');
          position = end + 3;
          continue;
        }
        if (text[position] === '<') children.push(parseElement());
        else throw new IndexError('索引 XML 含不支持的文本内容');
      }
    }
    return { name, attributes, children };
  };
  whitespace();
  while (text.startsWith('<?', position) || text.startsWith('<!--', position)) {
    const token = text.startsWith('<?', position) ? '?>' : '-->';
    const end = text.indexOf(token, position);
    if (end === -1) throw new IndexError('索引 XML 声明或注释未闭合');
    position = end + token.length;
    whitespace();
  }
  const root = parseElement();
  whitespace();
  if (position !== text.length) throw new IndexError('索引 XML 根元素后仍有内容');
  return root;
}

const integer = (value, label) => {
  if (!/^\d+$/.test(String(value))) throw new IndexError(`${label} 应为非负整数`);
  return Number(value);
};

function describe(element, reference) {
  const attributes = element.attributes;
  const type = attributes.type;
  if (!TYPES[type]) throw new IndexError(`数组 ${reference} 的类型不受支持: ${attributes.type}`);
  if (!ROLES.includes(attributes.role)) throw new IndexError(`数组 ${reference} 的角色不受支持: ${attributes.role}`);
  if (!COMPRESSIONS.includes(attributes.compression)) throw new IndexError(`数组 ${reference} 的压缩方式不受支持: ${attributes.compression}`);
  const count = integer(attributes.count, `数组 ${reference} 的 count`);
  const offset = integer(attributes.externalOffset, `数组 ${reference} 的 externalOffset`);
  const length = integer(attributes.externalLength, `数组 ${reference} 的 externalLength`);
  return { reference, id: attributes.id ?? null, offset, length, count, type, width: TYPES[type].width, role: attributes.role, compression: attributes.compression };
}

// 解释索引，返回配对 UUID 与所有数组描述、像素（含共享轴引用关系）
export function parseIndex(xmlText) {
  const root = parseXml(xmlText);
  if (root.name !== 'imaging') throw new IndexError('索引根元素应为 imaging');
  const ibdUuid = root.attributes.ibdUuid?.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(ibdUuid ?? '')) throw new IndexError('索引缺少合法的 ibdUuid');

  const arrayHolder = root.children.find(child => child.name === 'arrays');
  const sharedDescriptors = [];
  if (arrayHolder) {
    for (const element of arrayHolder.children) {
      if (element.name !== 'array') throw new IndexError('arrays 下只允许 array 元素');
      if (!element.attributes.id) throw new IndexError('共享数组缺少 id');
      sharedDescriptors.push(describe(element, `array#${element.attributes.id}`));
    }
  }
  const byId = new Map(sharedDescriptors.map(item => [item.id, item]));
  if (byId.size !== sharedDescriptors.length) throw new IndexError('共享数组 id 重复');

  const spectrumHolder = root.children.find(child => child.name === 'spectrumList');
  if (!spectrumHolder) throw new IndexError('索引缺少 spectrumList');
  const spectra = [];
  const seenCoordinates = new Set();
  for (const element of spectrumHolder.children) {
    if (element.name !== 'spectrum') throw new IndexError('spectrumList 下只允许 spectrum 元素');
    const coordinateElement = element.children.find(child => child.name === 'coordinate');
    if (!coordinateElement) throw new IndexError(`谱图 ${element.attributes.id ?? '?'} 缺少 coordinate`);
    const coordinate = ['x', 'y', 'z'].map(axis => integer(coordinateElement.attributes[axis], `谱图 ${element.attributes.id ?? '?'} 的坐标 ${axis}`));
    const coordinateKey = coordinate.join(',');
    if (seenCoordinates.has(coordinateKey)) throw new IndexError(`坐标 ${coordinateKey} 在索引中重复`);
    seenCoordinates.add(coordinateKey);

    const arrays = [];
    for (const dataArray of element.children.filter(child => child.name === 'binaryDataArray')) {
      if (dataArray.attributes.arrayRef !== undefined) {
        const target = byId.get(dataArray.attributes.arrayRef);
        if (!target) throw new IndexError(`谱图 ${element.attributes.id ?? '?'} 引用了不存在的数组 ${dataArray.attributes.arrayRef}`);
        arrays.push({ reference: `arrayRef#${dataArray.attributes.arrayRef}`, shared: true, descriptor: target });
      } else {
        const descriptor = describe(dataArray, `spectrum#${element.attributes.id ?? coordinateKey}`);
        arrays.push({ reference: descriptor.reference, shared: false, descriptor });
      }
    }
    const roles = arrays.map(item => item.descriptor.role).sort();
    if (roles.join(',') !== 'intensity,mz') throw new IndexError(`谱图 ${element.attributes.id ?? coordinateKey} 必须恰好包含 mz 与 intensity 各一个数组`);
    spectra.push({ id: element.attributes.id ?? null, coordinate, arrays });
  }
  if (spectra.length === 0) throw new IndexError('索引没有任何已采集位置');
  return { ibdUuid, sharedDescriptors, spectra };
}

export { IndexError, TYPES };
