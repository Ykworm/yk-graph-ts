# yk-graph-ts

**一句话**：给 lensd 用的 **图服务**（TypeScript + **Ladybug 官方 SDK** `@ladybugdb/core`）——Doc 规则图 / Concept / Theme 的图读写，替代 lensd 里的 cgo 绑定（`system_ladybug` + `lib-ladybug`）。

HTTP 契约与 [`graph_ladybug.go`](../yk-lens-go/internal/store/graph_ladybug.go) 的 Go 方法 **1:1 对应**（见 [docs/11-GRAPH-SERVICE-SPLIT.md](../yk-lens-go/docs/11-GRAPH-SERVICE-SPLIT.md)）。

---

## 为什么是 TS

Ladybug **官方 TS SDK** 是 Node-API 原生模块（自带 `lbug.d.ts`，含 darwin-arm64 平台包），与现网 `lib-ladybug/liblbug.0.19.1.dylib` 同版本（0.19.1），**可直接打开现网数据目录，零迁移**。模式与 `yk-vector-ts/`（LanceDB TS SDK + HTTP）完全一致。

---

## 先记住

| 要点 | 说明 |
|------|------|
| 默认端口 | **`:8702`** |
| 谁可以调 | **只有 lensd**（HTTP）。前端 / Agent **禁止**直连 |
| 存储 | Ladybug 本地目录（`db_path`）；默认 `./data/ladybug`，可直接指向现网 `yk-lens-go/data/ladybug` |
| 单写者 | **本进程是图库文件唯一打开者**；lensd 不再碰图文件。禁止第二个进程开同一目录 |
| Cypher | 全部在本服务内、**参数化查询**；写操作串行（单连接） |
| 权威文档 | [`docs/11-GRAPH-SERVICE-SPLIT.md`](../yk-lens-go/docs/11-GRAPH-SERVICE-SPLIT.md) |

---

## 快速启动

```bash
cd yk-graph-ts
npm install

cp configs/yk-graph-ts.example.yaml configs/yk-graph-ts.yaml
# 用 IDE 打开 configs/yk-graph-ts.yaml，把 db_path 指到现网数据目录（或保持默认）

npm run dev
# 或
./scripts/dev.sh start
```

生产构建：

```bash
npm run build
node dist/index.js --config configs/yk-graph-ts.yaml
```

lensd 切换：

```bash
export LENS_GRAPH=http://localhost:8702   # dev.sh 已默认；手动起 lensd 时用 -graph
```

---

## HTTP

| 方法 | 路径 | 说明（对齐 Go 方法） |
|------|------|------|
| `GET` | `/v1/health` | 可达性 |
| `GET` | `/v1/status` | `BackendStatus`（backend/reachable/docs） |
| `POST` | `/v1/graph/docs/upsert` | `UpsertDoc`：全量替换 doc 图关系（tags + 规则边） |
| `DELETE` | `/v1/graph/docs/:id` | `RemoveDoc` |
| `POST` | `/v1/graph/docs/remove-with-stats` | `RemoveDocWithStats` → `{existed, edges}` |
| `GET` | `/v1/graph/docs/:id/related?depth=` | `Related`（depth 1~2） |
| `GET` | `/v1/graph/docs/:id/concepts` | `RelatedConcepts`（MENTIONS 邻居） |
| `GET` | `/v1/graph/doc-edges` | `ListDocEdges` |
| `GET` | `/v1/graph/doc-tags` | `ListDocTags` |
| `POST` | `/v1/graph/concepts/upsert` | `UpsertConcept` |
| `GET` | `/v1/graph/concepts/:id` | `GetConcept`（404 = 不存在） |
| `GET` | `/v1/graph/concepts` | `ListConcepts` |
| `POST` | `/v1/graph/concepts/mentions` | `PatchMentions`（只替换 llm，human 保留） |
| `DELETE` | `/v1/graph/concepts/mentions/llm` | `RemoveLLMMentions`（body: `doc_id`） |
| `POST` | `/v1/graph/concepts/relations` | `PatchRelations` |
| `GET` | `/v1/graph/relations` | `ListRelations` |
| `POST` | `/v1/graph/themes/upsert` | `UpsertTheme` |
| `POST` | `/v1/graph/themes/membership` | `PatchThemeMembership` |
| `POST` | `/v1/admin/clear` | 清库（DROP 全表重建；供 `concept-clear`） |

```bash
curl -s localhost:8702/v1/health

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

---

## 目录

```text
src/
  index.ts              # 入口
  config.ts             # YAML + env
  types.ts              # DTO（JSON 字段与 Go struct 对齐）
  api/server.ts         # Express HTTP
  store/graphStore.ts   # Ladybug 官方 SDK（DDL + 18 组方法）
configs/
scripts/dev.sh
```

---

## 测试

```bash
npm test          # vitest：DDL 幂等 + 每方法 round-trip + 旧库迁移 + clear（临时数据目录）
npm run typecheck
```

---

## 已知注意点

- `@ladybugdb/core` SDK 较年轻（2025-10 Kuzu 归档后 fork）；升级版本需谨慎（重跑冒烟）。
- 构造 `Database` 需显式 `maxDBSize`（默认 8TB mmap 在受限环境失败，见 `graphStore.ts` 注释）。
- 参数名避免与 Cypher 保留字冲突（如 `DESC`）；`description` 用 `$descr`。
