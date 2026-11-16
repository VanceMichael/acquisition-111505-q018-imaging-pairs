# 合作来源约定

## 资料边界

交付为 imzML 风格的受限配对：XML 中 run/dataProcessing/spectrumList、spectrum 的 coordinate(x,y,z)、binaryDataArray；array 给 externalOffset、externalLength、count、type=float32|float64、role=mz|intensity、compression=none|zlib。IBD 前16字节是 UUID，与 XML 的 ibdUuid 一致。offset 以文件起点计，shared axis 通过 arrayRef 指向同一交付内定义。位置可稀疏。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/deliveries`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

## 自动接入的落实范围

`POST /api/collect` 按本约定实现自动接入，边界如下：

- 只解释本文列出的受限结构（imaging/arrays/spectrumList、coordinate、binaryDataArray 的既定属性），不识别峰、不判定材料，未知元素与属性直接拒绝。
- 配对身份以 IBD 前 16 字节与索引 `ibdUuid` 的逐字节比较为准，文件同名或同路径不构成配对依据；类型仅限 float32/float64，压缩仅限 none/zlib，长度必须与 count × 类型宽度一致（zlib 以解压后长度核对）。
- 每个区间先做起点与越界检查再解码，一个区间损坏时整份交付拒绝，已通过检查的其他像素也不落盘，杜绝按相邻字节移位解释。
- 位置稀疏性按索引原样保留：没有谱图的坐标不生成记录、不补零；数组中的零值是合法强度，正常解码保存。
- 每个像素的 provenance 同时记录索引与 IBD 的 sha256，以及各数组区间的偏移、长度和区间字节摘要，配合 blobs 中的原始字节即可追溯来源补交或改索引前后的差别。
