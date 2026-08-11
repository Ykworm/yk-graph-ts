# HTTP API — yk-graph-ts

图服务 HTTP 契约(`:8702`)。所有端点仅允许 **lensd** 调用;参数化 Cypher 全部在服务内完成。

- 基础路径:`http://localhost:8702`
- 统一错误格式:`{ "ok": false, "error": "<消息>" }`(缺必填字段 → `400`,其余异常 → `500`)
- 请求体一律 `application/json`(上限 16MB)

## 健康 / 状态

### GET /v1/health

可达性探测。

```bash
curl -s localhost:8702/v1/health
```

```json
{ "ok": true, "backend": "ladybug" }
```

图库故障(连接失效 / 查询抛错)时返回 `503`:

```json
{ "ok": false, "backend": "ladybug" }
```

### GET /v1/status

后端状态(图库可达性与文档数)。

```bash
curl -s localhost:8702/v1/status
```

```json
{ "backend": "ladybug", "reachable": true, "docs": 128 }
```

## Doc 规则图

### POST /v1/graph/docs/upsert

全量替换一篇文档的图关系:upsert Doc 节点(tags 属性)+ 删除旧边 + 按 `links` 重建规则边。

请求:

```json
{
  "doc_id": "01HQEXAMPLE",
  "project": "inbox",
  "path": "inbox/notes/foo.md",
  "title": "foo",
  "tags": ["rrf"],
  "links": [
    { "target_id": "01HQSECOND", "rel": "link" },
    { "target_id": "01HQPARENT", "rel": "parent" }
  ]
}
```

字段:

| 字段 | 类型 | 说明 |
|------|------|------|
| `doc_id` | string | 必填,文档稳定 ID |
| `project` / `path` / `title` | string | 可选 |
| `tags` | string[] | 可选;存为 Doc 节点 tags 属性(逗号分隔) |
| `links[].target_id` | string | 目标文档 ID;未 upsert 时自动建占位节点 |
| `links[].rel` | string | 默认 `link`;`parent` 写入 `HAS_PARENT` 边 |

响应:

```json
{ "ok": true }
```

### DELETE /v1/graph/docs/:id

删除文档节点及其全部出/入边(不残留悬挂边)。

```bash
curl -s -X DELETE localhost:8702/v1/graph/docs/01HQEXAMPLE
```

```json
{ "ok": true }
```

### POST /v1/graph/docs/remove-with-stats

带统计的删除,返回是否存在与删除的边数。

```bash
curl -s -X POST localhost:8702/v1/graph/docs/remove-with-stats \
  -H 'Content-Type: application/json' -d '{"doc_id": "01HQEXAMPLE"}'
```

```json
{ "existed": true, "edges": 7 }
```

文档不存在时:

```json
{ "existed": false, "edges": 0 }
```

### GET /v1/graph/docs/:id/related?depth=

depth 层内关联文档(`depth` 钳制在 1~2)。关联来源:共同标签、出链(`LINKS` 指向)、入链(被 `LINKS` 指向)。

```bash
curl -s "localhost:8702/v1/graph/docs/01HQEXAMPLE/related?depth=1"
```

```json
{
  "docs": [
    { "doc_id": "01HQSECOND", "title": "second", "path": "inbox/notes/second.md", "via": "链接至: second", "depth": 1 },
    { "doc_id": "01HQTHIRD",  "title": "third",  "path": "inbox/notes/third.md",  "via": "共同标签: rrf",   "depth": 1 }
  ]
}
```

`depth=2` 时,跨层结果 `via` 会带上途经文档:`"经由「second」· 共同标签: rrf"`。

### GET /v1/graph/docs/:id/concepts

该文档的 `MENTIONS` 邻居(提及的概念,含各置信度与来源)。

```bash
curl -s localhost:8702/v1/graph/docs/01HQEXAMPLE/concepts
```

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

全部 doc→doc 规则边(`LINKS` 与 `HAS_PARENT`)。

```bash
curl -s localhost:8702/v1/graph/doc-edges
```

```json
{
  "edges": [
    { "from": "01HQEXAMPLE", "to": "01HQSECOND", "rel": "link" },
    { "from": "01HQEXAMPLE", "to": "01HQPARENT", "rel": "parent" }
  ]
}
```

### GET /v1/graph/doc-tags

全部 Doc 节点的 tags。

```bash
curl -s localhost:8702/v1/graph/doc-tags
```

```json
{
  "tags": {
    "01HQEXAMPLE": ["rrf", "search"],
    "01HQSECOND": ["rrf"]
  }
}
```

## Concept / Theme

### POST /v1/graph/concepts/upsert

Upsert 概念词条(图投影)。

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

字段:

| 字段 | 类型 | 说明 |
|------|------|------|
| `concept_id` | string | 必填 |
| `name` | string | 名称 |
| `slug` / `types` / `description` | string / string[] / string | 可选 |
| `source` | string | `rule` / `llm` / `human`,默认 `human` |
| `status` | string | `active` / `merged` / `deprecated`,默认 `active` |

响应:

```json
{ "ok": true }
```

### GET /v1/graph/concepts/:id

按 ID 取概念;不存在返回 `404`。

```bash
curl -s localhost:8702/v1/graph/concepts/c_rrf
```

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

全部概念。

```bash
curl -s localhost:8702/v1/graph/concepts
```

```json
{ "concepts": [ { "concept_id": "c_rrf", "name": "Reciprocal Rank Fusion" } ] }
```

### POST /v1/graph/concepts/mentions

替换某文档发出的 `llm` MENTIONS 边(**human 来源边保留**)。

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

`source` 缺省视为 `llm`;`status` 缺省 `active`。响应:

```json
{ "ok": true }
```

### DELETE /v1/graph/concepts/mentions/llm

删除某文档发出的全部非 human MENTIONS 边(重抽前失效旧 mention)。

```bash
curl -s -X DELETE localhost:8702/v1/graph/concepts/mentions/llm \
  -H 'Content-Type: application/json' -d '{"doc_id": "01HQEXAMPLE"}'
```

```json
{ "ok": true }
```

### POST /v1/graph/concepts/relations

幂等替换概念间 REL 边(同 from-to-type 先删后写)。

```bash
curl -s -X POST localhost:8702/v1/graph/concepts/relations \
  -H 'Content-Type: application/json' -d '{
    "edges": [
      { "from": "c_rrf", "to": "c_retrieval", "rel": "is_a", "confidence": 0.9, "source": "llm", "description": "RRF 是一种检索融合方法" }
    ]
  }'
```

`rel` 缺省 `related_to`(可选 `is_a` / `part_of` 等);`source` 缺省 `llm`。响应:

```json
{ "ok": true }
```

### GET /v1/graph/relations

全部概念 REL 边。

```bash
curl -s localhost:8702/v1/graph/relations
```

```json
{
  "relations": [
    { "from": "c_rrf", "to": "c_retrieval", "rel": "is_a", "confidence": 0.9, "source": "llm", "description": "RRF 是一种检索融合方法" }
  ]
}
```

### POST /v1/graph/themes/upsert

Upsert 主题(可携带 `parent_id` 写 `CHILD_OF` 层级边)。

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

响应:

```json
{ "ok": true }
```

### POST /v1/graph/themes/membership

替换主题的 doc 成员(INCLUDES 边全量重建)。

```bash
curl -s -X POST localhost:8702/v1/graph/themes/membership \
  -H 'Content-Type: application/json' -d '{
    "theme_id": "t_search",
    "docs": [ { "doc_id": "01HQEXAMPLE", "confidence": 0.9 } ]
  }'
```

响应:

```json
{ "ok": true }
```

## Admin

### POST /v1/admin/clear

清库:DROP 全部表后重建 schema(供 `concept-clear` 用;进程保持单写者)。

```bash
curl -s -X POST localhost:8702/v1/admin/clear
```

```json
{ "ok": true }
```
