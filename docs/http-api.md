# HTTP API — yk-lens-graph-store-ts

## 目录

- [背景:图谱是怎么来的](#background)
- [领域概念](#concepts)
- [图 Schema](#schema)
- [通用约定](#conventions)
- [数据结构(DTO)](#dto)
- [最小工作流(Quickstart)](#quickstart)
- [常见任务对照](#tasks)
- [Part A — Common(通用图操作)](#part-a)
- [Part B — 业务绑定(概念管线语义)](#part-b)

图服务 HTTP 契约(`:8702`),yk-lens 的图存储层。开始读 API 之前,先看[背景:图谱是怎么来的](#background)与[图 Schema](#schema)——图里的节点和边来自一套特定的知识建模,不是通用图数据库概念。

所有端点仅允许 **lensd** 调用;参数化 Cypher 全部在服务内完成,外部只传 JSON。

---

## <a id="background"></a>背景:图谱是怎么来的

一个知识库会不断积累笔记。如果只把它们当文件存着,笔记之间的联系就丢失了。于是系统在存储之外,把内容组织成一张**关系网络**:

1. 每篇笔记入库后,成为图里的一个**文档**节点;
2. 系统(结合人工)从文档中提炼出反复出现的**概念**——例如一篇笔记里讲到的某个算法名词,概念统一收录成词条;
3. 文档之间、文档与概念之间、概念与概念之间,由不同的**关系**连接起来;
4. 更进一步,系统把一批相关文档聚成一个**主题**,方便按主题浏览。

这张关系网络就是下面 API 操作的对象。下节用「功能 + 场景」解释图里的每个节点和每条边。

---

## <a id="concepts"></a>领域概念

图里只有三样东西:**文档、概念、主题**;它们之间的关系构成了图谱。术语分三类:**node**(节点)、**edge**(关系边)、**property**(节点/边上的字段)。

| 类别 | 术语 | 功能 | 场景 / 故事 |
|------|------|------|-------------|
| node | `Doc` | 知识库里的"文档"实体 | 你写进知识库的每篇笔记都会成为图里的一个 Doc 节点,自带标题、路径、标签 |
| node | `Concept` | 知识库里的"概念"词条 | 例如"RRF""倒排索引"——你(或 LLM)从文档里提炼出的核心概念,统一收进词表 |
| node | `Theme` | 知识库里的"主题" | 例如"检索与排序"——把一批相关文档聚成一个主题,方便按主题浏览(预留:接口已就绪,当前业务尚未写入) |
| edge | `LINKS` | 文档 ↔ 文档:显式链接 | 你在 Markdown 里写了 `[[wiki链接]]` 或 `[text](file.md)`,图谱里就有这条边 |
| edge | `HAS_PARENT` | 文档 → 父文档:层级 | wiki 树状结构:一篇子文档挂在父文档名下 |
| edge | `MENTIONS` | 文档 **提及** 概念 | LLM 读完文档后判定"这篇讲了 RRF",就建一条提及边,附抽取置信度;你人工确认的提及也在这里(`human`) |
| edge | `REL` | 概念 ↔ 概念:语义关系 | LLM 判定"RRF 是检索的一种方法",建一条 `is_a` 边,带一句话描述 |
| edge | `INCLUDES` | 主题 **收录** 文档 | 把相关文档归入某个主题,例如"检索与排序"主题收录了 5 篇文档(预留:同上) |
| edge | `CHILD_OF` | 主题 → 父主题:层级 | 主题树:子主题挂在父主题下(预留:同上) |
| property | `tags` | Doc 节点的标签字段 | 每篇笔记的标签存成 Doc 节点的 `tags` 属性(逗号分隔),"共同标签"关联计算就靠它 |
| property | `source` | MENTIONS / REL 边的来源字段 | 标出这条边是 LLM 抽取、规则生成还是人工确认——决定重跑时是"先删后建"还是"永久保留" |

关键机制:

- **规则边 vs LLM 语义边**:图里的边按产生方式分两类——
  - **规则边**(`LINKS` / `HAS_PARENT`):由文档内容**确定性投影**(wiki 链接、`parentId`、标签),重跑结果不变、可从文档无损恢复;
  - **LLM 语义边**(`MENTIONS` / `REL`):LLM 推断、带置信度,重抽可能变化。
  两者的区分依据是边的 `source` 字段(术语与设计决策见 [design-inconsistency-audit.md](../../yk-lens-go/docs/reports/design-inconsistency-audit.md) §6.2 / §3.3,术语管理遵循 [06-MERGED-SPEC-EXTRACT-LEDGER 词汇控制表](../../yk-lens-go/docs/concept-docs/06-MERGED-SPEC-EXTRACT-LEDGER-v1.0.md) §2——先入表再使用,不新造词)。
- **机器产物 vs 人工产物**:MENTIONS / REL 边标 `source`(`llm` / `human` / `rule`)。机器产出的边在重跑概念抽取流程时被**先删后建**;`human` 边是人工确认的投资,**永远保留**。
- **占位节点**:写入时目标节点还没入库(如链接指向的文档、提及指向的概念),服务自动建空节点,属性留待后续补全。
- **唯一写入方**:图数据由上层概念抽取流程写入,服务本身不"灌图"。
- **预留功能**:`Theme` 节点与 `INCLUDES` / `CHILD_OF` 边的接口已就绪,但当前业务尚未写入任何 Theme 数据,现网图库没有主题树。

---

## <a id="schema"></a>图 Schema

### 节点表

| 表 | 属性 | 主键 |
|----|------|------|
| `Doc` | `id` `title` `path` `project` `tags`(逗号分隔字符串) | `id` |
| `Concept` | `id` `name` `slug` `types`(逗号分隔) `description` `status` `source` | `id` |
| `Theme` | `id` `title` `slug` `confidence`(DOUBLE) `source` | `id` |

### 关系表

| 表 | 起 → 止 | 属性 |
|----|--------|------|
| `LINKS` | `Doc` → `Doc` | — |
| `HAS_PARENT` | `Doc` → `Doc` | — |
| `MENTIONS` | `Doc` → `Concept` | `confidence` `extraction_confidence` `disambiguation_confidence` `source` `status` `text` |
| `REL` | `Concept` → `Concept` | `type` `confidence` `source` `description` |
| `CHILD_OF` | `Theme` → `Theme` | — |
| `INCLUDES` | `Theme` → `Doc` | `confidence` |

---

## <a id="conventions"></a>通用约定

- **基础路径**:`http://localhost:8702`;请求体一律 `application/json`(上限 16MB)。
- **统一错误格式**:`{ "ok": false, "error": "<消息>" }` — 缺必填字段 → `400`,其余异常 → `500`。
- **写语义**:所有写操作经内部串行队列执行(单连接非线程安全);图语句单条软失败不影响整体语义。
- **全量替换 vs 增量**:标"全量替换"的端点**先删旧边再建新边**;标"幂等写"的端点只保证重复调用结果一致,不动无关数据。
- **Cypher 示例**:各端点下方给出对应图语句(参数用 `$name` 占位),仅供理解语义;实际执行统一走参数化 `prepare/execute`,不拼接字符串。

---

## <a id="dto"></a>数据结构(DTO)

请求 / 响应对象集中定义。字段标 `?` 为可选;**必填/缺省**列给出服务端的校验与默认补全规则(与实现一致)。对象按字母序:

### DocLink — doc 规则边(upsert 的 `links[]` 元素)

| 字段 | 类型 | 必填 | 缺省 | 说明 |
|------|------|------|------|------|
| `target_id` | string | 否 | — | 目标文档 ID;空值/自环跳过 |
| `rel` | string | 否 | `link` | `parent` → `HAS_PARENT`,其余 → `LINKS` |

### DocEdge — doc→doc 边(响应)

| 字段 | 类型 | 说明 |
|------|------|------|
| `from` / `to` | string | 两端文档 ID |
| `rel` | string | `link` / `parent` |

### RelatedDoc — 关联文档(响应)

| 字段 | 类型 | 说明 |
|------|------|------|
| `doc_id` | string | 文档 ID |
| `title` / `path` | string | 标题 / 路径 |
| `via` | string | 关系描述(共同标签 / 链接至 / 链接自) |
| `depth` | number | 层数(1~2) |

### MentionEdge — 文档提及概念(MENTIONS 边)

| 字段 | 类型 | 必填 | 缺省 | 说明 |
|------|------|------|------|------|
| `concept_id` | string | 是 | — | 空值跳过 |
| `confidence` | number | 否 | `0` | 总置信度 |
| `extraction_confidence` | number | 否 | `0` | 抽取置信度 |
| `disambiguation_confidence` | number | 否 | `0` | 消歧置信度 |
| `source` | string | 否 | `llm` | `llm` / `human` / `rule` |
| `status` | string | 否 | `active` | `active` / `soft` / `pending` |
| `text` | string | 否 | `""` | 表面词形(surface form) |

### Concept — 概念词条

| 字段 | 类型 | 必填 | 缺省 | 说明 |
|------|------|------|------|------|
| `concept_id` | string | 是 | — | 空值则忽略写入 |
| `name` | string | 否 | `""` | 名称 |
| `slug` | string | 否 | `""` | 别名/短名 |
| `types` | string[] | 否 | `[]` | 逗号拼接存储 |
| `description` | string | 否 | `""` | 描述 |
| `source` | string | 否 | `human` | `rule` / `llm` / `human` |
| `status` | string | 否 | `active` | `active` / `merged` / `deprecated` |

### ConceptRel — 概念间关系(REL 边)

| 字段 | 类型 | 必填 | 缺省 | 说明 |
|------|------|------|------|------|
| `from` / `to` | string | 是 | — | 两端概念 ID;空值跳过 |
| `rel` | string | 否 | `related_to` | `is_a` / `part_of` 等 |
| `confidence` | number | 否 | `0` | 置信度 |
| `source` | string | 否 | `llm` | 默认 `llm` |
| `description` | string | 否 | `""` | 关系描述(图边标签) |

### Theme — 主题(预留)

| 字段 | 类型 | 必填 | 缺省 | 说明 |
|------|------|------|------|------|
| `theme_id` | string | 是 | — | 空值则忽略写入 |
| `title` / `slug` | string | 否 | `""` | 标题 / 别名 |
| `confidence` | number | 否 | `0` | 置信度 |
| `source` | string | 否 | `llm` | 来源 |
| `parent_id` | string | 否 | — | `CHILD_OF` 目标;缺省不动既有层级边 |

### ThemeDocEdge — 主题成员(INCLUDES 边,预留)

| 字段 | 类型 | 必填 | 缺省 | 说明 |
|------|------|------|------|------|
| `doc_id` | string | 是 | — | 空值跳过 |
| `confidence` | number | 否 | `0` | 置信度 |
| `path` | string | 否 | — | 仅记录,不影响建边 |

### 请求体(端点专用)

| 对象 | 端点 | 结构 |
|------|------|------|
| `UpsertDocRequest` | `docs/upsert` | `{ doc_id*, project?, path?, title?, tags?: string[], links?: DocLink[] }` |
| `RemoveWithStatsRequest` | `docs/remove-with-stats` | `{ doc_id* }` |
| `PatchMentionsRequest` | `concepts/mentions` | `{ doc_id*, edges: MentionEdge[] }` |
| `RemoveLLMMentionsRequest` | `concepts/mentions/llm` | `{ doc_id* }` |
| `PatchRelationsRequest` | `concepts/relations` | `{ edges: ConceptRel[] }` |
| `PatchThemeMembershipRequest` | `themes/membership` | `{ theme_id*, docs: ThemeDocEdge[] }` |

### 响应体

| 对象 | 出现位置 | 结构 |
|------|----------|------|
| `OkResponse` | 写操作 | `{ "ok": true }` |
| `ErrorResponse` | 任意失败 | `{ "ok": false, "error": "<消息>" }`(缺必填 → `400`,其余 → `500`) |
| `HealthResponse` | `/v1/health` | `{ ok, backend }` |
| `StatusResponse` | `/v1/status` | `{ backend, reachable, docs }` |
| `RemoveDocStats` | `remove-with-stats` | `{ existed, edges }` |
| `RelatedResponse` | `related` | `{ docs: RelatedDoc[] }` |
| `ConceptsResponse` | `docs/:id/concepts` | `{ mentions: MentionEdge[] }` |
| `EdgesResponse` | `doc-edges` | `{ edges: DocEdge[] }` |
| `TagsResponse` | `doc-tags` | `{ tags: { [doc_id]: string[] } }` |
| `ConceptListResponse` | `concepts` | `{ concepts: Concept[] }` |
| `RelationsResponse` | `relations` | `{ relations: ConceptRel[] }` |

---

## <a id="quickstart"></a>最小工作流(Quickstart)

完整跑一遍:录两篇笔记 → 建概念 → 记提及 → 建概念关系 → 查看图谱。**顺序自由**(占位节点机制让先建 doc 或先建 concept 都行),下面是推荐的阅读顺序。

```bash
# ① 建两个概念
curl -s -X POST localhost:8702/v1/graph/concepts/upsert -H 'Content-Type: application/json' -d '{
  "concept_id": "c_rrf", "name": "RRF", "source": "rule"
}'
curl -s -X POST localhost:8702/v1/graph/concepts/upsert -H 'Content-Type: application/json' -d '{
  "concept_id": "c_retrieval", "name": "检索", "source": "rule"
}'

# ② 录入笔记 A(带标签 + 链接到 B;目标 B 尚未入库会自动占位)
curl -s -X POST localhost:8702/v1/graph/docs/upsert -H 'Content-Type: application/json' -d '{
  "doc_id": "doc-a", "title": "A 笔记", "path": "notes/a.md", "tags": ["搜索"],
  "links": [{ "target_id": "doc-b", "rel": "link" }]
}'

# ③ 录入笔记 B
curl -s -X POST localhost:8702/v1/graph/docs/upsert -H 'Content-Type: application/json' -d '{
  "doc_id": "doc-b", "title": "B 笔记", "path": "notes/b.md", "tags": ["搜索"]
}'

# ④ 记提及:LLM(或你)判定 A 提到了 c_rrf 与 c_retrieval
curl -s -X POST localhost:8702/v1/graph/concepts/mentions -H 'Content-Type: application/json' -d '{
  "doc_id": "doc-a",
  "edges": [
    { "concept_id": "c_rrf",       "confidence": 0.9, "source": "llm" },
    { "concept_id": "c_retrieval", "confidence": 0.8, "source": "llm" }
  ]
}'

# ⑤ 建概念关系:RRF 是检索的一种方法
curl -s -X POST localhost:8702/v1/graph/concepts/relations -H 'Content-Type: application/json' -d '{
  "edges": [{ "from": "c_rrf", "to": "c_retrieval", "rel": "is_a", "description": "RRF 是一种检索融合方法" }]
}'

# ⑥ 查看结果:A 提及了哪些概念、A 关联了哪些文档
curl -s localhost:8702/v1/graph/docs/doc-a/concepts
curl -s "localhost:8702/v1/graph/docs/doc-a/related?depth=1"
```

**手工写入 vs 概念管线**:正常生产中,`Doc` 节点与 `LINKS`/`HAS_PARENT`/`tags` 由上层概念抽取流程写入(图数据唯一写入方);本服务只负责存储与查询。手工调用上述写端点适用于:概念词表(`source=rule`)、人工确认的提及(`source=human`)、调试与测试。

---

## <a id="tasks"></a>常见任务对照

| 我想… | 调用 |
|--------|------|
| 录入 / 更新一篇文档(标签 + 链接) | `POST /v1/graph/docs/upsert` |
| 删除一篇文档(连同全部关系边) | `DELETE /v1/graph/docs/:id` |
| 查一篇文档的关联文档(同标签 / 链接) | `GET /v1/graph/docs/:id/related?depth=1` |
| 查一篇文档提到了哪些概念 | `GET /v1/graph/docs/:id/concepts` |
| 新增概念词条 | `POST /v1/graph/concepts/upsert` |
| 批量录入文档提及(LLM 抽取结果) | `POST /v1/graph/concepts/mentions` |
| 重抽前清空某文档的机器提及(human 保留) | `DELETE /v1/graph/concepts/mentions/llm` |
| 建立概念间关系 | `POST /v1/graph/concepts/relations` |
| 导出全部 doc→doc 边 / 全部标签 | `GET /v1/graph/doc-edges` · `GET /v1/graph/doc-tags` |
| 导出全部概念关系 | `GET /v1/graph/relations` |
| 建主题 / 把文档归入主题(预留) | `POST /v1/graph/themes/upsert` · `themes/membership` |
| 清空整个图库并重建 | `POST /v1/admin/clear` |

---

# <a id="part-a"></a>Part A — Common(通用图操作)

节点与边的增删查,不承载概念管线规则。

## GET /v1/health

可达性探测。图库故障(查询失败)→ `503`。

```bash
curl -s localhost:8702/v1/health
```

```json
{ "ok": true, "backend": "ladybug" }
```

Cypher:

```cypher
MATCH (d:Doc) RETURN count(d)
```

**Cypher 解读**:`MATCH (d:Doc)` 找出图里所有的 Doc 节点,`RETURN count(d)` 数出总个数——这个数就是 `/v1/status` 里 `docs` 字段的值。如果这条查询抛错(图库连不上、文件被占用等),服务端会把 `reachable` 置为 `false`,`/v1/health` 随之回 `503`。

## GET /v1/status

后端状态详情(同 health 数据源,始终回 `200`,如实上报可达性)。

```bash
curl -s localhost:8702/v1/status
```

```json
{ "backend": "ladybug", "reachable": true, "docs": 128 }
```

Cypher:同 `/v1/health`。

## POST /v1/graph/docs/upsert

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
1. `MERGE` Doc 节点并 `SET` 覆盖 `title` / `path` / `project` / `tags`(`tags` 逗号拼接);
2. 删除该文档全部 `LINKS` 与 `HAS_PARENT` **出边**;
3. 逐条 `links`:跳过空 `target_id` 与自环(`target_id == doc_id`);目标未入库自动建占位节点;`rel == "parent"` 建 `HAS_PARENT`,否则建 `LINKS`;
4. 只动**出边**——入边、`MENTIONS` / `INCLUDES` / `REL` 一律不碰。

Cypher:

```cypher
MERGE (d:Doc {id: $id}) SET d.title = $title, d.path = $path, d.project = $project, d.tags = $tags;
MATCH (d:Doc {id: $id})-[r:LINKS]->() DELETE r;
MATCH (d:Doc {id: $id})-[r:HAS_PARENT]->() DELETE r;
-- 每条 link:
MERGE (o:Doc {id: $target_id});
MATCH (a:Doc {id: $from}), (b:Doc {id: $to}) CREATE (a)-[:LINKS]->(b);  -- rel=parent 时用 HAS_PARENT
```

**Cypher 解读**(按行):
1. `MERGE (d:Doc {id: $id}) SET ...` — 按 `id` 找 Doc 节点:有就复用,没有就新建(MERGE 的语义)。然后把 `title` / `path` / `project` / `tags` 四个属性**整体覆盖**写入(`tags` 已在服务端拼成逗号分隔字符串)。注意:只覆盖这四个属性,节点上其它内容不动。
2. `MATCH (d:Doc {id: $id})-[r:LINKS]->() DELETE r` — 找到该文档发出的所有 `LINKS` **出边**并删除。这是"全量替换"的"先清旧"步骤。
3. 第二行 `HAS_PARENT` 同理,把 parent 出边也清掉。
4. `MERGE (o:Doc {id: $target_id})` — 保证链接目标节点存在。目标文档可能还没录入,这里先建一个**只有 id、没有其它属性**的占位节点,等它被 upsert 时再补全标题等。
5. `MATCH (a:Doc {id: $from}), (b:Doc {id: $to}) CREATE (a)-[:LINKS]->(b)` — 同时找到起点和终点,建一条新的 `LINKS` 边(`rel=parent` 时换成 `HAS_PARENT`)。

整体效果:**节点属性覆盖 + 规则出边先清后建**,其它关系(MENTIONS / INCLUDES / REL)和指向本文档的入边都不受影响。

响应:

```json
{ "ok": true }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `doc_id` | string | 必填 |
| `project` / `path` / `title` | string | 可选,覆盖式写入 |
| `tags` | string[] | 可选;逗号拼接存储 |
| `links[].target_id` | string | 可选;自环与空值跳过 |
| `links[].rel` | string | 可选;`parent` → `HAS_PARENT`,其余 → `LINKS` |

## DELETE /v1/graph/docs/:id

删除文档节点及**全部关系边**(出边 + 入边),不留悬挂边;文档不存在同样回 `{ok:true}`。

```bash
curl -s -X DELETE localhost:8702/v1/graph/docs/01HQEXAMPLE
```

Cypher:

```cypher
MATCH (d:Doc {id: $id}) DETACH DELETE d
```

**Cypher 解读**:`DETACH DELETE` 是"连人带关系一起删"——除了删掉节点本身,还会把它**所有的出边和入边**一起删掉。入边也要删,是因为图库不允许存在"指向不存在节点"的悬挂边:别的文档可能 `LINKS` 指向这篇文档,如果不删,就变成悬空引用。文档不存在时这条语句不匹配任何节点,等价于无事发生,所以接口返回 `{ok:true}` 而不报错。

```json
{ "ok": true }
```

## POST /v1/graph/docs/remove-with-stats

同 DELETE 语义,但先统计存在性与边数再删。

```bash
curl -s -X POST localhost:8702/v1/graph/docs/remove-with-stats \
  -H 'Content-Type: application/json' -d '{"doc_id": "01HQEXAMPLE"}'
```

**行为说明**:1) 计数节点是否存在;2) 不存在 → `{existed:false, edges:0}` 直接返回;3) 存在 → 统计全部关系边数(出 + 入),再 `DETACH DELETE`,返回删除前的边数。

Cypher:

```cypher
MATCH (d:Doc {id: $id}) RETURN count(d);                       -- existed
MATCH (d:Doc {id: $id})-[r]-() RETURN count(r);                -- edges
MATCH (d:Doc {id: $id}) DETACH DELETE d;
```

**Cypher 解读**(按行):
1. `RETURN count(d)` — 先数这篇文档是否存在,决定 `existed`;不存在就直接返回 `{existed:false, edges:0}`,后面两步都不执行。
2. `-[r]-()` — `r` 表示"任意方向、任意类型"的关系:无论这篇文档是起点还是终点,只要沾着边都被数进来,得到删除前的总边数 `edges`。
3. `DETACH DELETE d` — 最后真正删除(和上一个端点的删除语句完全相同)。

也就是说,这个端点 = "先统计、后删除",让调用方在删之前知道会影响多少条边。

```json
{ "existed": true, "edges": 7 }
```

## GET /v1/graph/doc-edges

导出全部 doc→doc 规则边(`LINKS` + `HAS_PARENT` 合并)。

```bash
curl -s localhost:8702/v1/graph/doc-edges
```

Cypher:

```cypher
MATCH (a:Doc)-[:LINKS]->(b:Doc) RETURN a.id, b.id;
MATCH (a:Doc)-[:HAS_PARENT]->(b:Doc) RETURN a.id, b.id;
```

**Cypher 解读**:两条查询结构完全相同,只是关系类型不同——第一条取所有 `LINKS` 边,第二条取所有 `HAS_PARENT` 边,都是"起点 a → 终点 b"。服务端把结果合并,`LINKS` 的行标 `rel=link`、`HAS_PARENT` 的行标 `rel=parent`,就得到完整的 doc→doc 规则边清单(这是图结构"导出"用途,只读不改)。

```json
{
  "edges": [
    { "from": "01HQEXAMPLE", "to": "01HQSECOND", "rel": "link" },
    { "from": "01HQEXAMPLE", "to": "01HQPARENT", "rel": "parent" }
  ]
}
```

## GET /v1/graph/doc-tags

导出全部 Doc 节点的 tags(按文档分组)。

```bash
curl -s localhost:8702/v1/graph/doc-tags
```

Cypher:

```cypher
MATCH (d:Doc) RETURN d.id, d.tags
```

**Cypher 解读**:扫一遍所有 Doc 节点,返回每篇的 `id` 和 `tags`。注意 `tags` 在库里是**逗号分隔的字符串**(upsert 时由数组拼成),所以服务端拿到后要再拆回数组、过滤掉空串,才得到 `{ doc_id: ["rrf", ...] }` 这样的返回结构。没有 tags(空字符串)的文档不会出现在结果里。

```json
{
  "tags": {
    "01HQEXAMPLE": ["rrf", "search"],
    "01HQSECOND": ["rrf"]
  }
}
```

## POST /v1/graph/concepts/upsert

Upsert 概念词条,按 `concept_id` 幂等;`concept_id` 为空直接返回不写库。

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

**行为说明**:`MERGE` 节点并整体 `SET`;`source` 缺省补 `human`,`status` 缺省补 `active`;已存在节点以本次字段整体覆盖。

Cypher:

```cypher
MERGE (c:Concept {id: $id}) SET c.name = $name, c.slug = $slug, c.types = $types, c.description = $description, c.status = $status, c.source = $source
```

**Cypher 解读**:和 `docs/upsert` 的第一步一样,`MERGE` 按 `id` 找概念:有就复用、没有就新建,然后 `SET` 把六个属性**整体覆盖**。`types` 同样是数组拼成的逗号字符串。`source` 和 `status` 服务端会做缺省补全:没传时 `source` 记 `human`、`status` 记 `active`(在概念词表场景下,`source=rule` 表示词条来自规则/人工维护)。`concept_id` 为空时服务端直接跳过,不执行这条语句。

| 字段 | 类型 | 说明 |
|------|------|------|
| `concept_id` | string | 必填 |
| `name` | string | 名称 |
| `slug` / `description` | string | 可选 |
| `types` | string[] | 可选;逗号拼接存储 |
| `source` | string | `rule` / `llm` / `human`,默认 `human` |
| `status` | string | `active` / `merged` / `deprecated`,默认 `active` |

```json
{ "ok": true }
```

## GET /v1/graph/concepts/:id

按 ID 取概念;不存在回 `404`。

```bash
curl -s localhost:8702/v1/graph/concepts/c_rrf
```

Cypher:

```cypher
MATCH (c:Concept {id: $id}) RETURN c.id, c.name, c.slug, c.types, c.description, c.status, c.source
```

**Cypher 解读**:`{id: $id}` 是精确匹配主键,`RETURN` 列出要取回的七个字段,服务端组装成 `Concept` 对象返回。命中行才有结果;一条都没匹配上就说明该概念不存在,接口回 `404`。注意 `types` 取回来仍是逗号字符串,服务端会拆回数组。

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

## GET /v1/graph/concepts

列出全部概念(顺序不保证)。

```bash
curl -s localhost:8702/v1/graph/concepts
```

Cypher:

```cypher
MATCH (c:Concept) RETURN c.id, c.name, c.slug, c.types, c.description, c.status, c.source
```

**Cypher 解读**:和上一个端点几乎一样,区别只是**没有 `{id: $id}` 过滤**——`MATCH (c:Concept)` 匹配全部概念节点,返回所有行的七个字段。这就是"列出全部概念"。顺序不做保证;如果概念很多,建议在上层做分页/过滤,而不是依赖这个接口拉全量。

```json
{ "concepts": [ { "concept_id": "c_rrf", "name": "Reciprocal Rank Fusion" } ] }
```

## GET /v1/graph/relations

列出全部概念 REL 边(旧库缺 `description` 列时自动降级查询,边不丢)。

```bash
curl -s localhost:8702/v1/graph/relations
```

Cypher:

```cypher
MATCH (a:Concept)-[r:REL]->(b:Concept) RETURN a.id, b.id, r.type, r.confidence, r.source, r.description
```

**Cypher 解读**:这条专门查概念之间的 `REL` 边。写法上有一个值得注意的点:关系变量 `r` 的字段名和节点属性不一样——边的类型存在 **`r.type`**(所以请求体里那个字段叫 `rel`,落库是 `type`)。`description` 是后加的列:如果打开的是旧库、这张表还没有该列,查询会失败,服务端会自动降级成不带 `description` 的版本重查一遍,保证边数据不丢。

```json
{
  "relations": [
    { "from": "c_rrf", "to": "c_retrieval", "rel": "is_a", "confidence": 0.9, "source": "llm", "description": "RRF 是一种检索融合方法" }
  ]
}
```

## POST /v1/graph/themes/upsert

Upsert 主题;携带 `parent_id` 时维护 `CHILD_OF` 层级边(先删旧再建);未携带则不动既有层级边。

> ⚠️ 预留:当前业务尚未调用此接口,图库中暂不会有 Theme 数据(见[领域概念](#concepts))。

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

Cypher:

```cypher
MERGE (t:Theme {id: $id}) SET t.title = $title, t.slug = $slug, t.confidence = $conf, t.source = $src;
-- 仅当有 parent_id:
MERGE (p:Theme {id: $parent_id});
MATCH (t:Theme {id: $id})-[r:CHILD_OF]->() DELETE r;
MATCH (t:Theme {id: $t}), (p:Theme {id: $p}) CREATE (t)-[:CHILD_OF]->(p);
```

**Cypher 解读**(按行):
1. 第一行和 `concepts/upsert` 相同:按 `id` MERGE 主题节点,`SET` 覆盖 `title` / `slug` / `confidence` / `source`(`source` 缺省补 `llm`)。
2. 后面四行只在传了 `parent_id` 时执行:先 `MERGE (p:Theme {id: $parent_id})` 保证父主题存在(没有就占位),再删掉该主题**现有的** `CHILD_OF` 出边,最后建一条指向 `parent_id` 的新层级边——即"先清旧、再挂新",保证一个子主题只有一个父。
3. **没传 `parent_id` 时,既有的 `CHILD_OF` 边原样保留**,不会被误删。

> 提醒:Theme 相关功能当前为预留态,生产环境暂时不会走到这些语句。

```json
{ "ok": true }
```

## POST /v1/admin/clear

**清库重建**:DROP 全部表后重建 schema(供 `concept-clear` 使用;进程保持单写者,库文件不换)。**数据不可恢复,调用方应确认已备份。**

```bash
curl -s -X POST localhost:8702/v1/admin/clear
```

**行为说明**:先 DROP 全部关系表(解除依赖),再 DROP 全部节点表,然后重跑建表 DDL。

Cypher:

```cypher
DROP TABLE LINKS; DROP TABLE HAS_PARENT; DROP TABLE MENTIONS;
DROP TABLE REL; DROP TABLE CHILD_OF; DROP TABLE INCLUDES;
DROP TABLE Doc; DROP TABLE Concept; DROP TABLE Theme;
-- 随后重建 Schema(见"图 Schema"节)
```

**Cypher 解读**(按行):
1. 前两行先 DROP 全部**关系表**(LINKS / HAS_PARENT / MENTIONS / REL / CHILD_OF / INCLUDES)。关系表依赖节点表(边指向节点),所以必须先删边、再删点,否则会因外键依赖报错。
2. 第三行再 DROP 全部**节点表**(Doc / Concept / Theme)。
3. 最后服务端会重跑一遍建表 DDL,把空 schema 重建回来——所以这个接口的完整效果是"清库 + 重建结构",库文件本身不换(单写者进程仍在)。

**⚠️ 不可恢复**:所有节点和边都被物理删除。调用前务必确认已备份;`concept-clear` 这类运维流程会在调用前先备份到 `dumps/`。

```json
{ "ok": true }
```

---

# <a id="part-b"></a>Part B — 业务绑定(概念管线语义)

这些端点承载 yk-lens 概念管线的**规则**,不是通用图操作——`source=human` 保留、LLM 重抽先清后写、关联语义计算等。

## GET /v1/graph/docs/:id/related?depth=

`depth` 层内关联文档。关联来自三类:共同标签 / 出链 / 入链;结果去重、按发现顺序返回;`depth` 钳制 1~2。

```bash
curl -s "localhost:8702/v1/graph/docs/01HQEXAMPLE/related?depth=1"
```

**行为说明**:
1. `depth` 钳制(小于 1 → 1,大于 2 → 2);
2. 广度扩展,同一文档只出现一次,自身不计入;
3. 邻居来源三类:
   - **共同标签**:与目标文档有任一共享 tag,`via` = `共同标签: <tag>`;
   - **出链**:目标 `LINKS` 指向,`via` = `链接至: <标题>`;
   - **入链**:`LINKS` 指向目标,`via` = `链接自: <标题>`;
4. `depth=2` 时第二层 `via` 前缀 `经由「<第一层标题>」· `。

Cypher:

```cypher
-- 共同标签(TS 侧扫全表求交集,个人库量级可接受)
MATCH (o:Doc) RETURN o.id, o.title, o.path, o.tags;
-- 出链
MATCH (d:Doc {id: $id})-[:LINKS]->(o:Doc) RETURN o.id, o.title, o.path;
-- 入链
MATCH (d:Doc {id: $id})<-[:LINKS]-(o:Doc) RETURN o.id, o.title, o.path;
```

**Cypher 解读**(三个数据来源):
1. **共同标签**——`MATCH (o:Doc)` 全表扫一遍,把每篇文档的 `tags` 取回内存,在服务端和目标文档的标签**求交集**:有任一共享标签即算关联,`via` 记 `共同标签: <共享的标签名>`。个人知识库量级下全表扫描完全够快,所以没有用 Cypher 做。
2. **出链**——`(d)-[:LINKS]->(o)` 箭头朝右,表示"从 d **指向** o",即目标文档链出去的文档,`via` 记 `链接至: <标题>`。
3. **入链**——`(d)<-[:LINKS]-(o)` 箭头方向反过来,表示"o **指向** d",即链到目标文档的文档,`via` 记 `链接自: <标题>`。

`depth` 扩展:服务端把上面的查询当作"一步邻居",再对每个邻居重复一遍,得到第二层;`depth=2` 时第二层结果的 `via` 会加前缀 `经由「<第一层标题>」·`。全程用 `seen` 集合去重,同一文档只出现一次。

```json
{
  "docs": [
    { "doc_id": "01HQSECOND", "title": "second", "path": "inbox/notes/second.md", "via": "链接至: second", "depth": 1 },
    { "doc_id": "01HQTHIRD",  "title": "third",  "path": "inbox/notes/third.md",  "via": "共同标签: rrf",   "depth": 1 }
  ]
}
```

## GET /v1/graph/docs/:id/concepts

该文档的**全部 MENTIONS 出边**(文档提及的概念,含置信度/消歧/来源)。

```bash
curl -s localhost:8702/v1/graph/docs/01HQEXAMPLE/concepts
```

Cypher:

```cypher
MATCH (d:Doc {id: $id})-[r:MENTIONS]->(c:Concept) RETURN c.id, r.confidence, r.extraction_confidence, r.disambiguation_confidence, r.source, r.status, r.text
```

**Cypher 解读**:`(d:Doc {id: $id})-[r:MENTIONS]->(c:Concept)` 表示"从目标文档出发、沿 MENTIONS 边、到达概念"——所以这条查询拿到的是**该文档提及的所有概念**。返回的字段混合了节点和边的信息:`c.id` 是概念 ID(节点),其余 `r.*` 全部是**边上的属性**——`confidence`(总置信度)、`extraction_confidence`(抽取置信度)、`disambiguation_confidence`(消歧置信度:这个"提及"指到这个概念有多有把握)、`source`(llm/human/rule)、`status`、`text`(原文里的表面词形)。这些置信度是概念管线做门控/去噪的依据。

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

## POST /v1/graph/concepts/mentions

**半替换**某文档的 MENTIONS 出边:删除全部 `source != "human"` 旧边,再写入新边;**`human` 边原样保留**。

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
1. 删除该文档全部 `source != "human"` 的 MENTIONS 出边(机器产物退场,人工保留);
2. 逐条写入:跳过空 `concept_id`;`source` 缺省 `llm`、`status` 缺省 `active`;目标 Concept 未入库自动建占位节点;
3. 每条边完整落库置信度 / 来源 / 状态 / 表面词形。

Cypher:

```cypher
MATCH (d:Doc {id: $id})-[r:MENTIONS]->() WHERE r.source <> 'human' DELETE r;
-- 每条 edge:
MERGE (c:Concept {id: $concept_id});
MATCH (d:Doc {id: $doc}), (c:Concept {id: $concept})
CREATE (d)-[:MENTIONS {confidence: $conf, extraction_confidence: $econf,
  disambiguation_confidence: $dconf, source: $src, status: $status, text: $text}]->(c);
```

**Cypher 解读**(分两步):
1. **先清旧**:`WHERE r.source <> 'human'` 的意思是"只删来源**不是 human** 的边"——即 `llm` / `rule` 这类**机器产物**全部退场,而 `human`(人工确认)的边被排除在外、原样保留。为什么这么设计?LLM 每次重跑结果都可能变,机器产生的提及必须先清掉再写新的,否则会残留旧结果;但人工确认的提及是用户的投资,不能被机器重跑抹掉。
2. **再写新**:`MERGE (c:Concept {id: $concept_id})` 先保证概念存在(没有就占位);`MATCH (d),(c) CREATE ...` 找到文档和概念,建一条 `MENTIONS` 边并把六个属性(置信度×3、来源、状态、表面词形)一次性写进**边**上。注意:这里用的是 `CREATE`(直接建新边),不是 `MERGE`——所以"半替换"的完整语义是"旧的非 human 边删光 + 新的照单全收"。

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

```json
{ "ok": true }
```

## DELETE /v1/graph/concepts/mentions/llm

删除该文档的**全部非 human MENTIONS 出边**(只删不写;供重抽前失效旧 mention)。

```bash
curl -s -X DELETE localhost:8702/v1/graph/concepts/mentions/llm \
  -H 'Content-Type: application/json' -d '{"doc_id": "01HQEXAMPLE"}'
```

Cypher:

```cypher
MATCH (d:Doc {id: $id})-[r:MENTIONS]->() WHERE r.source <> 'human' DELETE r
```

**Cypher 解读**:这条和上一个端点的"第一步"完全相同——删除目标文档所有**非 human 来源**的 MENTIONS 出边,`human` 边保留。区别只是它**只删不写**:调用场景是"重抽前失效旧 mention"——先把这个文档的机器提及清空,LLM 重新抽取后再调 `concepts/mentions` 写入新结果。文档不存在或本来就没有非 human 提及时不匹配任何边,幂等无副作用。

```json
{ "ok": true }
```

## POST /v1/graph/concepts/relations

**幂等增量写**概念 REL 边:同 `from → to → rel` 组合先删后建,其余边不受影响。

```bash
curl -s -X POST localhost:8702/v1/graph/concepts/relations \
  -H 'Content-Type: application/json' -d '{
    "edges": [
      { "from": "c_rrf", "to": "c_retrieval", "rel": "is_a", "confidence": 0.9, "source": "llm", "description": "RRF 是一种检索融合方法" }
    ]
  }'
```

**行为说明**:逐条处理,跳过空 `from` / `to`;`rel` 缺省 `related_to`、`source` 缺省 `llm`;两端未入库自动建占位节点;**幂等**:同组合先删后建,不同 `rel` 及未涉及的边保留。

Cypher:

```cypher
-- 每条 edge:
MERGE (a:Concept {id: $from});
MERGE (b:Concept {id: $to});
MATCH (a:Concept {id: $from})-[r:REL]->(b:Concept {id: $to}) WHERE r.type = $rel DELETE r;
MATCH (a:Concept {id: $from}), (b:Concept {id: $to})
CREATE (a)-[:REL {type: $rel, confidence: $conf, source: $src, description: $descr}]->(b);
```

**Cypher 解读**(按行,每条边重复一次):
1. 前两行 `MERGE (a ...) MERGE (b ...)` — 保证两端概念节点存在(占位)。
2. `MATCH ... WHERE r.type = $rel DELETE r` — **幂等的关键**:先精确找到"从 a 到 b、类型也是 $rel"的旧边并删掉。`WHERE r.type = $rel` 保证了只删同类型的那条——如果 a→b 之间还有其他 `rel` 类型的边(比如同时有 `is_a` 和 `related_to`),它们不受影响。
3. `CREATE (a)-[:REL {type: $rel, ...}]->(b)` — 建一条新边,四个属性(类型、置信度、来源、描述)写进边里。

所以重复调用同样参数,结果是"删了旧的、建了新的",图里永远只有一条同组合的边——这就是**幂等增量写**的含义:重复执行不叠加、不重复。

| 字段 | 类型 | 说明 |
|------|------|------|
| `edges[].from` / `edges[].to` | string | 必填,两端概念 ID |
| `edges[].rel` | string | 关系类型,默认 `related_to`(`is_a` / `part_of` 等) |
| `edges[].confidence` | number | 可选 |
| `edges[].source` | string | 默认 `llm` |
| `edges[].description` | string | 关系描述(图边标签) |

```json
{ "ok": true }
```

## POST /v1/graph/themes/membership

**全量替换**主题的 doc 成员(INCLUDES 出边先删后建)。

> ⚠️ 预留:当前业务尚未调用此接口(见[领域概念](#concepts))。

```bash
curl -s -X POST localhost:8702/v1/graph/themes/membership \
  -H 'Content-Type: application/json' -d '{
    "theme_id": "t_search",
    "docs": [ { "doc_id": "01HQEXAMPLE", "confidence": 0.9 } ]
  }'
```

**行为说明**:1) 删除该主题全部 INCLUDES 出边(全量替换);2) 逐条建边:跳过空 `doc_id`,目标 Doc 未入库自动建占位节点;3) 本次未传入的文档从该主题移除。

Cypher:

```cypher
MATCH (t:Theme {id: $id})-[r:INCLUDES]->() DELETE r;
-- 每条 doc:
MERGE (d:Doc {id: $doc_id});
MATCH (t:Theme {id: $t}), (d:Doc {id: $d}) CREATE (t)-[:INCLUDES {confidence: $conf}]->(d);
```

**Cypher 解读**(和 `docs/upsert` 同构的"全量替换"):
1. `MATCH (t:Theme {id: $id})-[r:INCLUDES]->() DELETE r` — 先把该主题的**全部** INCLUDES 出边删光。这是"全量替换"的"先清旧",意味着上次收录的文档全部退场。
2. 每条 doc:`MERGE (d:Doc {id: $doc_id})` 保证文档节点存在,再 `MATCH (t),(d) CREATE (t)-[:INCLUDES {confidence: $conf}]->(d)` 建一条新的收录边。

效果:本次入参里的文档成为主题的**新成员全集**,没传的文档自动被移出该主题。同一主题连续调用两次,第二次的结果完全覆盖第一次。

> 提醒:Theme 相关功能当前为预留态,生产环境暂时不会走到这些语句。

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme_id` | string | 必填 |
| `docs[].doc_id` | string | 必填(跳过空值) |
| `docs[].confidence` | number | 可选 |
| `docs[].path` | string | 可选(当前仅记录,不影响建边) |

```json
{ "ok": true }
```
