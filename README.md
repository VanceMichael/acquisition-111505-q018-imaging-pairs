# 成像检测交付的坐标谱图与外置数据配对采集

这是面向资料接收人员的 Node.js 服务。提供人工收件、自动来源成套接入、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。自动接入只解释索引与字节区间并按坐标落盘，不做峰识别或材料判定。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；自动采集的默认来源地址可用 `SOURCE_URL` 覆盖。`npm run demo` 使用临时目录和系统分配端口展示来源探查、自动采集（含共享轴与零强度的像素出处）与人工收件，结束即清理，通常只需数秒。

## 容器

`docker build -t imaging-pairs:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 imaging-pairs:local` 启动。环境准备后，`docker run --rm --network none imaging-pairs:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部收件版本，`GET /health` 检查进程。人工记录身份字段为 delivery, coordinate。

`POST /api/collect` 触发一次自动来源成套接入，请求体可给 `{"source": "<来源地址>"}`，缺省使用 `SOURCE_URL` 或 `http://127.0.0.1:4200`。服务先探查来源的 `/deliveries`，逐份下载索引与 IBD，全部校验通过后才写入归档；任何一份交付的配对身份、数组类型/长度或字节区间不合格，整套以 422 拒绝且该交付不产生任何像素记录，来源不可达返回 422/探查失败说明，不会把坏数据修饰成正常谱图。

自动采集的归档约定：每个采到的坐标是一条 `source=auto` 的像素记录（身份为 delivery + coordinate），数值按索引声明的 float32/float64 小端解码，合法零强度原样保留，索引中不存在的位置不补全、不造零；共享质量轴经 `arrayRef` 复用同一份解码字节，独立轴按各自区间读取。像素数据的 `provenance` 登记索引摘要、IBD 摘要，以及每个数组的角色、共享标记、引用、类型、压缩方式、count、externalOffset、externalLength 和该区间实际字节的 sha256，可追溯每个像素使用的原始字节；原始索引与整份 IBD 另以 `auto:index`、`auto:ibd` 记录按摘要保管。来源补交或改索引后再次采集，同一身份内容不变则复用版本，内容变化保留全部历史版本。`auto*` 与 `manual` 来源键不同，同一业务身份也不会互相覆盖。

归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。`src/` 为收件与传输（`spectrum-index.mjs` 解释受限 imzML 索引，`collect.mjs` 负责配对校验、区间解码与出处登记），`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构。
