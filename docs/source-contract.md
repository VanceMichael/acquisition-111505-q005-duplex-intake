# 合作来源约定

## 资料边界

/scan/events 为 NDJSON，type 包括 beginBook、sheet、side、blankSide、rescan、reassign、sealBook。sheetId 在 scannerSession 内唯一，front/back 独立到达；image href 的内容有 sha256。sealBook 声明 expectedSheets 和 manifestRevision，不承诺网络上此前事件已全到达。rescan 指向被替换 sideRevision，reassign 指定 sourceBook、targetBook、decisionId。/scan/images/{id} 是不变字节。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/scan/events`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

## 自动收件的解释约定

`src/scanner.mjs` 把网关事件整理成册件，`src/collector.mjs` 负责取图、落盘和人工决定。约定如下：

- 册件身份为 `book`；纸张身份为 `scannerSession + sheetId`。事件缺少 `scannerSession` 时按纸张编号回退匹配，仍不唯一则进入人工处理。
- 面状态只有 `present`、`blank`、`excluded`、`unverified`、`unavailable`、`pending`、`missing`。`blank` 来自 `blankSide` 判定，`pending` 表示尚无信息，`missing` 表示已封册但仍未到达。空白不等于缺失，也不等于没有记录。
- 侧别版本以 `sideRevision` 递增，`rescan` 用 `replaces` 指认旧版本。旧图保留为 `superseded`，新图是 `current`，任何版本都不覆盖。
- `reassign` 是操作员的移册决定，来源册保留 `transfersOut` 快照（含图像版本），目标册保留 `originBook` 与转移动机。
- 已封册的册件只接受 `expectedSheets` 内的纸张。封册后首次出现且不在清单内的纸张进入 `rejected`，保留原始图像和 `sealed-book-new-sheet` 争议，不会出现在该册的 `sheets` 中，也不会让册件显示为完整。
- 指向已封册册件的 `reassign` 记为 `sealed-target` 争议，等待人工确认。
- 未能识别的 `type` 原样留在 `events` 与 `unrecognized`，并给出警告，不静默丢弃。
- 图像内容与声明 sha256 不符时仍按实际内容保管，面状态为 `unverified` 并进入复查。
- 每次采集把已见事件写入 `state/ledger.json`，重复批次不会产生新版本；抓取失败不会推进台账。
- 人工决定（`POST /api/review`）追加写入 `state/decisions.ndjson`，优先于网关声明，应用后同时留下快照和 `resolution`。

`GET /api/review` 汇总所有仍待人工处理的册件与纸张；可以消除的归属争议由人工决定解决，无法归属的材料保持在原册的 `rejected` 中等待处置。
