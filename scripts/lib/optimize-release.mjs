import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

function findVirtualModulesChunk(releaseRoot) {
  const chunksDir = join(
    releaseRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "chunks",
  );
  if (!existsSync(chunksDir)) return undefined;
  const match = readdirSync(chunksDir).find((f) => /^virtual-modules-.*\.js$/i.test(f));
  return match ? join(chunksDir, match) : undefined;
}

export async function generateVmShims(releaseRoot, shimsDir) {
  const vmChunk = findVirtualModulesChunk(releaseRoot);
  if (!vmChunk) return false;
  mkdirSync(shimsDir, { recursive: true });
  const { VIRTUAL_MODULES } = await import(pathToFileURL(vmChunk).href);
  const relChunkPath = relative(shimsDir, vmChunk).replace(/\\/g, "/");
  const importSpec = relChunkPath.startsWith(".") ? relChunkPath : `./${relChunkPath}`;
  const manifest = {};

  for (const [spec, modObj] of Object.entries(VIRTUAL_MODULES)) {
    const fileName = spec.replace(/[^a-zA-Z0-9_-]/g, "_") + ".mjs";
    const filePath = join(shimsDir, fileName);
    const keys = Object.keys(modObj).filter(
      (k) => k !== "default" && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k),
    );
    const lines = [
      `import { VIRTUAL_MODULES } from ${JSON.stringify(importSpec)};`,
      `const m = VIRTUAL_MODULES[${JSON.stringify(spec)}];`,
      ...keys.map((k) => `export const ${k} = m.${k};`),
      ...("default" in modObj ? ["export default m.default;"] : []),
      "",
    ];
    writeFileSync(filePath, lines.join("\n"), "utf8");
    manifest[spec] = fileName;
  }

  writeFileSync(join(shimsDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return true;
}

export function patchSubagentsFiles(subagentsRoot) {
  const swPath = join(subagentsRoot, "src", "workflows", "structured-workflow-scripts.js");
  if (existsSync(swPath)) {
    const swOrigPath = swPath + ".orig";
    if (!existsSync(swOrigPath)) {
      copyFileSync(swPath, swOrigPath);
    }
    let sw = readFileSync(swOrigPath, "utf8").replace(/\r\n/g, "\n");

    sw = sw.replace(
      'return `await runs.all([${children.map((child) => `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}, task: ${child.taskExpression} }`).join(", ")}])`;',
      'return `await runs.all([${children.map((child) => `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}${child.model ? `, model: ${JSON.stringify(child.model)}` : ""}${child.worktree !== undefined ? `, worktree: ${JSON.stringify(child.worktree)}` : ""}${child.cwd ? `, cwd: ${JSON.stringify(child.cwd)}` : ""}, task: ${child.taskExpression} }`).join(", ")}])`;',
    );

    sw = sw.replace(
      /const record = exactFields\(item, path, \["agent", "task"\], "Each tasks item accepts only agent and task\."\);\s*const agent = nonEmptyString\(record\.agent, `\$\{path\}\.agent`\);\s*const task = nonEmptyString\(record\.task, `\$\{path\}\.task`\);\s*const taskExpression = compileTemplate\(task, \{\s*path: `\$\{path\}\.task`,\s*hasOriginalTask: originalTask !== undefined,\s*previous: \{ unavailable: "tasks items may only use \{task\}\." \},\s*outputsUnavailable: "tasks items may only use \{task\}\.",?\s*\}\);\s*return \{ key: `task-\$\{index \+ 1\}`, agent, taskExpression \};/,
      `const record = exactFields(item, path, ["agent", "task", "model", "worktree", "cwd"], "Each tasks item accepts agent, task, model, worktree and cwd.");
        const agent = nonEmptyString(record.agent, \`\${path}.agent\`);
        const task = nonEmptyString(record.task, \`\${path}.task\`);
        const model = record.model === undefined ? undefined : nonEmptyString(record.model, \`\${path}.model\`);
        const worktree = typeof record.worktree === "boolean" ? record.worktree : undefined;
        const cwd = record.cwd === undefined ? undefined : nonEmptyString(record.cwd, \`\${path}.cwd\`);
        const taskExpression = compileTemplate(task, {
            path: \`\${path}.task\`,
            hasOriginalTask: originalTask !== undefined,
            previous: { unavailable: "tasks items may only use {task}." },
            outputsUnavailable: "tasks items may only use {task}.",
        });
        return { key: \`task-\${index + 1}\`, agent, model, worktree, cwd, taskExpression };`,
    );

    sw = sw.replace(
      /const itemRecord = exactFields\(item, itemPath, \["agent", "task"\], "Each parallel item accepts only agent and task\."\);\s*const agent = nonEmptyString\(itemRecord\.agent, `\$\{itemPath\}\.agent`\);\s*const task = nonEmptyString\(itemRecord\.task, `\$\{itemPath\}\.task`\);\s*return \{ key: `step-\$\{number\}-\$\{itemIndex \+ 1\}`, agent, taskExpression: compileTemplate\(task, \{ path: `\$\{itemPath\}\.task`, hasOriginalTask, previous, outputs \}\) \};/,
      `const itemRecord = exactFields(item, itemPath, ["agent", "task", "model", "worktree", "cwd"], "Each parallel item accepts agent, task, model, worktree and cwd.");
                const agent = nonEmptyString(itemRecord.agent, \`\${itemPath}.agent\`);
                const task = nonEmptyString(itemRecord.task, \`\${itemPath}.task\`);
                const model = itemRecord.model === undefined ? undefined : nonEmptyString(itemRecord.model, \`\${itemPath}.model\`);
                const worktree = typeof itemRecord.worktree === "boolean" ? itemRecord.worktree : undefined;
                const cwd = itemRecord.cwd === undefined ? undefined : nonEmptyString(itemRecord.cwd, \`\${itemPath}.cwd\`);
                return { key: \`step-\${number}-\${itemIndex + 1}\`, agent, model, worktree, cwd, taskExpression: compileTemplate(task, { path: \`\${itemPath}.task\`, hasOriginalTask, previous, outputs }) };`,
    );

    writeFileSync(swPath, sw, "utf8");
  }

  const tdPath = join(subagentsRoot, "src", "extension", "tool-description.js");
  if (existsSync(tdPath)) {
    const tdOrigPath = tdPath + ".orig";
    if (!existsSync(tdOrigPath)) {
      copyFileSync(tdPath, tdOrigPath);
    }
    let td = readFileSync(tdOrigPath, "utf8").replace(/\r\n/g, "\n");
    td = td.replace(
      "- Delegate only when the operator asked, directly or through applicable user/project instructions; size, complexity or risk alone is not authorization.",
      "- Delegate proactively per project workflow instructions: use scout for multi-file exploration (>3 files), reviewer for design/code review, and worker/lead for bounded or cross-module implementation.",
    );
    td = td.replace(
      'Independent parallel children: {workflow:"parallel",args:{tasks:[{agent,task},...]}}.',
      'Independent parallel children: {workflow:"parallel",args:{tasks:[{agent,model?,task},...]}}.',
    );
    writeFileSync(tdPath, td, "utf8");
  }

  const execPath = join(subagentsRoot, "src", "runs", "foreground", "subagent-executor.js");
  if (existsSync(execPath)) {
    const execOrigPath = execPath + ".orig";
    if (!existsSync(execOrigPath)) {
      copyFileSync(execPath, execOrigPath);
    }
    let execSrc = readFileSync(execOrigPath, "utf8").replace(/\r\n/g, "\n");
    execSrc = execSrc.replace(
      '            if (action === "stop") {\n                const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;',
      '            if (action === "stop" || action === "cancel" || action === "kill" || action === "abort") {\n                const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id ?? getAsyncInterruptTarget(deps.state, undefined, undefined, { fallbackToNewest: true })?.asyncId;',
    );
    writeFileSync(execPath, execSrc, "utf8");
  }
}

function bundleWithBun(entryPath, outPath, extraExternals = []) {
  mkdirSync(dirname(outPath), { recursive: true });
  const args = [
    "build",
    entryPath,
    `--outfile=${outPath}`,
    "--target=node",
    "--format=esm",
    "--external=@earendil-works/*",
    "--external=@mariozechner/*",
    "--external=@sinclair/typebox*",
    "--external=typebox*",
    "--external=undici",
    ...extraExternals.map((e) => `--external=${e}`),
  ];
  const res = spawnSync("bun", args, { encoding: "utf8", windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`bun build failed for ${entryPath}: ${res.stderr || res.stdout}`);
  }
}

function bundleTsExtensionInPlace(pkgDir, entryRel, bundleRel, reexportTarget) {
  const entryPath = join(pkgDir, entryRel);
  if (!existsSync(entryPath)) return;
  const origPath = entryPath + ".orig.ts";
  if (!existsSync(origPath)) {
    copyFileSync(entryPath, origPath);
  }
  const bundlePath = join(pkgDir, bundleRel);
  bundleWithBun(origPath, bundlePath);
  writeFileSync(
    entryPath,
    `export { default } from ${JSON.stringify(reexportTarget)};\nexport * from ${JSON.stringify(reexportTarget)};\n`,
    "utf8",
  );
}

export function patchWin32Clipboard(releaseRoot) {
  const chunksDir = join(
    releaseRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "chunks",
  );
  if (!existsSync(chunksDir)) return;
  for (const file of readdirSync(chunksDir)) {
    if (!file.endsWith(".js")) continue;
    const fullPath = join(chunksDir, file);
    const content = readFileSync(fullPath, "utf8");
    const target = "child.stdin?.end(options?.input)";
    const replacement =
      'child.stdin?.end(command==="clip"&&typeof options?.input=="string"?Buffer.from(options.input,"utf16le"):options?.input)';
    if (content.includes(target) && !content.includes(replacement)) {
      writeFileSync(fullPath, content.replaceAll(target, replacement), "utf8");
    }
  }
}

export async function optimizeRelease(releaseRoot) {
  const modules = join(releaseRoot, "node_modules");
  const app = join(releaseRoot, "app");
  const appPkgPath = join(app, "package.json");
  if (existsSync(appPkgPath)) {
    const cleanPkg = readFileSync(appPkgPath, "utf8").replace(/^\uFEFF/, "");
    writeFileSync(appPkgPath, cleanPkg, "utf8");
  }

  const tuiNativeSrc = join(modules, "@earendil-works", "pi-tui", "native");
  const guardsNativeDest = join(app, "guards", "native");
  if (existsSync(tuiNativeSrc)) {
    mkdirSync(dirname(guardsNativeDest), { recursive: true });
    for (const plat of readdirSync(tuiNativeSrc)) {
      const prebuildsDir = join(tuiNativeSrc, plat, "prebuilds");
      if (!existsSync(prebuildsDir)) continue;
      for (const arch of readdirSync(prebuildsDir)) {
        const archDir = join(prebuildsDir, arch);
        const destArchDir = join(guardsNativeDest, plat, "prebuilds", arch);
        mkdirSync(destArchDir, { recursive: true });
        for (const f of readdirSync(archDir)) {
          copyFileSync(join(archDir, f), join(destArchDir, f));
        }
      }
    }
  }

  patchWin32Clipboard(releaseRoot);
  await generateVmShims(releaseRoot, join(app, "guards", "vm-shims"));

  const subagentsRoot = join(modules, "pi-subagents");
  if (existsSync(subagentsRoot)) {
    patchSubagentsFiles(subagentsRoot);
    const mainIndex = join(subagentsRoot, "index.js");
    const mainOrig = mainIndex + ".orig";
    if (existsSync(mainOrig)) {
      copyFileSync(mainOrig, mainIndex);
    }
  }
}
