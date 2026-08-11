/**
 * yk-graph-ts HTTP API — 端点与 lensd graph_ladybug.go 的 Go 方法 1:1 对应。
 * Cypher 全部留在 GraphStore 内（本文件只做 JSON 编排）。
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { GraphStore } from "../store/graphStore.js";
import type { Concept, ConceptRel, DocLink, MentionEdge, Theme, ThemeDocEdge } from "../types.js";

export function createApp(store: GraphStore): Express {
  const app = express();
  app.use(express.json({ limit: "16mb" }));

  // ---- 健康 / 状态 ---------------------------------------------------------

  app.get("/v1/health", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const st = await store.status();
      res.status(st.reachable ? 200 : 503).json({ ok: st.reachable, backend: st.backend });
    } catch (e) {
      next(e);
    }
  });

  app.get("/v1/status", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await store.status());
    } catch (e) {
      next(e);
    }
  });

  // ---- Doc 规则图 ----------------------------------------------------------

  // UpsertDoc：全量替换一篇文档的图关系（tags 实体 + doc→doc 规则边）
  app.post("/v1/graph/docs/upsert", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body as {
        doc_id?: string;
        project?: string;
        path?: string;
        title?: string;
        tags?: string[];
        links?: { target_id?: string; rel?: string }[];
      };
      if (!b.doc_id) throw new Error("必填：doc_id");
      const links: DocLink[] = (b.links ?? []).map((l) => ({
        target_id: l.target_id ?? "",
        rel: l.rel ?? "link",
      }));
      await store.upsertDoc(b.doc_id, b.project ?? "", b.path ?? "", b.title ?? "", b.tags ?? [], links);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // RemoveDoc：删除文档节点及其全部关系
  app.delete("/v1/graph/docs/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await store.removeDoc(String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // RemoveDocWithStats：带存在性/边数统计的删除
  app.post("/v1/graph/docs/remove-with-stats", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = (req.body as { doc_id?: string })?.doc_id ?? "";
      if (!docId) throw new Error("必填：doc_id");
      res.json(await store.removeDocWithStats(docId));
    } catch (e) {
      next(e);
    }
  });

  // Related：depth 层内关联文档
  app.get("/v1/graph/docs/:id/related", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const depth = req.query.depth != null ? Number(req.query.depth) : 1;
      res.json({ docs: await store.related(String(req.params.id), depth) });
    } catch (e) {
      next(e);
    }
  });

  // RelatedConcepts：从 doc 出发的 MENTIONS 邻居
  app.get("/v1/graph/docs/:id/concepts", async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ mentions: await store.relatedConcepts(String(req.params.id)) });
    } catch (e) {
      next(e);
    }
  });

  // ListDocEdges：全部 doc→doc 规则边
  app.get("/v1/graph/doc-edges", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ edges: await store.listDocEdges() });
    } catch (e) {
      next(e);
    }
  });

  // ListDocTags：全部 Doc 节点 tags
  app.get("/v1/graph/doc-tags", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ tags: await store.listDocTags() });
    } catch (e) {
      next(e);
    }
  });

  // ---- Concept / Theme -----------------------------------------------------

  app.post("/v1/graph/concepts/upsert", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await store.upsertConcept(req.body as Concept);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  app.get("/v1/graph/concepts/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await store.getConcept(String(req.params.id));
      if (!c) {
        res.status(404).json({ ok: false, error: "concept 不存在" });
        return;
      }
      res.json(c);
    } catch (e) {
      next(e);
    }
  });

  app.get("/v1/graph/concepts", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ concepts: await store.listConcepts() });
    } catch (e) {
      next(e);
    }
  });

  // PatchMentions：只替换该 doc 的 source=llm mentions（human 保留）
  app.post("/v1/graph/concepts/mentions", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body as { doc_id?: string; edges?: MentionEdge[] };
      if (!b.doc_id) throw new Error("必填：doc_id");
      await store.patchMentions(b.doc_id, b.edges ?? []);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // RemoveLLMMentions：重抽前失效本 doc 发出的 llm MENTIONS
  app.delete("/v1/graph/concepts/mentions/llm", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = (req.body as { doc_id?: string })?.doc_id ?? "";
      if (!docId) throw new Error("必填：doc_id");
      await store.removeLLMMentions(docId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // PatchRelations：Concept REL 边（幂等替换）
  app.post("/v1/graph/concepts/relations", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await store.patchRelations((req.body as { edges?: ConceptRel[] })?.edges ?? []);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ListRelations：全部 Concept REL 边
  app.get("/v1/graph/relations", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ relations: await store.listRelations() });
    } catch (e) {
      next(e);
    }
  });

  app.post("/v1/graph/themes/upsert", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await store.upsertTheme(req.body as Theme);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  app.post("/v1/graph/themes/membership", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body as { theme_id?: string; docs?: ThemeDocEdge[] };
      if (!b.theme_id) throw new Error("必填：theme_id");
      await store.patchThemeMembership(b.theme_id, b.docs ?? []);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- Admin ---------------------------------------------------------------

  // 清库（concept-clear 用）：DROP 全部表后重建 schema，进程保持单写者
  app.post("/v1/admin/clear", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await store.clear();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- 统一错误处理 ---------------------------------------------------------

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("必填") ? 400 : 500;
    console.error("api error:", msg);
    res.status(status).json({ ok: false, error: msg });
  });

  return app;
}
