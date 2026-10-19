import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBrowserInspector } from "./subagent-inspector/server.ts";

export default function registerSubagentInspector(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  const inspector = createBrowserInspector();
  let registration: { dispose(): void } | undefined;
  pi.on("session_start", (_event, ctx) => {
    registration?.dispose();
    const request: {
      version: number;
      plugin: typeof inspector.plugin;
      result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
    } = { version: 1, plugin: inspector.plugin };
    pi.events.emit("pi-subagents:inspector-register:v1", request);
    if (request.result?.ok) registration = request.result.registration;
    else ctx.ui.notify("子代理观察入口未注册：请确认 pi-subagents 已加载。", "warning");
  });
  pi.on("session_shutdown", () => {
    registration?.dispose();
    inspector.close();
  });
}
