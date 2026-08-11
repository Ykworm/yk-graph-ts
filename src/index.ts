/**
 * yk-graph-ts — 给 lensd 用的图服务（Ladybug 官方 TS SDK + HTTP :8702）。
 *
 * 边界（对齐 docs/11-GRAPH-SERVICE-SPLIT.md）：
 *   - 只服务 lensd HTTP；Agent/生产前端禁止直连
 *   - Cypher 全部在本进程内，参数化查询；写操作串行（单连接）
 *   - 进程是图库文件唯一打开者（单写者由进程天然保证）；lensd 不再碰文件
 *   - 数据目录默认 ./data/ladybug，可直接接管现网 yk-lens-go/data/ladybug（零迁移）
 */
import { createApp } from "./api/server.js";
import { loadConfig, parseAddr } from "./config.js";
import { GraphStore } from "./store/graphStore.js";

async function main(): Promise<void> {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : process.env.YK_GRAPH_CONFIG || "configs/yk-graph-ts.yaml";

  const cfg = loadConfig(configPath);

  const store = new GraphStore(cfg.db_path);
  await store.open({ readOnly: cfg.read_only });
  const st = await store.status();
  console.log(
    `图存储 open：backend=ladybug path=${cfg.db_path} docs=${st.docs} reachable=${st.reachable}`,
  );

  const app = createApp(store);
  const { host, port } = parseAddr(cfg.addr);

  const server = app.listen(port, host, () => {
    console.log(`yk-graph-ts 监听 ${host}:${port}（仅 lensd 应调用；单写者进程，勿用第二进程开同一库）`);
  });

  const shutdown = async (sig: string) => {
    console.log(`收到信号 ${sig}，关闭…`);
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
