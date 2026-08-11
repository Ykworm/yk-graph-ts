# HTTP API — yk-graph-ts

图服务 HTTP 契约(`:8702`)。所有端点仅允许 **lensd** 调用;参数化 Cypher 全部在服务内完成,外部只传 JSON。

## 通用约定

- **基础路径**:`http://localhost:8702`;请求体一律 `application/json`(上限 16MB)。
- **统一错误格式**:`{ "ok": false, "error": "<消息>" }` — 缺必填字段 → `400`,其余异常 → `500`。
- **写语义**:所有写操作经内部串行队列执行(单连接非线程安全);图语句单条软失败不影响整体语义(对齐既有行为)。
- **全量替换 vs 增量**:标"全量替换"的端点会**先删旧边再建新边**;标"幂等写"的端点只保证重复调用结果一致,不动无关数据。各端点行为见下。

---

## 健康 / 状态

### GET /v1/health

可达性探测。返回图库后端类型与可达性;若查询文档数失败,则 `reachable=false` 并回 `503`。

```bash
curl -s localhost:8702/v1/health
```

```json
{ "ok": true, "backend": "ladybug" }
```

图库故障时:

```json
{ "ok": false, "backend": "ladybug" }
```

**行为说明**:
1. 调用图库统计 `Doc` 节点数;
2. 成功 → `reachable=true`,回 `200`;
3. 任何查询异常(连接失效 / 查询抛错)→ `reachable=false`,回 `503`。

### GET /v1/status

后端状态详情(与 health 相同的数据源,但**始终回 `200`**,如实上报可达性,不转成错误码)。

```bash
curl -s localhost:8702/v1/status
```

```json
{ "backend": "ladybug", "reachable": true, "docs": 128 }
```

---

## Doc 规则图

### POST /v1/graph/docs/upsert

**全量替换一篇文档的图关系**:节点属性整体覆盖 + 规则出边(LINKS / HAS_PARENT)先删后建。

```bash
curl -s -X POST localhost:8702/v1/graph/docs/upsert -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE",
  "project": "inbox",
  "path": "inbox/notes/foo.md",
  "title": "foo",
  "tags": ["rrf"],
  "links": [
    { "target_id": "01HQSECOND", "rel": "link" },
    { "target_id": "01HQPARENT", "rel": "parent" }
  ]
}'
```

**行为说明**:
1. `MERGE` Doc 节点(`doc_id` 为唯一键),并 `SET` 覆盖 `title` / `path` / `project` / `tags`(`tags` 数组以逗号拼接存入);
2. 删除该文档的全部 `LINKS` **出边**;
3. 删除该文档的全部 `HAS_PARENT` **出边**;
4. 逐条处理 `links`:
   - 跳过空 `target_id`,以及 `target_id == doc_id` 的**自环**;
   - 目标文档可能尚未入库,自动 `MERGE` 一个**占位节点**(标题等属性留待后续 upsert 补全);
   - `rel == "parent"` 建 `HAS_PARENT` 边,否则建 `LINKS` 边(不入参非 `parent` 一律视作 `link`);
5. 只动**出边**——其它文档指向本文档的入边不受影响;`MENTIONS` / `INCLUDES` / `REL` 等其它关系本端点一律不碰。

响应:

```json
{ "ok": true }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `doc_id` | string | 必填,文档稳定 ID |
| `project` / `path` / `title` | string | 可选,覆盖式写入 |
| `tags` | string[] | 可选;逗号拼接存为 Doc 节点属性 |
| `links[].target_id` | string | 可选;自环与空值跳过 |
| `links[].rel` | string | 可选;`parent` → `HAS_PARENT`,其余 → `LINKS` |

### DELETE /v1/graph/docs/:id

删除文档节点及其**全部关系边**(出边 + 入边),不留悬挂边。

```bash
curl -s -X DELETE localhost:8702/v1/graph/docs/01HQEXAMPLE
```

**行为说明**:
1. 按 ID 命中节点后执行 `DETACH DELETE` — 连带清除该节点的全部出/入关系,包括**其它文档指向被删文档的边**(如 `LINKS` 入边、`MENTIONS` 入边等),图库不会残留指向不存在节点的悬挂边;
2. 文档不存在时同样回 `{ok:true}`(幂等,不报错)。

```json
{ "ok": true }
```

### POST /v1/graph/docs/remove-with-stats

与 DELETE 相同的删除语义,但先统计存在性与边数再删,供调用方感知影响范围。

```bash
curl -s -X POST localhost:8702/v1/graph/docs/remove-with-stats \
  -H 'Content-Type: application/json' -d '{"doc_id": "01HQEXAMPLE"}'
```

**行为说明**:
1. 计数该 `Doc` 节点是否存在;
2. 不存在 → 直接返回 `{ "existed": false, "edges": 0 }`,不做任何删除;
3. 存在 → 先统计其全部关系边数(`edges` 含出边与入边),再 `DETACH DELETE`,返回删除前的边数。

```json
{ "existed": true, "edges": 7 }
```

### GET /v1/graph/docs/:id/related?depth=

查找 `depth` 层内的关联文档。**关联由三类来源构成,结果去重、按发现顺序返回**;`depth` 钳制在 1~2。

```bash
curl -s "localhost:8702/v1/graph/docs/01HQEXAMPLE/related?depth=1"
```

**行为说明**:
1. `depth` 强制钳制:小于 1 视为 1,大于 2 视为 2;
2. 以目标文档为起点做广度扩展(最多 `depth` 层),同一文档只出现一次(`seen` 去重),自身不计入;
3. 每层扩展的"邻居"来自三类:
   - **共同标签**:扫描全部 Doc 的 `tags` 属性,与目标文档有任一共享标签即命中,`via` 记为 `共同标签: <共享标签名>`;
   - **出链**:目标 `LINKS` 指向的文档,`via` 记为 `链接至: <标题>`;
   - **入链**:`LINKS` 指向目标的文档,`via` 记为 `链接自: <标题>`;
4. 当 `depth=2` 时,第二层结果的 `via` 追加途经信息:`"经由「<第一层文档标题>」· <原始via>"`,便于理解关联路径;
5. 返回 `docs` 数组中,每项含 `doc_id` / `title` / `path` / `via`(关系描述)/ `depth`(层数)。

```json
{
  "docs": [
    { "doc_id": "01HQSECOND", "title": "second", "path": "inbox/notes/second.md", "via": "链接至: second", "depth": 1 },
    { "doc_id": "01HQTHIRD",  "title": "third",  "path": "inbox/notes/third.md",  "via": "共同标签: rrf",   "depth": 1 }
  ]
}
```

### GET /v1/graph/docs/:id/concepts

返回目标文档的**全部 `MENTIONS` 出边**(文档提及的概念),每条含提取 / 消歧置信度与来源。

```bash
curl -s localhost:8702/v1/graph/docs/01HQEXAMPLE/concepts
```

**行为说明**:
1. 查询 `(Doc:目标)-[MENTIONS]->(Concept)` 的全部出边;
2. 逐边原样展开边属性:置信度、来源(`llm` / `human` / `rule`)、状态、表面词形(`text`);
3. 仅返回边数据,不修改任何内容。

```json
{
  "mentions": [
    {
      "concept_id": "c_rrf",
      "confidence": 0.92,
      "extraction_confidence": 0.95,
      "disambiguation_confidence": 0.88,
      "source": "llm",
      "status": "active",
      "text": "RRF"
    }
  ]
}
```

### GET /v1/graph/doc-edges

导出**全部** doc→doc 规则边(`LINKS` 与 `HAS_PARENT` 合并)。

```bash
curl -s localhost:8702/v1/graph/doc-edges
```

**行为说明**:
1. 分别查询 `LINKS` 与 `HAS_PARENT` 两类边;
2. 跳过两端 ID 为空的行,统一输出为 `{ from, to, rel }` 结构,`rel` 分别为 `link` / `parent`。

```json
{
  "edges": [
    { "from": "01HQEXAMPLE", "to": "01HQSECOND", "rel": "link" },
    { "from": "01HQEXAMPLE", "to": "01HQPARENT", "rel": "parent" }
  ]
}
```

### GET /v1/graph/doc-tags

导出全部 Doc 节点的 tags(按文档分组)。

```bash
curl -s localhost:8702/v1/graph/doc-tags
```

**行为说明**:
1. 扫描所有 Doc 节点的 `tags` 属性;
2. 按逗号拆分、过滤空串,输出为 `{ <doc_id>: [<tag>, ...] }`;无 tags 的文档不出现在结果中。

```json
{
  "tags": {
    "01HQEXAMPLE": ["rrf", "search"],
    "01HQSECOND": ["rrf"]
  }
}
```

---

## Concept / Theme

### POST /v1/graph/concepts/upsert

Upsert 概念词条(图投影),按 `concept_id` 幂等写入。

```bash
curl -s -X POST localhost:8702/v1/graph/concepts/upsert \
  -H 'Content-Type: application/json' -d '{
    "concept_id": "c_rrf",
    "name": "Reciprocal Rank Fusion",
    "slug": "rrf",
    "types": ["algorithm"],
    "description": "混合检索结果融合算法",
    "source": "rule",
    "status": "active"
  }'
```

**行为说明**:
1. `concept_id` 为空 → 直接返回 `{ok:true}`,不写库;
2. `MERGE` Concept 节点并整体 `SET`:`name` / `slug` / `types`(逗号拼接)/ `description`;
3. `source` 缺省补为 `human`;`status` 缺省补为 `active`;
4. 已存在节点以本次字段为准整体覆盖(无字段则写空串)。

| 字段 | 类型 | 说明 |
|------|------|------|
| `concept_id` | string | 必填 |
| `name` | string | 名称 |
| `slug` / `description` | string | 可选 |
| `types` | string[] | 可选;逗号拼接存储 |
| `source` | string | `rule` / `llm` / `human`,默认 `human` |
| `status` | string | `active` / `merged` / `deprecated`,默认 `active` |

响应:

```json
{ "ok": true }
```

### GET /v1/graph/concepts/:id

按 ID 取概念;不存在回 `404`。

```bash
curl -s localhost:8702/v1/graph/concepts/c_rrf
```

**行为说明**:
1. 按 `concept_id` 命中单节点;
2. 命中 → 返回完整字段(缺省值已按 upsert 规则补齐);未命中 → `404` + `{ok:false, error:"concept 不存在"}`。

```json
{
  "concept_id": "c_rrf",
  "name": "Reciprocal Rank Fusion",
  "slug": "rrf",
  "types": ["algorithm"],
  "description": "混合检索结果融合算法",
  "status": "active",
  "source": "rule"
}
```

### GET /v1/graph/concepts

列出全部概念(顺序不保证)。

```bash
curl -s localhost:8702/v1/graph/concepts
```

```json
{ "concepts": [ { "concept_id": "c_rrf", "name": "Reciprocal Rank Fusion" } ] }
```

### POST /v1/graph/concepts/mentions

**半替换**某文档的 MENTIONS 出边:删除全部非 `human` 来源的旧边,再按入参写入新边;`human` 来源边**原样保留**。

```bash
curl -s -X POST localhost:8702/v1/graph/concepts/mentions \
  -H 'Content-Type: application/json' -d '{
    "doc_id": "01HQEXAMPLE",
    "edges": [
      {
        "concept_id": "c_rrf",
        "confidence": 0.92,
        "extraction_confidence": 0.95,
        "disambiguation_confidence": 0.88,
        "source": "llm",
        "status": "active",
        "text": "RRF"
      }
    ]
  }'
```

**行为说明**:
1. 删除目标文档全部 `source != "human"` 的 `MENTIONS` 出边(即 `llm` / `rule` 边全部退场,人工确认的边保留);
2. 确保 Doc 节点存在(占位);
3. 逐条写入边:跳过空 `concept_id`;`source` 缺省补 `llm`、`status` 缺省补 `active`;目标 Concept 不存在时自动建占位节点;
4. 每条边完整落库 `confidence` / `extraction_confidence` / `disambiguation_confidence` / `source` / `status` / `text`。

| 字段 | 类型 | 说明 |
|------|------|------|
| `doc_id` | string | 必填 |
| `edges[].concept_id` | string | 必填(跳过空值) |
| `edges[].confidence` | number | 总置信度 |
| `edges[].extraction_confidence` | number | 抽取置信度 |
| `edges[].disambiguation_confidence` | number | 消歧置信度 |
| `edges[].source` | string | `llm` / `human` / `rule`,默认 `llm` |
| `edges[].status` | string | `active` / `soft` / `pending`,默认 `active` |
| `edges[].text` | string | 表面词形(surface form) |

响应:

```json
{ "ok": true }
```

### DELETE /v1/graph/concepts/mentions/llm

删除目标文档的**全部非 human MENTIONS 出边**(与上述端点的删除步骤一致,不写新边)。供重抽前失效旧 mention。

```bash
curl -s -X DELETE localhost:8702/v1/graph/concepts/mentions/llm \
  -H 'Content-Type: application/json' -d '{"doc_id": "01HQEXAMPLE"}'
```

**行为说明**:
1. 删除 `(Doc:目标)-[MENTIONS]->()` 中所有 `source != "human"` 的边;
2. `human` 边保留;文档不存在时无操作,幂等。

```json
{ "ok": true }
```

### POST /v1/graph/concepts/relations

**幂等增量写**概念间 REL 边:同 `from → to → rel` 组合先删后建,其余边不受影响。

```bash
curl -s -X POST localhost:8702/v1/graph/concepts/relations \
  -H 'Content-Type: application/json' -d '{
    "edges": [
      { "from": "c_rrf", "to": "c_retrieval", "rel": "is_a", "confidence": 0.9, "source": "llm", "description": "RRF 是一种检索融合方法" }
    ]
  }'
```

**行为说明**:
1. 逐条处理,跳过 `from` 或 `to` 为空的行;
2. `rel` 缺省补 `related_to`(常见取值 `is_a` / `part_of` 等);`source` 缺省补 `llm`;
3. 两端 Concept 不存在时自动建占位节点;
4. **幂等规则**:对每个 `from → to → rel` 组合,先删除已存在的同组合边,再创建新边(带 `confidence` / `source` / `description`);
5. 不是全量替换——不同 `rel` 的边、以及本次未涉及的边全部保留。

| 字段 | 类型 | 说明 |
|------|------|------|
| `edges[].from` / `edges[].to` | string | 必填,两端概念 ID |
| `edges[].rel` | string | 关系类型,默认 `related_to` |
| `edges[].confidence` | number | 可选 |
| `edges[].source` | string | 默认 `llm` |
| `edges[].description` | string | 关系描述(图边标签) |

响应:

```json
{ "ok": true }
```

### GET /v1/graph/relations

列出全部概念 REL 边(兼容旧库:缺少 `description` 列时自动退回不含该字段的查询)。

```bash
curl -s localhost:8702/v1/graph/relations
```

**行为说明**:
1. 查询 `(a:Concept)-[REL]->(b:Concept)`;
2. 优先带 `description` 字段;若旧库该列不存在导致查询失败,自动降级为不含 `description` 的五列查询,保证边数据不丢。

```json
{
  "relations": [
    { "from": "c_rrf", "to": "c_retrieval", "rel": "is_a", "confidence": 0.9, "source": "llm", "description": "RRF 是一种检索融合方法" }
  ]
}
```

### POST /v1/graph/themes/upsert

Upsert 主题;可携带 `parent_id` 维护 `CHILD_OF` 层级边。

```bash
curl -s -X POST localhost:8702/v1/graph/themes/upsert \
  -H 'Content-Type: application/json' -d '{
    "theme_id": "t_search",
    "title": "检索与排序",
    "slug": "search",
    "confidence": 0.8,
    "source": "llm",
    "parent_id": "t_retrieval"
  }'
```

**行为说明**:
1. `theme_id` 为空 → 直接返回 `{ok:true}`,不写库;
2. `MERGE` Theme 节点并 `SET` `title` / `slug` / `confidence` / `source`(`source` 缺省补 `llm`);
3. 仅当 `parent_id` 非空时维护层级:确保父节点存在(占位)→ 删除该主题现有的 `CHILD_OF` 出边 → 新建指向 `parent_id` 的 `CHILD_OF` 边;
4. 未传 `parent_id` 时**不动**既有 `CHILD_OF` 边。

响应:

```json
{ "ok": true }
```

### POST /v1/graph/themes/membership

**全量替换**主题的 doc 成员(INCLUDES 出边先删后建)。

```bash
curl -s -X POST localhost:8702/v1/graph/themes/membership \
  -H 'Content-Type: application/json' -d '{
    "theme_id": "t_search",
    "docs": [ { "doc_id": "01HQEXAMPLE", "confidence": 0.9 } ]
  }'
```

**行为说明**:
1. 删除该主题的全部 `INCLUDES` 出边(全量替换语义);
2. 确保主题节点存在;
3. 逐条建边:跳过空 `doc_id`;目标 Doc 不存在时自动建占位节点;边带 `confidence`;
4. 本次未传入的文档从该主题中移除。

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme_id` | string | 必填 |
| `docs[].doc_id` | string | 必填(跳过空值) |
| `docs[].confidence` | number | 可选 |
| `docs[].path` | string | 可选(当前仅记录,不影响建边) |

响应:

```json
{ "ok": true }
```

---

## Admin

### POST /v1/admin/clear

**清库重建**:DROP 全部表后重建 schema(供 `concept-clear` 使用;进程保持单写者,库文件不换)。

```bash
curl -s -X POST localhost:8702/v1/admin/clear
```

**行为说明**:
1. 先 DROP 全部关系表(`LINKS` / `HAS_PARENT` / `MENTIONS` / `REL` / `CHILD_OF` / `INCLUDES`),再 DROP 全部节点表(`Doc` / `Concept` / `Theme`)— 先删关系表以解除依赖;
2. 重新执行建表 DDL(幂等),恢复空 schema;
3. 所有图数据清空,不可恢复;调用方应确认已备份。

```json
{ "ok": true }
```
