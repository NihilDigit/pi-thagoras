import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const piRoot = process.argv[2];
if (!piRoot) throw new Error("Pass the managed pi-coding-agent package root");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const subagentRoot = resolve(process.argv[3] ?? join(root, "upstream/pi-subagents"));
const extension = process.argv[3] ? "js" : "ts";
const receiptPath = resolve(process.argv[4] ?? join(root, "remote/.maintenance/controls-sdk-smoke.json"));
mkdirSync(dirname(receiptPath), { recursive: true });
const directory = mkdtempSync(join(tmpdir(), "pitato-controls-sdk-"));
const agentDir = join(directory, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = piRoot;
const moduleUrl = (name) => pathToFileURL(join(subagentRoot, `src/${name}.${extension}`)).href;
const [
  { createDefaultChildSessionFactory }, { registerSessionFastMode }, { runSync }, { runChildSession },
] = await Promise.all([
  import(moduleUrl("runs/shared/child-session")), import(moduleUrl("shared/fast-mode")),
  import(moduleUrl("runs/foreground/execution")), import(moduleUrl("runs/background/run-child-session")),
]);
const host = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const requests = [];
let streamStarted;
let firstStreamAborted = false;
let toolStarted;
let toolAborted = false;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  const lastUser = [...payload.messages].reverse().find((message) => message.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({
    id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "controls-probe",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  chunk({ role: "assistant" });
  if (text?.includes("HOLD_STREAM")) {
    chunk({ content: "unfinished response" });
    streamStarted?.();
    response.once("close", () => { if (!response.writableEnded) firstStreamAborted = true; });
    const timer = setTimeout(() => { chunk({ content: "OLD_RESPONSE_FINISHED" }); chunk({}, "stop"); response.end("data: [DONE]\n\n"); }, 30000);
    timer.unref();
    response.once("close", () => clearTimeout(timer));
  } else if (text?.includes("HOLD_TOOL") && !payload.messages.some((message) => message.role === "tool")) {
    chunk({ tool_calls: [{ index: 0, id: "wait-call", type: "function", function: { name: "wait_probe", arguments: "{}" } }] });
    chunk({}, "tool_calls");
    response.end("data: [DONE]\n\n");
  } else {
    chunk({ content: "CONTROL_SMOKE_DONE" }); chunk({}, "stop");
    response.end("data: [DONE]\n\n");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { openai: {
  baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "synthetic-local-only",
  models: [{ id: "controls-probe", name: "Controls probe", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000 }],
} } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "controls-probe", defaultThinkingLevel: "off" }));

const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => host });
const registerProbe = (pi) => pi.registerTool({ name: "wait_probe", label: "Wait probe", description: "Deterministic cancellable test tool; no filesystem or network.",
  parameters: { type: "object", properties: {} },
  async execute(_id, _args, signal) {
    toolStarted?.();
    await new Promise((done) => {
      if (signal?.aborted) { toolAborted = true; done(); return; }
      signal?.addEventListener("abort", () => { toolAborted = true; done(); }, { once: true });
    });
    return { content: [{ type: "text", text: "Test tool cancelled" }], details: {} };
  },
});
const definition = () => ({ cwd: directory, storage: { kind: "memory" }, model: "openai/controls-probe",
  tools: ["wait_probe"], extensionPaths: [], ambientExtensions: false,
  hooks: [{ name: "test:fast-parent", factory: registerSessionFastMode }, { name: "test:wait", factory: registerProbe }],
  noSkills: true, noContextFiles: true,
  runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false },
});
const create = () => factory.create(definition());
const deadline = setTimeout(() => { console.error("Controls SDK smoke timeout"); process.exit(1); }, 60000);
const receipt = {};
try {
  const parent = await create("parent");
  await parent.prompt("BASELINE");
  assert.equal(requests.at(-1).service_tier, undefined);
  await parent.prompt("/fast on");
  await parent.prompt("FAST_PARENT");
  assert.equal(requests.at(-1).service_tier, "priority");
  const agent = { name: "probe", description: "Synthetic native child", systemPrompt: "Return a short response.", model: "openai/controls-probe", tools: [],
    source: "user", filePath: join(directory, "probe.md") };
  writeFileSync(agent.filePath, "Synthetic probe");
  const run = (fast) => runSync(directory, [agent], "probe", "SYNTHETIC_CHILD", {
    childSessionFactory: factory, parentSessionId: parent.sessionId, ...(fast === undefined ? {} : { fast }),
    timeoutMs: 10000, sessionEnabled: false,
  });
  const inherited = await run();
  assert.equal(inherited.exitCode, 0, inherited.error);
  assert.equal(requests.at(-1).service_tier, "priority");
  const explicitOff = await run(false);
  assert.equal(explicitOff.exitCode, 0, explicitOff.error);
  assert.equal(requests.at(-1).service_tier, undefined);
  await parent.prompt("/fast off");
  await parent.prompt("NORMAL_PARENT");
  assert.equal(requests.at(-1).service_tier, undefined);
  const explicitOn = await run(true);
  assert.equal(explicitOn.exitCode, 0, explicitOn.error);
  assert.equal(requests.at(-1).service_tier, "priority");
  receipt.fast = { optIn: true, parentPayload: true, inheritedChildPayload: true, explicitFalse: true, explicitTrue: true };
  await parent.dispose();

  const streaming = await create("stream");
  const started = new Promise((done) => { streamStarted = done; });
  const streamingRun = streaming.prompt("HOLD_STREAM");
  await started;
  const streamInterruptAt = Date.now();
  await streaming.steer("NEW_GUIDANCE_STREAM");
  await streamingRun;
  assert.equal(firstStreamAborted, true);
  assert.ok(Date.now() - streamInterruptAt < 5000, "steering waited for the old 30-second response");
  assert.ok(JSON.stringify(requests.at(-1).messages).includes("NEW_GUIDANCE_STREAM"));
  assert.ok(streaming.messages.some((message) => JSON.stringify(message.content).includes("CONTROL_SMOKE_DONE")));
  assert.equal(streaming.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("NEW_GUIDANCE_STREAM")).length, 1);
  receipt.streamingInterrupted = true;
  await streaming.dispose();

  const tooling = await create("tool");
  const startedTool = new Promise((done) => { toolStarted = done; });
  const toolingRun = tooling.prompt("HOLD_TOOL");
  await startedTool;
  await tooling.steer("NEW_GUIDANCE_TOOL");
  await toolingRun;
  assert.equal(toolAborted, true);
  assert.ok(JSON.stringify(requests.at(-1).messages).includes("NEW_GUIDANCE_TOOL"), JSON.stringify({
    recentRequests: requests.slice(-3).map((request) => request.messages.filter((message) => message.role === "user")),
    messages: tooling.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content, stopReason: message.stopReason, errorMessage: message.errorMessage })),
  }));
  assert.equal(tooling.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("NEW_GUIDANCE_TOOL")).length, 1);
  receipt.toolInterrupted = true;
  await tooling.dispose();

  let steer;
  const outcomes = [];
  const backgroundToolStarted = new Promise((done) => { toolStarted = done; });
  toolAborted = false;
  const hosted = runChildSession({ factory,
    launch: { session: definition(), capture: { finalDrainHeld: () => false } },
    prompt: "HOLD_TOOL", appendChildEvent() {}, writeOutputLine() {},
    registerSteer(handler) { steer = handler; },
    onSteerOutcome(request, outcome) { outcomes.push({ id: request.id, ...outcome }); },
  });
  await backgroundToolStarted;
  await steer({ type: "steer", id: "synthetic-live-steer", ts: Date.now(), mode: "steer", message: "NEW_GUIDANCE_HOSTED" });
  const hostedResult = await hosted;
  assert.equal(hostedResult.exitCode, 0, hostedResult.error);
  assert.equal(toolAborted, true);
  assert.match(hostedResult.finalOutput, /CONTROL_SMOKE_DONE/);
  assert.equal(outcomes.filter((outcome) => outcome.id === "synthetic-live-steer" && outcome.state === "delivered").length, 1);
  receipt.hostedChildInterruptedAndConsumedOnce = true;
  receipt.sdkVersion = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;
  receipt.subagentRoot = subagentRoot;
  receipt.externalModelCalls = 0;
  receipt.localHttpRequests = requests.length;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  clearTimeout(deadline);
  await factory.dispose();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
