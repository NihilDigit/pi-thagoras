import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryRequest } from "../upstream/pi-packages/packages/pi-auto-review/src/review/input.ts";
import { complete } from "../upstream/pi-packages/packages/pi-auto-review/src/review/complete.ts";
import { DEFAULT_CONFIG } from "../upstream/pi-packages/packages/pi-auto-review/src/review/config.ts";
import { PermissionGateHandler } from "../upstream/pi-permission-packages/packages/pi-permission-system/src/handlers/permission-gate-handler.ts";
import { describeToolGate } from "../upstream/pi-permission-packages/packages/pi-permission-system/src/handlers/gates/tool.ts";
import { ToolPreviewFormatter, resolveToolPreviewLimits } from "../upstream/pi-permission-packages/packages/pi-permission-system/src/tool-input/tool-preview-formatter.ts";
import { ForwardedRequestServer } from "../upstream/pi-permission-packages/packages/pi-permission-system/src/authority/forwarded-request-server.ts";
import { createPermissionForwardingLocation } from "../upstream/pi-permission-packages/packages/pi-permission-system/src/authority/permission-forwarding.ts";

const logger = { debug() {}, review() {}, warn() {}, error() {}, warning() {} };
const input = { message: "这是完整合成汇报。".repeat(60) + "END-CONSTRAINT: read only; no deployment" };
const registration = { name: "synthetic_report", description: "Read-only synthetic report", parameters: { type: "object", properties: { message: { type: "string" } } } };
const context = {
  sessionManager: { getSessionId: () => "parent", buildContextEntries: () => [
    { id: "old", message: { role: "user", content: "Sol: obsolete maintenance task" } },
    { id: "current", message: { role: "user", content: "Read the synthetic report. Do not deploy." } },
  ] },
  modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
};

for (const mode of ["allow", "deny", "redacted", "legacy"]) {
  test(`SDK gate → real file inbox → reviewer → terminal response: ${mode}`, async () => {
    let descriptor;
    const handler = new PermissionGateHandler(
      { activate() {}, resolveAgentName: () => "Sol" }, { getAll: () => [registration] },
      { evaluate: async (call) => {
        descriptor = describeToolGate(call, { toolName: registration.name, state: "ask" }, new ToolPreviewFormatter(resolveToolPreviewLimits()));
        return { action: "continue" };
      } }, {}, {},
    );
    await handler.handleToolCall({ toolName: registration.name, toolCallId: "call-42", input: {
      ...input, ...(mode === "redacted" ? { apiKey: "synthetic-secret" } : {}),
    } }, { cwd: ".", sessionManager: { getSessionId: () => "child" } });
    const payload = descriptor.payload;
    if (mode === "legacy") delete payload.action;
    const root = mkdtempSync(join(tmpdir(), "pitato-review-contract-"));
    const location = createPermissionForwardingLocation(root, "parent");
    mkdirSync(location.requestsDir, { recursive: true });
    const requestId = `synthetic-${mode}`;
    writeFileSync(join(location.requestsDir, `${requestId}.json`), JSON.stringify({
      id: requestId, createdAt: Date.now(), requesterSessionId: "child", targetSessionId: "parent", requesterAgentName: "Sol",
      source: "tool_call", surface: registration.name, value: registration.name, payload,
    }));
    let resolutions = 0;
    let observed;
    const server = new ForwardedRequestServer({ forwardingDir: root, logger,
      policy: { resolve: () => ({ state: "ask", toolName: registration.name }) },
      escalator: { escalate: async (details) => {
        const request = boundaryRequest({ cwd: "." }, details, { checkPermission: () => "ask" });
        if (mode === "allow" || mode === "deny") assert.deepEqual(request.toolAction.input, input);
        observed = await complete(context, DEFAULT_CONFIG, request, undefined, async () => {
          resolutions++;
          return { model: { id: "synthetic", name: "Synthetic", provider: "test", api: "test" },
            streamSimple: (_model, transcript) => ({ result: async () => {
              const wire = JSON.stringify(transcript);
              assert.ok(wire.includes("END-CONSTRAINT"));
              assert.ok(!wire.includes("obsolete maintenance task"));
              return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ outcome: mode }) }] };
            } }),
          };
        });
        return { approved: observed.decision.outcome === "allow", state: observed.decision.outcome === "allow" ? "approved" : "denied",
          decidedBy: { kind: "authorizer", name: "synthetic-reviewer", verdict: observed.decision.outcome === "allow" ? "allow" : "deny", reason: observed.decision.rationale } };
      } }, broadcaster: { emitDecision() {} }, recorder: { recordSessionApproval() {} },
    });
    await server.processInbox({ sessionManager: { getSessionId: () => "parent" } });
    assert.ok(observed, "real server must call the escalation boundary");
    const response = JSON.parse(readFileSync(join(location.responsesDir, `${requestId}.json`), "utf8"));
    assert.equal(response.approved, mode === "allow");
    assert.equal(resolutions, mode === "allow" || mode === "deny" ? 1 : 0);
    assert.equal(observed.decision.outcome, mode === "redacted" || mode === "legacy" ? "defer" : mode);
  });
}
