import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const update = (_event: unknown, ctx: any) => {
    const tokens = ctx.getContextUsage()?.tokens;
    ctx.ui.setStatus("compact-warning", tokens != null && tokens > 272000
      ? `上下文 ${tokens.toLocaleString("en-US")} tokens · 建议 compact` : undefined);
  };
  for (const event of ["session_start", "turn_end", "agent_end", "session_compact"] as const)
    pi.on(event, update);
}
