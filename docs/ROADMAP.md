# Roadmap — yk-lens-graph-store-ts

> 服务定位:yk-lens 的知识图谱存储层,同时是**独立的 HTTP 图服务**——任何客户端都可直接调用。
> 本文记录「通用 API」的演进计划;领域语义端点的改动见文末[原则](#原则非通用-api-不动)。

## 原则:非通用 API 不动

以下端点承载**领域语义**(与上层概念抽取流程绑定,非通用图操作),保持现状,**不在本 Roadmap 的增补范围**:

- `GET /v1/graph/docs/:id/related`(关联语义:共同标签 / 链接至 / 链接自)
- `GET /v1/graph/docs/:id/concepts`、`POST /v1/graph/concepts/mentions`、`DELETE /v1/graph/concepts/mentions/llm`(MENTIONS 半替换,human 保留)
- `POST /v1/graph/concepts/relations`(REL 幂等写)
- `POST /v1/graph/themes/membership`(INCLUDES 全量替换)

新增通用能力时,不得改变这些端点的行为与返回结构。

## 已完成

- [x] **OpenAPI 契约** — `docs/openapi.yaml`:19 个端点 + 19 个 DTO 的机器可读定义,供客户端生成 / coding agent 消费。README 有入口。
- [x] 文档门户化 — `docs/http-api.md`:背景 / 领域概念 / 图 Schema / DTO / 最小工作流 / 常见任务对照 / 19 端点逐一的请求响应示例与 Cypher 解读。

## 通用 API 待补(按优先级)

### P0 — 生产化(独立服务上服务器前必须)

- [ ] **写路径错误真实传播** — 当前写错误被软忽略(单条失败静默吞掉),写 API 永远返回 `ok:true`,调用方无法感知写入失败。应让错误真实返回 `{ok:false,error}` + 日志 / 计数。
- [ ] **多语句写操作加事务** — `docs/upsert`、`concepts/mentions`、`concepts/relations` 均为 MERGE/DELETE/CREATE 组合,现无事务,中途崩溃会留下撕裂状态。用 `BEGIN/COMMIT` 封装,配合单连接串行队列保证正确性。
- [ ] **监听地址收敛 + admin 鉴权** — 默认绑定 `127.0.0.1`(当前 `:8702` 解析为 0.0.0.0),admin 端点(`/v1/admin/clear`)加共享密钥 / Token,防止局域网任意主机触发清库。
- [ ] **HTTP 层测试覆盖** — 当前测试集中在 store 层,`server.ts` 的路由、状态码、错误中间件、请求验证分支未测。
- [ ] **请求体验证 schema 化** — 现靠手动 `throw new Error("必填：...")` + `req.body as X`;引入 zod/ajv 统一校验,返回字段级 400。
- [ ] **修复 / 删除 Theme 空测试** — `graphStore.test.ts` 中 Theme 测试为 `expect(true).toBe(true)`,不证明任何行为;改为写后读回或删除。
- [ ] **干净关机** — `index.ts` 未 await `server.close()` 与队列排空,`process.exit(0)` 会切断在途写入。加关闭钩子:停监听 → 排空串行队列 → close store。
- [ ] **结构化日志 / 指标** — 当前仅 `console.log` / `console.error`;至少引入结构化日志与基础请求指标。
- [ ] **CI 配置** — 无 `.github/workflows` 或等效自动化,`typecheck` / `test` / `build` 全靠本地执行。
- [ ] **构建产物一致性** — `dist/` 可能为陈旧产物,`npm start` 会跑旧代码;start 前自动 build 或加产物校验。

### P1 — 图服务核心能力缺失(当前覆盖度最弱)

- [ ] **任意只读查询端点** — `POST /v1/graph/query`(body: `{cypher, params?}`),开放 Cypher 只读查询。Ladybug 本身是 Cypher 图库,但当前只暴露预置端点,路径 / 遍历 / 按任意属性过滤都做不了。**只读 + 参数化 + 结果上限**,禁止 DDL/DELETE。
- [ ] **通用边 CRUD** — 不依赖节点类型的边操作:
  - `POST /v1/graph/edges`(建一条任意类型的边)
  - `DELETE /v1/graph/edges`(删指定 from-to-type 的边)
  - `GET /v1/graph/edges?from=&to=&type=`(查两点之间/全图边)
- [ ] **孤儿/占位节点清理** — `POST /v1/graph/maintenance/prune-orphans`(清理只为建链而自动占位、从未被 upsert 的空节点)。

### P2 — 规模化可用性

- [ ] **批量 upsert** — `docs/upsert` / `concepts/upsert` 支持数组入参,或新增批量端点。
- [ ] **列表端点分页/过滤/排序** — `concepts`、`doc-edges`、`relations`、`doc-tags` 支持 `limit/offset`(或 cursor)、按属性过滤、排序。
- [ ] **节点局部更新(PATCH)** — 目前 upsert 是全量覆盖,缺"只改 title 不动 tags/links"的语义。

### P3 — 观测性

- [ ] **细粒度统计** — `GET /v1/graph/stats`:各节点/关系类型的计数(现状 `status` 只有 docs 数)。
- [ ] **事务/原子性说明** — 文档明确多语句写操作(如 upsert 的先删后建)非原子、单条语句失败不影响整体的边界。

## 待讨论(方向性)

- 领域模型是否模板化/可配置(Entity 模板),让更多知识管理 / 笔记类场景直接复用。
- 图存储底座 `@ladybugdb/core`(Kuzu fork)的长期风险与接口抽象策略。
