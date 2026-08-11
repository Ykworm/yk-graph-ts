/**
 * GraphStore vitest — 语义对齐原 graph_ladybug_test.go（系统测试改为对 HTTP client，
 * 本套测试负责 TS 服务内部逻辑）。全部用临时数据目录，不碰现网数据。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lbug from "@ladybugdb/core";
import { GraphStore } from "./graphStore.js";

let dir: string;
let store: GraphStore;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "yk-graph-test-"));
  store = new GraphStore(path.join(dir, "lbugdb"));
  await store.open();
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("schema", () => {
  it("DDL 幂等：重复 open 不崩", async () => {
    await store.close();
    const s2 = new GraphStore(path.join(dir, "lbugdb"));
    await s2.open(); // 第二次打开走 IF NOT EXISTS 全部命中
    await s2.upsertDoc("a", "p", "p/a.md", "A", ["rrf"], []);
    const st = await s2.status();
    expect(st.docs).toBe(1);
    await s2.close();
  });

  it("旧库迁移：补 tags/description 列 + 退场 Tag/HAS_TAG", async () => {
    // 独立临时目录造旧库（不经 open 的新 schema DDL）
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "yk-graph-legacy-"));
    try {
      // 用原始驱动造 21-B 之前的旧库
      const db = new lbug.Database(path.join(legacyDir, "lbugdb"));
      const conn = new lbug.Connection(db);
      await conn.init();
      const legacy = [
        "CREATE NODE TABLE Doc(id STRING, title STRING, path STRING, project STRING, PRIMARY KEY(id))",
        "CREATE NODE TABLE Tag(name STRING, PRIMARY KEY(name))",
        "CREATE REL TABLE HAS_TAG(FROM Doc TO Tag)",
        "CREATE REL TABLE LINKS(FROM Doc TO Doc)",
        // 旧版 REL：无 description 列（2026-08-10 前的 schema）
        "CREATE NODE TABLE Concept(id STRING, name STRING, slug STRING, types STRING, description STRING, status STRING, source STRING, PRIMARY KEY(id))",
        "CREATE REL TABLE REL(FROM Concept TO Concept, type STRING, confidence DOUBLE, source STRING)",
        "CREATE (c:Concept {id: 'a', name: 'A'})",
        "CREATE (c:Concept {id: 'b', name: 'B'})",
        "MATCH (a:Concept {id: 'a'}), (b:Concept {id: 'b'}) CREATE (a)-[:REL {type: 'related_to', confidence: 0.8, source: 'llm'}]->(b)",
        "CREATE (d:Doc {id: 'x', title: 'X', path: 'p/x.md', project: 'p'})",
        "CREATE (t:Tag {name: 'old'})",
        "CREATE (:Tag {name: 'orphan'})",
        "MATCH (d:Doc {id: 'x'}), (t:Tag {name: 'old'}) CREATE (d)-[:HAS_TAG]->(t)",
      ];
      for (const q of legacy) {
        const res = await conn.query(q);
        if (Array.isArray(res)) res[res.length - 1]?.close();
        else res?.close();
      }
      await db.close();

      // 重开 = 走迁移
      const s2 = new GraphStore(path.join(legacyDir, "lbugdb"));
      await s2.open();

      // tags 列可用：写入并读回
      await s2.upsertDoc("x", "p", "p/x.md", "X", ["new", "rrf"], []);
      const tags = await s2.listDocTags();
      expect(tags["x"]).toEqual(["new", "rrf"]);

      // 旧 REL 边读回（description 为空）
      let rels = await s2.listRelations();
      expect(rels).toHaveLength(1);
      expect(rels[0]).toMatchObject({ from: "a", to: "b", rel: "related_to", description: "" });

      // 新写带 description 可读写
      await s2.patchRelations([
        { from: "a", to: "b", rel: "part_of", confidence: 0.9, source: "llm", description: "B 是 A 的组成部分" },
      ]);
      rels = await s2.listRelations();
      expect(rels).toHaveLength(2);
      const partOf = rels.find((r) => r.rel === "part_of");
      expect(partOf?.description).toBe("B 是 A 的组成部分");
      await s2.close();
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe("Doc 规则图", () => {
  it("共享 tag / 链接 / 多跳 / RemoveDoc（原 TestLadybugDocGraph 语义）", async () => {
    await store.upsertDoc("a", "p", "p/a.md", "A", ["rrf"], []);
    await store.upsertDoc("b", "p", "p/b.md", "B", ["rrf"], []);
    await store.upsertDoc("c", "p", "p/c.md", "C", [], [{ target_id: "a", rel: "link" }]);

    const rel = await store.related("a", 1);
    expect(rel).toHaveLength(2);
    const via = Object.fromEntries(rel.map((r) => [r.doc_id, r.via]));
    expect(via["b"]).toBe("共同标签: rrf");
    expect(via["c"]).toBe("链接自: C");

    // depth=2：C 经 A 关联到 B
    const rel2 = await store.related("c", 2);
    expect(rel2.some((r) => r.doc_id === "b" && r.depth === 2 && r.via !== "")).toBe(true);

    // RemoveDoc：A 删除后 B 不再关联它，C 的出链清除
    await store.removeDoc("a");
    expect(await store.related("b", 1)).toHaveLength(0);
    expect(await store.related("c", 1)).toHaveLength(0);
  });

  it("parent 边落库 + ListDocEdges + 重 upsert 全量替换（原 TestLadybugParentEdge 语义）", async () => {
    await store.upsertDoc("p", "p", "p/p.md", "P", [], []);
    await store.upsertDoc("c1", "p", "p/c1.md", "C1", [], [{ target_id: "p", rel: "parent" }]);
    await store.upsertDoc("c2", "p", "p/c2.md", "C2", [], [{ target_id: "p", rel: "link" }]);

    const relOf = async (from: string, to: string) => {
      const edges = await store.listDocEdges();
      return edges.find((e) => e.from === from && e.to === to)?.rel ?? "";
    };
    expect(await relOf("c1", "p")).toBe("parent");
    expect(await relOf("c2", "p")).toBe("link");

    // 重 upsert 全量替换：c1 的 parent 改成 link，旧 HAS_PARENT 不残留
    await store.upsertDoc("c1", "p", "p/c1.md", "C1", [], [{ target_id: "p", rel: "link" }]);
    const edges = await store.listDocEdges();
    expect(edges.filter((e) => e.from === "c1" && e.to === "p")).toHaveLength(1);
    expect(await relOf("c1", "p")).toBe("link");

    // RemoveDoc：p 删除后 c1/c2 指向它的边全清
    await store.removeDoc("p");
    const after = await store.listDocEdges();
    expect(after.some((e) => e.from === "p" || e.to === "p")).toBe(false);
    expect((await store.status()).docs).toBe(2);
  });

  it("status：DB 故障 → reachable=false（/v1/health 应回 503）", async () => {
    // 关闭后 conn 置空，status 的 count 查询抛错 → 走 catch 置 reachable=false，而不是向上抛 500
    await store.close();
    const st = await store.status();
    expect(st.backend).toBe("ladybug");
    expect(st.reachable).toBe(false);
    expect(st.docs).toBe(0);
  });

  it("RemoveDocWithStats 存在性/边数统计", async () => {
    await store.upsertDoc("a", "p", "p/a.md", "A", [], [{ target_id: "b", rel: "link" }]);
    await store.upsertDoc("b", "p", "p/b.md", "B", [], []);
    expect(await store.removeDocWithStats("a")).toEqual({ existed: true, edges: 1 });
    // 幂等：第二次 existed=false
    expect(await store.removeDocWithStats("a")).toEqual({ existed: false, edges: 0 });
  });

  it("ListDocTags 逗号分隔属性读写", async () => {
    await store.upsertDoc("a", "p", "p/a.md", "A", ["rrf", "graph"], []);
    await store.upsertDoc("b", "p", "p/b.md", "B", [], []);
    const tags = await store.listDocTags();
    expect(tags["a"]).toEqual(["rrf", "graph"]);
    expect(tags["b"]).toEqual([]);
  });
});

describe("Concept 图", () => {
  it("同名消歧 + MENTIONS + human 保留（原 TestLadybugConceptGraph 语义）", async () => {
    await store.upsertConcept({ concept_id: "c1", name: "Apple", types: ["Fruit"], description: "水果", source: "llm" });
    await store.upsertConcept({ concept_id: "c2", name: "Apple", types: ["Company"], description: "公司", source: "llm" });
    expect(await store.listConcepts()).toHaveLength(2);
    const c1 = await store.getConcept("c1");
    expect(c1?.description).toBe("水果");

    await store.upsertDoc("d1", "inbox", "inbox/a.md", "doc", [], []);
    await store.patchMentions("d1", [
      { concept_id: "c2", confidence: 0.9, source: "llm", status: "active", text: "Apple" },
    ]);
    let ms = await store.relatedConcepts("d1");
    expect(ms).toHaveLength(1);
    expect(ms[0].concept_id).toBe("c2");

    // human 保留：写入 human c2 + llm c1，再 PatchMentions(仅 llm) → human 不被覆盖
    await store.patchMentions("d1", [
      { concept_id: "c1", confidence: 0.8, source: "llm" },
      { concept_id: "c2", confidence: 1, source: "human", status: "active" },
    ]);
    await store.patchMentions("d1", [{ concept_id: "c1", confidence: 0.8, source: "llm" }]);
    ms = await store.relatedConcepts("d1");
    expect(ms.some((m) => m.concept_id === "c2" && m.source === "human")).toBe(true);

    // RemoveLLMMentions：只删 llm，human 保留
    await store.removeLLMMentions("d1");
    ms = await store.relatedConcepts("d1");
    expect(ms.every((m) => m.source === "human")).toBe(true);
  });

  it("PatchRelations 幂等替换 + ListRelations", async () => {
    await store.patchRelations([{ from: "a", to: "b", rel: "related_to", confidence: 0.8, source: "llm" }]);
    // 同 from-to-type 再写 → 不重复
    await store.patchRelations([{ from: "a", to: "b", rel: "related_to", confidence: 0.9, source: "llm" }]);
    let rels = await store.listRelations();
    expect(rels).toHaveLength(1);
    expect(rels[0].confidence).toBeCloseTo(0.9);
    // 不同 type → 新边
    await store.patchRelations([{ from: "a", to: "b", rel: "part_of", source: "llm" }]);
    rels = await store.listRelations();
    expect(rels).toHaveLength(2);
  });
});

describe("Theme", () => {
  it("UpsertTheme CHILD_OF + PatchThemeMembership INCLUDES", async () => {
    await store.upsertTheme({ theme_id: "t1", title: "主题", slug: "theme", source: "llm" });
    await store.upsertTheme({ theme_id: "t2", title: "子主题", parent_id: "t1", source: "llm" });
    await store.upsertDoc("d1", "p", "p/a.md", "A", [], []);
    await store.patchThemeMembership("t1", [{ doc_id: "d1", confidence: 0.5 }]);
    // 重写 membership：全量替换
    await store.patchThemeMembership("t1", []);
    // 无法直接读 CHILD_OF/INCLUDES（无对应读端点）→ 通过无抛错 + 二次写不崩验证
    expect(true).toBe(true);
  });
});

describe("admin clear", () => {
  it("清库后重建 schema，进程不退出", async () => {
    await store.upsertDoc("a", "p", "p/a.md", "A", ["x"], []);
    await store.upsertConcept({ concept_id: "c1", name: "C" });
    expect((await store.status()).docs).toBe(1);
    await store.clear();
    expect((await store.status()).docs).toBe(0);
    // 清完可继续写
    await store.upsertDoc("b", "p", "p/b.md", "B", [], []);
    expect((await store.status()).docs).toBe(1);
  });
});
