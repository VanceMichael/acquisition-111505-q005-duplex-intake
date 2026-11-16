# 双面扫描交接流的册件归属与补页接收

这是面向资料接收人员的 Node.js 服务。它同时提供两路收件：人工确认过的单册登记，以及从扫描网关自动收件。自动收件按册件标记、纸张身份和正反面关系重建每一册，区分空白面、未到面与操作员剔除的页，保留原始图像和归属变更；仍有歧义时进入人工处理队列。本地来源独立提供合作方交互环境。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口、扫描重建与来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；`SOURCE_URL` 指定默认扫描网关，默认 `http://127.0.0.1:4200/`。`npm run demo` 使用临时目录和系统分配端口展示人工收件与自动收件的完整流程，结束即清理，通常只需数秒。

## 容器

`docker build -t duplex-intake:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 duplex-intake:local` 启动。环境准备后，`docker run --rm --network none duplex-intake:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

- `GET /health` 检查进程。
- `POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象；`GET /api/records` 查询全部人工收件版本。
- `POST /api/collect` 从扫描网关增量收件，请求体可带 `{"source": "http://host:port/"}`。响应列出每册的状态、版本、缺失面数与待复核数。
- `GET /api/review` 列出仍待人工处理的归属或完整性问题。
- `POST /api/review` 提交人工决定 `{sheetId, scannerSession, book, decisionId, source?}`，随后按默认来源再采集一次。
- `GET /api/blobs/{sha256}` 取回归档中的原始图像字节。

人工记录身份字段仍为 book, sheet。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。自动收件身份为 `book`，按扫描会话记录在 `scannerSession` 字段；已见事件追加到 `state/ledger.json`，人工决定追加到 `state/decisions.ndjson`，图像按摘要存入 `blobs`。

`src/` 为收件、扫描重建与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围、面状态与归属规则见 `docs/source-contract.md`。
