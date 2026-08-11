<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="yk-lens-graph-store-ts — yk-lens 的知识图谱存储层,TypeScript + Ladybug 官方 SDK,经 HTTP 提供图读写">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-active-brightgreen" alt="status: active">
  <img src="https://img.shields.io/badge/version-1.0.0-007ec6" alt="version 1.0.0">
</p>

**yk-lens 的知识图谱存储层**——用 TypeScript + Ladybug 官方 SDK(`@ladybugdb/core` ^0.19.1)实现,以 HTTP 服务(`:8702`)向 lensd 提供 Doc 规则图 / Concept / Theme 的图读写。

> 只有 **lensd** 能调用;前端 / Agent 禁止直连。本进程是图库文件的唯一打开者(单写者)。

## 背景:图谱是怎么来的

一个知识库会不断积累笔记。如果只把它们当文件存着,笔记之间的联系就丢了。于是系统把内容组织成一张**关系网络**:每篇笔记成为图里的"文档"节点;系统(结合人工)从文档中提炼出反复出现的"概念",统一收进词表;文档、概念、主题之间,由各种**关系**连接起来。

图里的节点、关系、属性分别是什么、从哪来(规则边 vs LLM 语义边),见 [API 文档 → 领域概念](docs/http-api.md#concepts)。

## 图模型

三张节点表、六种关系、两个关键属性:

| 类别 | 术语 | 说明 |
|------|------|------|
| node | `Doc` / `Concept` / `Theme` | 文档 / 概念词条 / 主题 |
| edge | `LINKS` | 文档间显式链接 |
| edge | `HAS_PARENT` | 文档父子层级 |
| edge | `MENTIONS` | 文档提及概念(带抽取/消歧置信度) |
| edge | `REL` | 概念间语义关系(带描述) |
| edge | `INCLUDES` / `CHILD_OF` | 主题收录 / 主题层级 |
| property | `tags` / `source` | 标签字段 / 边的来源(`rule`·`llm`·`human`) |

> ⚠️ `Theme` / `INCLUDES` / `CHILD_OF` 为**预留**:接口已就绪,当前业务尚未写入任何主题数据。

## 怎么用

- **图由上层概念抽取流程写入**——正常生产中,`Doc` 与 `LINKS`/`HAS_PARENT`/`tags` 由概念管线(无 LLM 的确定性投影)写入,本服务只负责存储与查询。
- **手工也可以**——概念词表(`source=rule`)、人工确认的提及(`source=human`)、调试与测试,都可以直接调写端点。
- **最小工作流**——6 步跑通"录笔记 → 建概念 → 记提及 → 建关系 → 查图谱",见 [API 文档 → 最小工作流](docs/http-api.md#quickstart)。

## 为什么这么设计

- **官方 SDK,零迁移**——`@ladybugdb/core` 是 Ladybug 官方 Node-API 原生模块,可直接打开已有数据目录,无需转换。
- **参数化 Cypher**——全部走 `prepare/execute` 参数化查询,不拼接 Cypher 字符串。
- **单写者 + 串行队列**——本进程独占图库文件;单连接非线程安全,所有操作经 promise 串行队列串行化。
- **幂等 DDL + 旧库迁移**——启动自动建表 / 迁移,可安全重入。

## 快速开始

```bash
npm install

cp configs/yk-graph-ts.example.yaml configs/yk-graph-ts.yaml
# 编辑 db_path(默认 ./data/ladybug,可直接指到现网数据目录)

npm run dev          # 或 ./scripts/dev.sh start
curl -s localhost:8702/v1/health
```

lensd 切换:`export LENS_GRAPH=http://localhost:8702`(dev.sh 已默认)。

## HTTP API

📚 **完整 API 文档 → [docs/http-api.md](docs/http-api.md)**

里面有:**19 个端点逐个的请求/响应示例、字段表、Cypher 与逐行解读**,外加**数据结构(DTO)总表**、**最小工作流**、**常见任务对照**。下面只是端点速查:

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/health` | 可达性 |
| `GET` | `/v1/status` | 后端状态(backend/reachable/docs) |
| `POST` | `/v1/graph/docs/upsert` | 全量替换 doc 图关系(tags + 规则边) |
| `DELETE` | `/v1/graph/docs/:id` | 删除 doc 及其全部关系 |
| `POST` | `/v1/graph/docs/remove-with-stats` | 带统计删除 → `{existed, edges}` |
| `GET` | `/v1/graph/docs/:id/related?depth=` | depth 1~2 关联文档 |
| `GET` | `/v1/graph/docs/:id/concepts` | 该 doc 的 MENTIONS 邻居 |
| `GET` | `/v1/graph/doc-edges` | 全部 doc→doc 规则边 |
| `GET` | `/v1/graph/doc-tags` | 全部 Doc 节点 tags |
| `POST` | `/v1/graph/concepts/upsert` | upsert concept |
| `GET` | `/v1/graph/concepts/:id` | 取 concept(404 = 不存在) |
| `GET` | `/v1/graph/concepts` | 全部 concepts |
| `POST` | `/v1/graph/concepts/mentions` | 只替换该 doc 的 llm mentions(human 保留) |
| `DELETE` | `/v1/graph/concepts/mentions/llm` | 失效该 doc 的 llm MENTIONS(body: `doc_id`) |
| `POST` | `/v1/graph/concepts/relations` | 幂等替换 concept REL 边 |
| `GET` | `/v1/graph/relations` | 全部 concept REL 边 |
| `POST` | `/v1/graph/themes/upsert` | upsert theme |
| `POST` | `/v1/graph/themes/membership` | 替换 theme 的 doc 成员 |
| `POST` | `/v1/admin/clear` | 清库(DROP 全表重建) |

最小可跑示例:

```bash
curl -s -X POST localhost:8702/v1/graph/docs/upsert -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE",
  "project": "inbox",
  "path": "inbox/notes/foo.md",
  "title": "foo",
  "tags": ["rrf"],
  "links": [{"target_id": "01HQSECOND", "rel": "link"}]
}'

curl -s "localhost:8702/v1/graph/docs/01HQEXAMPLE/related?depth=1"
```

## 目录

```text
src/
  index.ts              # 入口
  config.ts             # YAML + env
  types.ts              # DTO(请求 / 响应结构)
  api/server.ts         # Express HTTP
  store/graphStore.ts   # Ladybug 官方 SDK(DDL + 18 组方法)
configs/
scripts/dev.sh
docs/http-api.md        # 完整 API 文档(示例/字段/Cypher 解读/工作流)
assets/readme/          # README 视觉资产
```

## 测试

```bash
npm test          # vitest:DDL 幂等 + 每方法 round-trip + 旧库迁移 + clear(临时数据目录)
npm run typecheck
```

## 现状

- **阶段**:yk-lens 桌面阶段现行服务;是 lensd 图访问的唯一入口,前端 / Agent 一律不直连。
- **版本**:1.0.0(Node ≥ 20)。
- **启动**:仓库根 `./dev.sh start|status|stop` 一键起停(或本仓 `./scripts/dev.sh start`)。
- **端口**:`:8702`,与 yk-lens 其它服务并列——lensd `:8700` · coverto `:8701` · yk-vector-ts `:8703`。
- **数据**:图库目录默认 `./data/ladybug`(可用 `LENS_GRAPH_DATA` 覆盖);本进程独占图库文件,禁止第二个进程打开同一目录。

## 已知注意点

- `@ladybugdb/core` SDK 较年轻(2025-10 Kuzu 归档后 fork);升级需谨慎(重跑冒烟)。
- 构造 `Database` 需显式 `maxDBSize`(默认 8TB mmap 在受限环境失败,见 `graphStore.ts` 注释)。
- 参数名避免与 Cypher 保留字冲突(如 `DESC`);`description` 用 `$descr`。

## License

[MIT](./LICENSE)
