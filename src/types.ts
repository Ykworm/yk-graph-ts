/**
 * yk-lens-graph-store-ts — 图服务 DTO 类型。
 * JSON 字段名与 lensd Go 侧 struct 的 json tag 对齐（graph_http.go 直接解码）。
 */

/** doc→doc 规则边（快照 / 测试用）。Rel：link / parent。 */
export interface DocEdge {
  from: string;
  to: string;
  rel: string; // link | parent
}

/** Related 结果项（list_related）。 */
export interface RelatedDoc {
  doc_id: string;
  title: string;
  path: string;
  via: string; // 关系描述，如 "共同标签: RRF" / "链接自: xxx"
  depth: number;
}

/** 已解析的 doc→doc 规则边（UpsertDoc 输入）。 */
export interface DocLink {
  target_id: string;
  rel: string; // link | parent
}

/** Concept 词条（taxonomy YAML 真源；图投影 Concept 节点）。 */
export interface Concept {
  concept_id: string;
  slug?: string;
  name: string;
  types?: string[];
  description?: string;
  source?: string; // rule | llm | human
  status?: string; // active | merged | deprecated
}

/** Theme 是 Catalog 主题树节点。 */
export interface Theme {
  theme_id: string;
  slug?: string;
  title: string;
  confidence?: number;
  source?: string;
  parent_id?: string; // CHILD_OF 目标
}

/** Doc → Concept 的 MENTIONS 边。 */
export interface MentionEdge {
  concept_id: string;
  confidence?: number; // = mention_confidence
  extraction_confidence?: number;
  disambiguation_confidence?: number; // 消歧：该 mention 指向此 concept_id 的把握
  source?: string; // llm | human | rule
  status?: string; // active | soft | pending
  text?: string; // surface form
}

/** Concept → Concept 的 REL 边。 */
export interface ConceptRel {
  from: string;
  to: string;
  rel: string; // related_to | is_a | part_of …
  confidence?: number;
  source?: string;
  description?: string; // LLM 生成的一句关系描述（图谱边标签）
}

/** Theme → Doc 的 INCLUDES 边。 */
export interface ThemeDocEdge {
  doc_id: string;
  confidence?: number;
  path?: string;
}

/** 后端状态（对齐 BackendStatus）。 */
export interface BackendStatus {
  backend: string;
  reachable: boolean;
  docs: number;
}

/** RemoveDocWithStats 返回值。 */
export interface RemoveDocStats {
  existed: boolean;
  edges: number;
}
