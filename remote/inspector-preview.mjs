import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserInspector } from "../extensions/subagent-inspector/server.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "pitato-inspector-preview-"));
const nativeRoot = process.argv[2];
if (!nativeRoot) throw new Error("Pass the installed pi-subagents root");
const status = { runId: "synthetic-inspector-preview", mode: "single", state: "running", cwd: directory,
  outputFile: join(directory, "output-0.log"),
  steps: [{ agent: "sol", task: "验证 Fast 模式与消息中断", status: "running", model: "openai/gpt-6.1-sol" }] };
writeFileSync(join(directory, "status.json"), JSON.stringify(status));
writeFileSync(join(directory, "output-0.log"), "[合成预览]\n主代理：检查 priority 参数及消息中断。\nSol：/fast、继承与显式覆盖验证通过，正在验证观察入口。\n");
const inspector = createBrowserInspector({ openBrowser: async () => {} });
const result = await inspector.plugin.open({ target: { runId: status.runId, asyncDir: directory, index: 0, status } }, {
  executable: process.execPath, argv: [join(nativeRoot, "inspector-runner.mjs")], sessionRoots: [directory], allowSteer: false, allowStop: false,
}, { focus: false });
const url = result.content[0].text.match(/http:\/\/[^\s]+/)[0];
mkdirSync(join(root, "remote/.maintenance"), { recursive: true });
writeFileSync(join(root, "remote/.maintenance/inspector-preview.json"), JSON.stringify({ url, directory }));
console.log(JSON.stringify({ url }));
const update = setTimeout(() => {
  status.state = "complete"; status.steps[0].status = "complete";
  appendFileSync(join(directory, "output-0.log"), "Sol：观察页已自动更新；关闭观察页不会停止子代理。\n");
  writeFileSync(join(directory, "status.json"), JSON.stringify(status));
}, 10000);
const stop = setTimeout(() => inspector.close(), 120000);
process.once("SIGTERM", () => { clearTimeout(update); clearTimeout(stop); inspector.close(); });
