/**
 * GraphStore — Ladybug 图存储的 TS 实现。
 *
 * 语义 1:1 移植自 lensd 的 internal/store/graph_ladybug.go（2026-08-11 已由 yk-graph-ts 接管），
 * 唯一变化：值全部参数化查询（prepare/execute），不再字符串拼接 Cypher。
 *
 * - Connection 非线程安全 → 所有操作经一条 promise 串行队列（复刻 Go 侧互斥锁语义，
 *   个人库量级无瓶颈）。
 * - 写方法不抛错（对齐 Go 侧 `_ = g.exec(...)` 软忽略）：单条失败不影响整体语义。
 */
import lbug, {
  type Connection,
  type Database,
  type LbugValue,
  type QueryResult,
} from "@ladybugdb/core";
import type {
  BackendStatus,
  Concept,
  ConceptRel,
  DocEdge,
  DocLink,
  MentionEdge,
  RelatedDoc,
  RemoveDocStats,
  Theme,
  ThemeDocEdge,
} from "../types.js";

export interface OpenOptions {
  readOnly?: boolean;
  /** 显式 buffer pool 大小（默认 1GB；Ladybug 默认 2^43=8TB 在受限环境 mmap 失败） */
  bufferPoolSize?: number;
  /** maxDBSize：绕开默认 8TB mmap 地址空间限制（默认 16GB） */
  maxDBSize?: number;
}

const NODE_TABLES = ["Doc", "Concept", "Theme"] as const;
const REL_TABLES = ["LINKS", "HAS_PARENT", "MENTIONS", "REL", "CHILD_OF", "INCLUDES"] as const;

export class GraphStore {
  private db: Database | null = null;
  private conn: Connection | null = null;
  /** promise 串行队列（单连接非线程安全；写操作必须串行） */
  private queue: Promise<unknown> = Promise.resolve();
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** 打开 + 幂等 DDL + 旧库迁移。打开失败抛错（lensd 启动 Fatal 语义的远端镜像）。 */
  async open(opts: OpenOptions = {}): Promise<void> {
    const bufSize = opts.bufferPoolSize ?? 1 << 30;
    const maxDBSize = opts.maxDBSize ?? 16 * 1024 ** 3;
    const db = new lbug.Database(this.dbPath, bufSize, undefined, opts.readOnly ?? false, maxDBSize);
    const conn = new lbug.Connection(db);
    await conn.init();
    this.db = db;
    this.conn = conn;
    await this.enqueue(() => this.ensureSchema());
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    this.conn = null;
    if (db) await db.close();
  }

  // ---------------------------------------------------------------------------
  // 内部：串行队列 + 查询 helper
  // ---------------------------------------------------------------------------

  /** 串行化任意异步操作（复刻 Go 侧全局互斥锁）。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get connOrThrow(): Connection {
    if (!this.conn) throw new Error("图服务未打开（GraphStore.open() 未调用）");
    return this.conn;
  }

  /**
   * 执行查询并返回 QueryResult（自动处理 conn.query/execute 返回 QueryResult|QueryResult[]）。
   * 调用方负责 close()。带 params 时走 prepare/execute 参数化。
   */
  private async q(
    stmt: string,
    params?: Record<string, LbugValue>,
  ): Promise<QueryResult | null> {
    const conn = this.connOrThrow;
    let res: QueryResult | QueryResult[];
    if (params) {
      const ps = await conn.prepare(stmt);
      if (!ps.isSuccess()) {
        throw new Error(`prepare 失败: ${ps.getErrorMessage()} (query: ${stmt.slice(0, 120)})`);
      }
      res = await conn.execute(ps, params);
    } else {
      res = await conn.query(stmt);
    }
    if (Array.isArray(res)) return res[res.length - 1] ?? null;
    return res;
  }

  /** 执行写/DDL 语句；出错软忽略（对齐 Go 侧 `_ = g.exec(...)`）。 */
  private async execSoft(stmt: string, params?: Record<string, LbugValue>): Promise<void> {
    try {
      const res = await this.q(stmt, params);
      res?.close();
    } catch {
      /* 软忽略：旧库迁移 / 单条失败不整崩 */
    }
  }

  /** 执行查询取全部行（自动 close）。 */
  private async rows(
    stmt: string,
    params?: Record<string, LbugValue>,
  ): Promise<Record<string, LbugValue>[]> {
    const res = await this.q(stmt, params);
    if (!res) return [];
    try {
      return await res.getAll();
    } finally {
      res.close();
    }
  }

  /** 执行标量 count 查询；出错/无行返回 0（对齐 Go countQuery）。 */
  private async count(stmt: string, params?: Record<string, LbugValue>): Promise<number> {
    const rs = await this.rows(stmt, params);
    if (rs.length === 0) return 0;
    const v = Object.values(rs[0])[0];
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    return 0;
  }

  /** LbugValue → string（null 容错）。 */
  private static str(v: LbugValue | undefined): string {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    return "";
  }

  /** LbugValue → number（null/异常返回 0）。 */
  private static num(v: LbugValue | undefined): number {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    return 0;
  }

  private static nz(s: string, def: string): string {
    return s === "" ? def : s;
  }

  // ---------------------------------------------------------------------------
  // Schema（Step 21-B / 迁移）
  // ---------------------------------------------------------------------------

  private async ensureSchema(): Promise<void> {
    const ddls = [
      // Step 21-B：tag 按 doc 隔离，存为 Doc.tags 属性（逗号分隔，同 Concept.types 惯例）
      "CREATE NODE TABLE IF NOT EXISTS Doc(id STRING, title STRING, path STRING, project STRING, tags STRING, PRIMARY KEY(id))",
      "CREATE REL TABLE IF NOT EXISTS LINKS(FROM Doc TO Doc)",
      // Step 21-A：parent 边落库（wiki_node/v1 parentId，child → parent）
      "CREATE REL TABLE IF NOT EXISTS HAS_PARENT(FROM Doc TO Doc)",
      // Step 18 Concept Graph
      "CREATE NODE TABLE IF NOT EXISTS Concept(id STRING, name STRING, slug STRING, types STRING, description STRING, status STRING, source STRING, PRIMARY KEY(id))",
      "CREATE NODE TABLE IF NOT EXISTS Theme(id STRING, title STRING, slug STRING, confidence DOUBLE, source STRING, PRIMARY KEY(id))",
      "CREATE REL TABLE IF NOT EXISTS MENTIONS(FROM Doc TO Concept, confidence DOUBLE, extraction_confidence DOUBLE, disambiguation_confidence DOUBLE, source STRING, status STRING, text STRING)",
      "CREATE REL TABLE IF NOT EXISTS REL(FROM Concept TO Concept, type STRING, confidence DOUBLE, source STRING, description STRING)",
      "CREATE REL TABLE IF NOT EXISTS CHILD_OF(FROM Theme TO Theme)",
      "CREATE REL TABLE IF NOT EXISTS INCLUDES(FROM Theme TO Doc, confidence DOUBLE)",
    ];
    for (const ddl of ddls) {
      await this.execSoft(ddl);
    }
    // Step 21-B 旧库迁移（幂等；新库上这些语句报错属正常，忽略）：
    // ① 旧 Doc 表补 tags 列；② 退场 Tag / HAS_TAG 表（连带清掉历史孤儿 Tag 节点）。
    // 旧库的规则边数据靠重跑概念管线（concepts/reprocess → StepGraphRule）重建。
    await this.execSoft("ALTER TABLE Doc ADD tags STRING DEFAULT ''");
    // 旧库 REL 表补 description 列（关系语义描述，2026-08-10）
    await this.execSoft("ALTER TABLE REL ADD description STRING DEFAULT ''");
    await this.execSoft("DROP TABLE HAS_TAG");
    await this.execSoft("DROP TABLE Tag");
  }

  /** 清库（concept-clear 用）：DROP 全部表后重建 schema（进程保持单写者）。 */
  async clear(): Promise<void> {
    return this.enqueue(async () => {
      const order = [
        ...REL_TABLES, // 先删 rel 表（依赖 node 表）
        ...NODE_TABLES,
      ];
      for (const t of order) {
        await this.execSoft(`DROP TABLE ${t}`);
      }
      await this.ensureSchema();
    });
  }

  // ---------------------------------------------------------------------------
  // GraphStore：Doc 规则图
  // ---------------------------------------------------------------------------

  async upsertDoc(
    docId: string,
    project: string,
    path: string,
    title: string,
    tags: string[],
    links: DocLink[],
  ): Promise<void> {
    return this.enqueue(async () => {
      const p = { id: docId, title, path, project, tags: tags.join(",") };
      await this.execSoft(
        "MERGE (d:Doc {id: $id}) SET d.title = $title, d.path = $path, d.project = $project, d.tags = $tags",
        p,
      );
      // 全量替换关系（边先删旧）
      await this.execSoft("MATCH (d:Doc {id: $id})-[r:LINKS]->() DELETE r", { id: docId });
      await this.execSoft("MATCH (d:Doc {id: $id})-[r:HAS_PARENT]->() DELETE r", { id: docId });
      for (const l of links) {
        if (!l.target_id || l.target_id === docId) continue;
        // 目标文档可能尚未 upsert（占位节点，title 后补）
        await this.execSoft("MERGE (o:Doc {id: $id})", { id: l.target_id });
        const relTable = l.rel === "parent" ? "HAS_PARENT" : "LINKS";
        await this.execSoft(
          `MATCH (a:Doc {id: $from}), (b:Doc {id: $to}) CREATE (a)-[:${relTable}]->(b)`,
          { from: docId, to: l.target_id },
        );
      }
    });
  }

  async removeDoc(docId: string): Promise<void> {
    return this.enqueue(async () => {
      // DETACH DELETE 连带清掉该节点全部出/入边（LINKS / HAS_PARENT / MENTIONS 等），
      // 包括别的 doc 指向被删 doc 的边，不留悬挂边。
      await this.execSoft("MATCH (d:Doc {id: $id}) DETACH DELETE d", { id: docId });
    });
  }

  async removeDocWithStats(docId: string): Promise<RemoveDocStats> {
    return this.enqueue(async () => {
      const existed = (await this.count("MATCH (d:Doc {id: $id}) RETURN count(d)", { id: docId })) > 0;
      if (!existed) return { existed: false, edges: 0 };
      const edges = await this.count("MATCH (d:Doc {id: $id})-[r]-() RETURN count(r)", { id: docId });
      await this.execSoft("MATCH (d:Doc {id: $id}) DETACH DELETE d", { id: docId });
      return { existed: true, edges };
    });
  }

  async listDocEdges(): Promise<DocEdge[]> {
    return this.enqueue(async () => {
      const out: DocEdge[] = [];
      const queries = [
        { query: "MATCH (a:Doc)-[:LINKS]->(b:Doc) RETURN a.id, b.id", rel: "link" },
        { query: "MATCH (a:Doc)-[:HAS_PARENT]->(b:Doc) RETURN a.id, b.id", rel: "parent" },
      ];
      for (const { query, rel } of queries) {
        const rs = await this.rows(query);
        for (const row of rs) {
          const vals = Object.values(row);
          const from = GraphStore.str(vals[0]);
          const to = GraphStore.str(vals[1]);
          if (from === "" || to === "") continue;
          out.push({ from, to, rel });
        }
      }
      return out;
    });
  }

  async listDocTags(): Promise<Record<string, string[]>> {
    return this.enqueue(async () => {
      const out: Record<string, string[]> = {};
      const rs = await this.rows("MATCH (d:Doc) RETURN d.id, d.tags");
      for (const row of rs) {
        const vals = Object.values(row);
        const id = GraphStore.str(vals[0]);
        if (id === "") continue;
        const tags = GraphStore.str(vals[1])
          .split(",")
          .filter((t) => t !== "");
        out[id] = tags;
      }
      return out;
    });
  }

  async related(docId: string, depth: number): Promise<RelatedDoc[]> {
    let d = depth;
    if (d < 1) d = 1;
    if (d > 2) d = 2;
    return this.enqueue(async () => {
      const seen = new Set<string>([docId]);
      const out: RelatedDoc[] = [];
      const titles = new Map<string, string>([[docId, ""]]);
      let frontier = [docId];
      for (let level = 1; level <= d && frontier.length > 0; level++) {
        const next: string[] = [];
        for (const cur of frontier) {
          const nbs = await this.neighbors(cur);
          for (const nb of nbs) {
            if (seen.has(nb.doc_id)) continue;
            seen.add(nb.doc_id);
            titles.set(nb.doc_id, nb.title);
            const rd: RelatedDoc = { ...nb, depth: level };
            if (level > 1) {
              rd.via = `经由「${titles.get(cur) ?? ""}」· ${rd.via}`;
            }
            out.push(rd);
            next.push(nb.doc_id);
          }
        }
        frontier = next;
      }
      return out;
    });
  }

  /** neighbors：depth=1 关联（共享 tag / 出链 / 入链）。须在队列内调用。 */
  private async neighbors(docId: string): Promise<RelatedDoc[]> {
    const out: RelatedDoc[] = [];
    let selfTags: string[] = [];

    // 共同标签：tags 是 Doc 节点的逗号分隔属性（21-B 起 Tag/HAS_TAG 表退场），
    // 个人库量级一次扫全表在 TS 侧求交集。
    const allDocs = await this.rows("MATCH (o:Doc) RETURN o.id, o.title, o.path, o.tags");
    const others: { id: string; title: string; path: string; tags: string[] }[] = [];
    for (const row of allDocs) {
      const vals = Object.values(row);
      const id = GraphStore.str(vals[0]);
      const tags = GraphStore.str(vals[3])
        .split(",")
        .filter((t) => t !== "");
      if (id === docId) {
        selfTags = tags;
      } else if (id !== "") {
        others.push({ id, title: GraphStore.str(vals[1]), path: GraphStore.str(vals[2]), tags });
      }
    }
    for (const o of others) {
      const shared = o.tags.find((ot) => selfTags.includes(ot));
      if (shared !== undefined) {
        out.push({ doc_id: o.id, title: o.title, path: o.path, via: `共同标签: ${shared}`, depth: 0 });
      }
    }

    // 出链 / 入链
    const linkQueries = [
      {
        query: "MATCH (d:Doc {id: $id})-[:LINKS]->(o:Doc) RETURN o.id, o.title, o.path",
        via: (title: string) => `链接至: ${title}`,
      },
      {
        query: "MATCH (d:Doc {id: $id})<-[:LINKS]-(o:Doc) RETURN o.id, o.title, o.path",
        via: (title: string) => `链接自: ${title}`,
      },
    ];
    for (const { query, via } of linkQueries) {
      const rs = await this.rows(query, { id: docId });
      for (const row of rs) {
        const vals = Object.values(row);
        const oid = GraphStore.str(vals[0]);
        const otitle = GraphStore.str(vals[1]);
        const opath = GraphStore.str(vals[2]);
        if (oid === "" || oid === docId) continue;
        out.push({ doc_id: oid, title: otitle, path: opath, via: via(otitle), depth: 0 });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // StatusReporter
  // ---------------------------------------------------------------------------

  async status(): Promise<BackendStatus> {
    return this.enqueue(async () => {
      const st: BackendStatus = { backend: "ladybug", reachable: true, docs: 0 };
      try {
        st.docs = await this.count("MATCH (d:Doc) RETURN count(d)");
      } catch {
        // DB 故障（连接失效/查询抛错）→ reachable=false：
        // /v1/health 据此回 503、/v1/status 如实上报（lensd 侧 Status() 同样置 Reachable=false）。
        st.reachable = false;
      }
      return st;
    });
  }

  // ---------------------------------------------------------------------------
  // ConceptGraph
  // ---------------------------------------------------------------------------

  async upsertConcept(c: Concept): Promise<void> {
    if (!c.concept_id) return;
    return this.enqueue(async () => {
      await this.execSoft(
        "MERGE (c:Concept {id: $id}) SET c.name = $name, c.slug = $slug, c.types = $types, c.description = $description, c.status = $status, c.source = $source",
        {
          id: c.concept_id,
          name: c.name ?? "",
          slug: c.slug ?? "",
          types: (c.types ?? []).join(","),
          description: c.description ?? "",
          status: GraphStore.nz(c.status ?? "", "active"),
          source: GraphStore.nz(c.source ?? "", "human"),
        },
      );
    });
  }

  async getConcept(conceptId: string): Promise<Concept | null> {
    return this.enqueue(async () => {
      const rs = await this.rows(
        "MATCH (c:Concept {id: $id}) RETURN c.id, c.name, c.slug, c.types, c.description, c.status, c.source",
        { id: conceptId },
      );
      if (rs.length === 0) return null;
      return this.conceptFromRow(Object.values(rs[0]));
    });
  }

  async listConcepts(): Promise<Concept[]> {
    return this.enqueue(async () => {
      const rs = await this.rows(
        "MATCH (c:Concept) RETURN c.id, c.name, c.slug, c.types, c.description, c.status, c.source",
      );
      return rs.map((row) => this.conceptFromRow(Object.values(row)));
    });
  }

  private conceptFromRow(row: LbugValue[]): Concept {
    const types = GraphStore.str(row[3])
      .split(",")
      .filter((t) => t !== "");
    const c: Concept = {
      concept_id: GraphStore.str(row[0]),
      name: GraphStore.str(row[1]),
      slug: GraphStore.str(row[2]),
      description: GraphStore.str(row[4]),
      status: GraphStore.str(row[5]),
      source: GraphStore.str(row[6]),
    };
    if (types.length > 0) c.types = types;
    return c;
  }

  async patchMentions(docId: string, edges: MentionEdge[]): Promise<void> {
    return this.enqueue(async () => {
      // 只删 llm 边，保留 human
      await this.execSoft(
        "MATCH (d:Doc {id: $id})-[r:MENTIONS]->() WHERE r.source <> 'human' DELETE r",
        { id: docId },
      );
      await this.execSoft("MERGE (d:Doc {id: $id})", { id: docId });
      for (const e of edges) {
        if (!e.concept_id) continue;
        const src = GraphStore.nz(e.source ?? "", "llm");
        const st = GraphStore.nz(e.status ?? "", "active");
        await this.execSoft("MERGE (c:Concept {id: $id})", { id: e.concept_id });
        await this.execSoft(
          "MATCH (d:Doc {id: $doc}), (c:Concept {id: $concept}) CREATE (d)-[:MENTIONS {confidence: $conf, extraction_confidence: $econf, disambiguation_confidence: $dconf, source: $src, status: $status, text: $text}]->(c)",
          {
            doc: docId,
            concept: e.concept_id,
            conf: e.confidence ?? 0,
            econf: e.extraction_confidence ?? 0,
            dconf: e.disambiguation_confidence ?? 0,
            src,
            status: st,
            text: e.text ?? "",
          },
        );
      }
    });
  }

  async removeLLMMentions(docId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.execSoft(
        "MATCH (d:Doc {id: $id})-[r:MENTIONS]->() WHERE r.source <> 'human' DELETE r",
        { id: docId },
      );
    });
  }

  async patchRelations(edges: ConceptRel[]): Promise<void> {
    return this.enqueue(async () => {
      for (const e of edges) {
        if (!e.from || !e.to) continue;
        const rel = GraphStore.nz(e.rel, "related_to");
        const src = GraphStore.nz(e.source ?? "", "llm");
        await this.execSoft("MERGE (a:Concept {id: $id})", { id: e.from });
        await this.execSoft("MERGE (b:Concept {id: $id})", { id: e.to });
        // 同 from-to-type 先删再写（幂等）
        await this.execSoft(
          "MATCH (a:Concept {id: $from})-[r:REL]->(b:Concept {id: $to}) WHERE r.type = $rel DELETE r",
          { from: e.from, to: e.to, rel },
        );
        await this.execSoft(
          "MATCH (a:Concept {id: $from}), (b:Concept {id: $to}) CREATE (a)-[:REL {type: $rel, confidence: $conf, source: $src, description: $descr}]->(b)",
          { from: e.from, to: e.to, rel, conf: e.confidence ?? 0, src, descr: e.description ?? "" },
        );
      }
    });
  }

  async upsertTheme(t: Theme): Promise<void> {
    if (!t.theme_id) return;
    return this.enqueue(async () => {
      await this.execSoft(
        "MERGE (t:Theme {id: $id}) SET t.title = $title, t.slug = $slug, t.confidence = $conf, t.source = $src",
        {
          id: t.theme_id,
          title: t.title ?? "",
          slug: t.slug ?? "",
          conf: t.confidence ?? 0,
          src: GraphStore.nz(t.source ?? "", "llm"),
        },
      );
      if (t.parent_id) {
        await this.execSoft("MERGE (p:Theme {id: $id})", { id: t.parent_id });
        await this.execSoft("MATCH (t:Theme {id: $id})-[r:CHILD_OF]->() DELETE r", { id: t.theme_id });
        await this.execSoft(
          "MATCH (t:Theme {id: $t}), (p:Theme {id: $p}) CREATE (t)-[:CHILD_OF]->(p)",
          { t: t.theme_id, p: t.parent_id },
        );
      }
    });
  }

  async patchThemeMembership(themeId: string, docs: ThemeDocEdge[]): Promise<void> {
    return this.enqueue(async () => {
      await this.execSoft("MATCH (t:Theme {id: $id})-[r:INCLUDES]->() DELETE r", { id: themeId });
      await this.execSoft("MERGE (t:Theme {id: $id})", { id: themeId });
      for (const d of docs) {
        if (!d.doc_id) continue;
        await this.execSoft("MERGE (d:Doc {id: $id})", { id: d.doc_id });
        await this.execSoft(
          "MATCH (t:Theme {id: $t}), (d:Doc {id: $d}) CREATE (t)-[:INCLUDES {confidence: $conf}]->(d)",
          { t: themeId, d: d.doc_id, conf: d.confidence ?? 0 },
        );
      }
    });
  }

  async relatedConcepts(docId: string): Promise<MentionEdge[]> {
    return this.enqueue(async () => {
      const rs = await this.rows(
        "MATCH (d:Doc {id: $id})-[r:MENTIONS]->(c:Concept) RETURN c.id, r.confidence, r.extraction_confidence, r.disambiguation_confidence, r.source, r.status, r.text",
        { id: docId },
      );
      return rs.map((row) => {
        const vals = Object.values(row);
        return {
          concept_id: GraphStore.str(vals[0]),
          confidence: GraphStore.num(vals[1]),
          extraction_confidence: GraphStore.num(vals[2]),
          disambiguation_confidence: GraphStore.num(vals[3]),
          source: GraphStore.str(vals[4]),
          status: GraphStore.str(vals[5]),
          text: GraphStore.str(vals[6]),
        };
      });
    });
  }

  async listRelations(): Promise<ConceptRel[]> {
    return this.enqueue(async () => {
      // 旧库 ALTER 失败（无 description 列）时退回五列查询，保证 REL 边不消失
      let rs: Record<string, LbugValue>[];
      try {
        rs = await this.rows(
          "MATCH (a:Concept)-[r:REL]->(b:Concept) RETURN a.id, b.id, r.type, r.confidence, r.source, r.description",
        );
      } catch {
        rs = await this.rows(
          "MATCH (a:Concept)-[r:REL]->(b:Concept) RETURN a.id, b.id, r.type, r.confidence, r.source",
        );
      }
      return rs.map((row) => {
        const vals = Object.values(row);
        const rel: ConceptRel = {
          from: GraphStore.str(vals[0]),
          to: GraphStore.str(vals[1]),
          rel: GraphStore.str(vals[2]),
          confidence: GraphStore.num(vals[3]),
          source: GraphStore.str(vals[4]),
        };
        if (vals.length >= 6) rel.description = GraphStore.str(vals[5]);
        return rel;
      });
    });
  }
}
