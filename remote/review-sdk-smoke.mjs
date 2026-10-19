import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = join(root, "upstream/remote_pi/pi-extension");
const aiRoot = join(sdkRoot, "node_modules/@earendil-works/pi-ai");
const aiPackage = JSON.parse(readFileSync(join(aiRoot, "package.json"), "utf8"));
const aiUrl = pathToFileURL(join(aiRoot, aiPackage.main)).href;
const permission = process.env.PI_REVIEW_SMOKE_PERMISSION_ENTRY ?? join(root, "upstream/pi-permission-packages/packages/pi-permission-system/src/index.ts");
const reviewerEntry = process.env.PI_REVIEW_SMOKE_REVIEWER_ENTRY ?? join(root, "upstream/pi-packages/packages/pi-auto-review/src/index.ts");
const reviewer = pathToFileURL(reviewerEntry).href;
const configUrl = pathToFileURL(join(dirname(reviewerEntry), "review/config.ts")).href;
const receipts = [];
for (const mode of ["allow", "deny", "redacted"]) {
  const temporary = mkdtempSync(join(tmpdir(), `pitato-review-sdk-${mode}-`));
  const agent = join(temporary, "agent");
  const project = join(temporary, "project");
  mkdirSync(project);
  mkdirSync(join(agent, "extensions/pi-permission-system"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ provider: "synthetic-work", model: "work", thinkingLevel: "off" }));
  writeFileSync(join(agent, "extensions/pi-permission-system/config.json"), JSON.stringify({
    permission: { "*": "ask" }, authorizerChain: ["pi-auto-review"], permissionReviewLog: false,
  }));
  const fixture = join(temporary, "fixture.mjs");
  const executed = join(temporary, "executed.json");
  const reviewed = join(temporary, "reviewed.json");
  writeFileSync(fixture, `
import { createAssistantMessageEventStream } from ${JSON.stringify(aiUrl)};
import { createPiAutoReviewExtension } from ${JSON.stringify(reviewer)};
import { DEFAULT_CONFIG } from ${JSON.stringify(configUrl)};
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const mode=${JSON.stringify(mode)};
const message='真实 SDK 合成只读任务。'.repeat(50)+'END-CONSTRAINT';
function record(path, data){const count=existsSync(path)?JSON.parse(readFileSync(path,'utf8')).count:0;writeFileSync(path,JSON.stringify({...data,count:count+1}));}
function output(model, content, reason) {
  const stream=createAssistantMessageEventStream();
  const result={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,stopReason:'pending',timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  queueMicrotask(()=>{
    stream.push({type:'start',partial:result});
    for(let i=0;i<content.length;i++){
      if(content[i].type==='toolCall'){
        stream.push({type:'toolcall_start',contentIndex:i,partial:result});
        stream.push({type:'toolcall_end',contentIndex:i,toolCall:content[i],partial:result});
      }else{
        stream.push({type:'text_start',contentIndex:i,partial:result});
        stream.push({type:'text_delta',contentIndex:i,delta:content[i].text,partial:result});
        stream.push({type:'text_end',contentIndex:i,content:content[i].text,partial:result});
      }
    }
    result.stopReason=reason;stream.push({type:'done',reason,message:result});stream.end();
  });
  return stream;
}
export default function(pi){
  const common={baseUrl:'https://invalid.example',apiKey:'synthetic-no-network'};
  const model={name:'Synthetic',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:16000,maxTokens:1000};
  pi.registerProvider('synthetic-work',{...common,api:'synthetic-work',models:[{...model,id:'work'}],streamSimple(model,context){
    if(context.messages.some(item=>item.role==='toolResult'))return output(model,[{type:'text',text:'SDK_SMOKE_DONE'}],'stop');
    return output(model,[{type:'toolCall',id:'synthetic-call-42',name:'synthetic_report',arguments:{message,...(mode==='redacted'?{apiKey:'synthetic-only-secret'}:{})}}],'toolUse');
  }});
  pi.registerProvider('synthetic-review',{...common,api:'synthetic-review',models:[{...model,id:'reviewer'}],streamSimple(model,context){
    if(!JSON.stringify(context).includes('END-CONSTRAINT'))throw Error('Full input tail lost before real reviewer');
    record(${JSON.stringify(reviewed)},{mode,fullTail:true});
    return output(model,[{type:'text',text:JSON.stringify({outcome:mode==='deny'?'deny':'allow'})}],'stop');
  }});
  pi.registerTool({name:'synthetic_report',label:'Synthetic report',description:'Read-only synthetic local status; no network or execution',
    parameters:{type:'object',properties:{message:{type:'string'},apiKey:{type:'string'}},required:['message']},
    async execute(_id,args){record(${JSON.stringify(executed)},{hasTail:args.message.endsWith('END-CONSTRAINT'),length:args.message.length});return {content:[{type:'text',text:'SYNTHETIC_TOOL_EXECUTED'}],details:{}};}
  });
  // Explicit test-only factory seam; this process has no production state,
  // real provider, credentials or general-purpose execution tool calls.
  createPiAutoReviewExtension({config:{...DEFAULT_CONFIG,model:'synthetic-review/reviewer',retries:0,policyAudit:{enabled:false,retentionDays:180}},allowUntrustedWorkspace:true})(pi);
}
`);
  const child = spawn(process.execPath, [process.env.PI_REVIEW_SMOKE_CLI ?? join(sdkRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "--mode", "rpc", "--session-id", randomUUID(), "-e", permission, "-e", fixture], {
    cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stderr = "";
  let buffer = "";
  let prompted = false;
  let uiRequests = 0;
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`SDK smoke timed out: ${mode}; ${stderr}`)), 30000);
      child.once("error", reject);
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "response" && event.id === "state" && !prompted) {
            prompted = true;
            child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "Run only the synthetic local read-only report." }) + "\n");
          }
          if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
            uiRequests++;
            child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n");
          }
          if (event.type === "agent_end" && prompted) { clearTimeout(timer); done(); }
        }
      });
      child.stdin.write('{"id":"state","type":"get_state"}\n');
    });
    assert.equal(existsSync(executed), mode === "allow", `${mode}: execution mismatch; ${stderr}`);
    assert.equal(existsSync(reviewed), mode !== "redacted", `${mode}: reviewer invocation mismatch; ${stderr}`);
    assert.equal(uiRequests > 0, mode === "redacted", `${mode}: unexpected manual UI; ${stderr}`);
    if (mode === "allow") {
      const execution = JSON.parse(readFileSync(executed, "utf8"));
      assert.equal(execution.hasTail, true);
      assert.equal(execution.count, 1);
    }
    if (mode !== "redacted") assert.equal(JSON.parse(readFileSync(reviewed, "utf8")).count, 1);
    receipts.push({ mode, executed: existsSync(executed), reviewerCalled: existsSync(reviewed), uiRequests });
  } finally {
    child.kill();
    await new Promise((done) => { if (child.exitCode !== null) done(); else child.once("exit", done); });
  }
}
const receiptPath = process.env.PI_REVIEW_SMOKE_RECEIPT ?? join(root, "remote/.maintenance/review-sdk-smoke.json");
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, JSON.stringify(receipts, null, 2));
console.log(JSON.stringify(receipts, null, 2));
