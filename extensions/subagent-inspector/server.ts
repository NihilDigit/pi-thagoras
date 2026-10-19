import { createServer, type Server } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node:child_process";

interface Target {
  runId: string;
  asyncDir: string;
  index?: number;
  status: { state: string; cwd?: string; steps?: unknown[] };
}
interface Context { target: Target }
interface Launch { executable: string; argv: string[]; sessionRoots: string[]; allowSteer: boolean; allowStop: boolean }
interface Binding { id: string; target: Target; launch: Launch }
type Dashboard = (input: Record<string, unknown>) => string;
type Result = { content: Array<{ type: "text"; text: string }>; details: { mode: "management"; results: [] } };

function result(text: string): Result {
  return { content: [{ type: "text", text }], details: { mode: "management", results: [] } };
}

async function openBrowser(url: string): Promise<void> {
  const executable = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url}'`]
    : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Browser launch failed")));
  });
}

export function createBrowserInspector(options: { openBrowser?: (url: string) => Promise<void>; dashboard?: Dashboard } = {}) {
  const token = randomBytes(24).toString("hex");
  const bindings = new Map<string, Binding>();
  const dashboards = new Map<string, Promise<Dashboard>>();
  let server: Server | undefined;
  let opening: Promise<void> | undefined;
  let address: string;
  const key = (target: Target) => `${realpathSync(target.asyncDir)}\0${target.runId}\0${target.index ?? "root"}`;
  const url = (binding: Binding) => `http://${address}/${token}/${binding.id}`;
  async function dashboard(binding: Binding): Promise<Dashboard> {
    if (options.dashboard) return options.dashboard;
    const root = dirname(binding.launch.argv[0]!);
    const base = join(root, "src/runs/background/fleet-view");
    const path = `${base}.${existsSync(`${base}.js`) ? "js" : "ts"}`;
    let loaded = dashboards.get(path);
    if (!loaded) {
      loaded = import(pathToFileURL(path).href).then((module): Dashboard => (input) => module.formatAsyncRunTranscript(
        input.status, input.asyncDir, { index: input.index, lines: 60, sessionRoots: input.sessionRoots },
      ));
      dashboards.set(path, loaded);
    }
    return loaded;
  }
  async function start(): Promise<void> {
    if (opening) return opening;
    opening = new Promise<void>((resolve, reject) => {
      server = createServer(async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        if (request.method !== "GET" || request.headers.host !== address ||
            (request.headers.origin && request.headers.origin !== `http://${address}`)) {
          response.writeHead(403).end(); return;
        }
        const parsed = new URL(request.url!, `http://${address}`);
        const parts = parsed.pathname.split("/");
        if (parts.length !== 3 || parts[1] !== token) { response.writeHead(404).end(); return; }
        const binding = [...bindings.values()].find((value) => value.id === parts[2]);
        if (!binding) { response.writeHead(410).end("Inspector closed"); return; }
        if (!parsed.searchParams.has("snapshot")) {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
          response.end(page); return;
        }
        try {
          const status = JSON.parse(readFileSync(join(binding.target.asyncDir, "status.json"), "utf8"));
          if (status.runId !== binding.target.runId) throw new Error("Run identity changed");
          const render = await dashboard(binding);
          const text = render({ status, asyncDir: binding.target.asyncDir, index: binding.target.index,
            sessionRoots: binding.launch.sessionRoots, allowSteer: false, allowStop: false });
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ state: status.state, text: stripVTControlCharacters(text).slice(-200000) }));
        } catch {
          response.writeHead(503).end("Snapshot unavailable");
        }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const bound = server!.address();
        if (!bound || typeof bound === "string") { reject(new Error("Inspector did not bind loopback")); return; }
        address = `127.0.0.1:${bound.port}`;
        server!.unref();
        resolve();
      });
    });
    return opening;
  }
  const plugin = {
    name: "pitato-browser",
    available: () => true,
    owns: (context: Context) => bindings.has(key(context.target)),
    async open(context: Context, launch: Launch, params: { focus?: boolean }): Promise<Result> {
      await start();
      const bindingKey = key(context.target);
      let binding = bindings.get(bindingKey);
      const fresh = !binding;
      if (!binding) {
        binding = { id: randomUUID(), target: context.target, launch };
        bindings.set(bindingKey, binding);
      }
      if (params.focus === true || (fresh && params.focus !== false)) await (options.openBrowser ?? openBrowser)(url(binding));
      return result(`只读观察页：${url(binding)}\n关闭观察页不会停止子代理。`);
    },
    async status(context: Context): Promise<Result> {
      const binding = bindings.get(key(context.target));
      return result(binding ? `只读观察页：${url(binding)}` : "观察页已关闭。");
    },
    async close(context: Context): Promise<Result> {
      bindings.delete(key(context.target));
      return result("观察页已关闭，子代理继续运行。");
    },
  };
  return {
    plugin,
    close() {
      bindings.clear();
      server?.closeAllConnections();
      server?.close();
      server = undefined;
      opening = undefined;
    },
  };
}

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi · 子代理观察</title>
<style>body{font:16px system-ui;margin:0;background:#f7f7f5;color:#202420}main{max-width:1100px;margin:auto;padding:28px}header{display:flex;gap:18px;align-items:center}h1{font-size:22px}small{color:#626862}pre{font:14px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:22px;border:1px solid #d9ded7;border-radius:16px;background:white}#state{margin-left:auto}</style>
<main><header><h1>子代理观察</h1><span id="state">连接中…</span></header><small>只读 · 每秒更新 · 关闭此页不会停止任务</small><pre id="transcript">正在读取当前子代理…</pre></main>
<script>let busy=false;const labels={running:'执行中',queued:'等待中',complete:'已完成',failed:'失败',paused:'已暂停',stopped:'已停止'};async function refresh(){if(busy)return;busy=true;try{const response=await fetch(location.pathname+'?snapshot=1');if(!response.ok)throw Error();const snapshot=await response.json();document.getElementById('state').textContent=labels[snapshot.state]||snapshot.state;document.getElementById('transcript').textContent=snapshot.text}catch{document.getElementById('state').textContent='观察入口已断开'}finally{busy=false}}refresh();setInterval(refresh,1000)</script></html>`;
