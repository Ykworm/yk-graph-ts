import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface Config {
  /** 监听地址，默认 ":8702" */
  addr: string;
  /** Ladybug 数据目录（可直接接管现网 yk-lens-go/data/ladybug，零迁移） */
  db_path: string;
  /** 只读打开（默认 false；concept-clear 等写操作需可写） */
  read_only: boolean;
}

export function defaultConfig(): Config {
  return {
    addr: ":8702",
    db_path: "data/ladybug",
    read_only: false,
  };
}

export function loadConfig(configPath?: string): Config {
  const cfg = defaultConfig();
  const p = configPath || process.env.YK_GRAPH_CONFIG || "configs/yk-graph-ts.yaml";
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8");
    const y = parseYaml(raw) as Partial<Config>;
    Object.assign(cfg, y);
  }
  if (process.env.YK_GRAPH_ADDR) cfg.addr = process.env.YK_GRAPH_ADDR;
  if (process.env.YK_GRAPH_DB) cfg.db_path = process.env.YK_GRAPH_DB;
  if (process.env.YK_GRAPH_READ_ONLY) {
    const v = process.env.YK_GRAPH_READ_ONLY;
    cfg.read_only = v === "1" || v === "true" || v === "yes";
  }
  if (!cfg.addr) cfg.addr = ":8702";
  if (!cfg.db_path) cfg.db_path = "data/ladybug";
  if (!path.isAbsolute(cfg.db_path)) {
    cfg.db_path = path.resolve(process.cwd(), cfg.db_path);
  }
  return cfg;
}

/** 解析 ":8702" / "0.0.0.0:8702" → host + port */
export function parseAddr(addr: string): { host: string; port: number } {
  let a = addr.trim();
  if (a.startsWith(":")) a = `0.0.0.0${a}`;
  const idx = a.lastIndexOf(":");
  if (idx < 0) return { host: "0.0.0.0", port: 8702 };
  const host = a.slice(0, idx) || "0.0.0.0";
  const port = parseInt(a.slice(idx + 1), 10) || 8702;
  return { host, port };
}
