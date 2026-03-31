// src/parser.ts
function hasLiterateFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return false;
  const frontmatter = match[1];
  return /^\s*literate\s*:\s*true/m.test(frontmatter);
}
function parseLiterateMarkdown(content) {
  let body = content;
  if (body.startsWith("---")) {
    const endIndex = body.indexOf("\n---", 3);
    if (endIndex !== -1) {
      body = body.slice(endIndex + 4);
    }
  }
  const sections = body.split(/\n---\n/);
  const steps = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const step = parseStep(trimmed);
    if (step) {
      steps.push(step);
    }
  }
  return steps;
}
function parseStep(section) {
  const configMatch = section.match(/```yaml\s*\{config\}\n([\s\S]*?)```/);
  let config = { step: `step-${Date.now()}` };
  let remaining = section;
  if (configMatch) {
    const configText = configMatch[1];
    config = parseNestedYaml(configText);
    remaining = section.replace(configMatch[0], "").trim();
  }
  const codeBlocks = [];
  const blockRegex = /(```\w+\s*\{[^}]*\}\n[\s\S]*?```)/g;
  let match;
  while ((match = blockRegex.exec(remaining)) !== null) {
    const languageMatch = match[0].match(/^```(\w+)/);
    const metaMatch = match[0].match(/\{([^}]*)\}/);
    const codeMatch = match[0].match(/```\w+\s*\{[^}]*\}\n([\s\S]*?)```/);
    if (languageMatch && metaMatch && codeMatch) {
      codeBlocks.push({
        language: languageMatch[1],
        meta: metaMatch[1].split(/\s+/).filter((m) => m),
        code: codeMatch[1],
        fullBlock: match[0]
      });
    }
  }
  const prompt = remaining.replace(/```yaml\s*\{config\}\n[\s\S]*?```/g, "").trim();
  if (!prompt && codeBlocks.length === 0) {
    return null;
  }
  return { config, prompt, codeBlocks };
}
function parseSimpleYaml(text) {
  const result = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      if (value.startsWith("[") && value.endsWith("]")) {
        result[key] = value.slice(1, -1).split(",").map((s) => s.trim());
      } else if (value.startsWith('"') && value.endsWith('"')) {
        result[key] = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        result[key] = value.slice(1, -1);
      } else if (value === "true") {
        result[key] = true;
      } else if (value === "false") {
        result[key] = false;
      } else if (value === "" || value === "~" || value === "null") {
        result[key] = null;
      } else if (!isNaN(Number(value)) && value.trim() !== "") {
        result[key] = Number(value);
      } else {
        result[key] = value.trim();
      }
    }
  }
  return result;
}
function parseNestedYaml(text) {
  const result = {};
  const lines = text.split("\n");
  let currentKey = null;
  let currentNested = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const topMatch = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (topMatch && !line.startsWith(" ") && !line.startsWith("	")) {
      currentKey = topMatch[1];
      const value = topMatch[2];
      if (value === "" || value === "~") {
        result[currentKey] = {};
        currentNested = result[currentKey];
      } else {
        result[currentKey] = parseValue(value);
        currentNested = null;
      }
    } else if (currentNested !== null) {
      const nestedMatch = trimmed.match(/^(.+?)\s*:\s*(.*)$/);
      if (nestedMatch) {
        const nestedKey = nestedMatch[1];
        const nestedValue = nestedMatch[2];
        currentNested[nestedKey] = parseValue(nestedValue);
      }
    }
  }
  return result;
}
function parseCodeBlocks(section) {
  const blocks = [];
  const regex = /```(\w+)\s*\{([^}]+)\}\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(section)) !== null) {
    const language = match[1];
    const metaString = match[2];
    const code = match[3].trim();
    const meta = metaString.split(/\s+/).filter((m) => m);
    blocks.push({ language, meta, code });
  }
  return blocks;
}
function parseValue(value) {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((s) => s.trim());
  } else if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  } else if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  } else if (value === "true") {
    return true;
  } else if (value === "false") {
    return false;
  } else if (value === "" || value === "~" || value === "null") {
    return null;
  } else if (!isNaN(Number(value)) && value.trim() !== "") {
    return Number(value);
  }
  return value.trim();
}

// src/interpolation.ts
function getNestedValue(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}
function interpolate(text, metadata) {
  return text.replace(/\$(\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g, (match, path) => {
    if (path === "$") {
      return JSON.stringify(metadata);
    }
    const value = getNestedValue(metadata, path);
    return JSON.stringify(value ?? null);
  });
}
function interpolateForShell(text, metadata) {
  return text.replace(/\$(\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g, (match, path) => {
    if (path === "$") {
      return JSON.stringify(metadata);
    }
    const value = getNestedValue(metadata, path);
    if (value === null || value === void 0) {
      return "";
    }
    if (typeof value === "string") {
      return `'${value.replace(/'/g, "'\\''")}'`;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return `'${JSON.stringify(value)}'`;
  });
}

// src/executor.ts
import { execSync } from "child_process";
var INTERPRETERS = {
  python: "python3",
  python3: "python3",
  bash: "bash",
  sh: "sh",
  node: "node",
  bun: "bun",
  deno: "deno",
  ruby: "ruby",
  perl: "perl",
  php: "php"
};
function parseExecMeta(meta, language) {
  let interpreter = INTERPRETERS[language] || language || "bash";
  let mode = "stdout";
  for (const item of meta) {
    if (item.startsWith("exec=")) {
      interpreter = item.replace("exec=", "");
    } else if (item.startsWith("mode=")) {
      mode = item.replace("mode=", "");
    }
  }
  return { interpreter, mode };
}
async function runScript(block, metadata, $) {
  const { language, code, meta } = block;
  const { interpreter: interp, mode } = parseExecMeta(meta, language);
  const cmd = INTERPRETERS[interp] || interp;
  let substitutedCode;
  if (cmd === "bash" || cmd === "sh") {
    substitutedCode = interpolateForShell(code, metadata);
  } else {
    substitutedCode = interpolate(code, metadata);
  }
  let execCmd;
  if (cmd === "bash" || cmd === "sh") {
    execCmd = `${cmd} -c '${substitutedCode.replace(/'/g, "'\\''")}'`;
  } else if (cmd === "python3" || cmd === "python") {
    execCmd = `${cmd} -c '${substitutedCode.replace(/'/g, "'\\''")}'`;
  } else if (cmd === "node") {
    execCmd = `${cmd} -e '${substitutedCode.replace(/'/g, "'\\''")}'`;
  } else {
    execCmd = `${cmd} -c '${substitutedCode.replace(/'/g, "'\\''")}'`;
  }
  const useDocker = process.env.LITERATE_DOCKER === "true";
  let fullCmd;
  if (useDocker) {
    const image = process.env.LITERATE_DOCKER_IMAGE || "python:3.11";
    fullCmd = `docker run --rm ${image} ${execCmd}`;
  } else {
    fullCmd = execCmd;
  }
  try {
    const output = execSync(fullCmd, { encoding: "utf8" }).trim();
    if (mode === "stdout") {
      return { output, stored: null };
    } else if (mode === "store") {
      try {
        const parsed = JSON.parse(output);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { output: "", stored: null };
        }
        return { output: "", stored: parsed };
      } catch {
        return { output: "", stored: null };
      }
    } else {
      return { output: "", stored: null };
    }
  } catch (e) {
    return { output: `Script error: ${e.message}`, stored: null };
  }
}
async function processScripts(step, metadata, $) {
  let resultPrompt = step.prompt;
  for (const block of step.codeBlocks) {
    if (!block.meta.includes("exec")) continue;
    const { output, stored } = await runScript(block, metadata, $);
    if (stored) {
      Object.assign(metadata, stored);
    }
    const blockStr = block.fullBlock || `\`\`\`${block.language}
${block.code}
\`\`\``;
    if (output) {
      resultPrompt = resultPrompt.replace(blockStr, output);
    } else {
      resultPrompt = resultPrompt.replace(blockStr, "");
    }
  }
  return resultPrompt;
}

// src/parse.ts
function buildParseFormatInstruction(parseConfig) {
  const keys = Object.keys(parseConfig).join(", ");
  return `

Format your response as JSON with the following keys: {${keys}}. DO NOT add anything before or after the JSON response, as it will be used for parsing.`;
}
function parseResponse(responseText, parseConfig) {
  let jsonString = null;
  const jsonBlockMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) {
    jsonString = jsonBlockMatch[1];
  } else {
    const trimmed = responseText.trim();
    if (trimmed.startsWith("{")) {
      jsonString = trimmed;
    }
  }
  if (jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      const result = {};
      for (const [key, type] of Object.entries(parseConfig)) {
        if (parsed[key] !== void 0) {
          switch (type) {
            case "bool":
              result[key] = Boolean(parsed[key]);
              break;
            case "number":
              result[key] = Number(parsed[key]);
              break;
            case "string":
            default:
              result[key] = String(parsed[key]);
          }
        }
      }
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: "No valid JSON found in response" };
}
function processParse(step, responseText, metadata, client) {
  if (!step.config.parse) {
    return { success: true, data: metadata };
  }
  const result = parseResponse(responseText, step.config.parse);
  if (result.success) {
    Object.assign(metadata, result.data);
    return { success: true, data: metadata };
  } else {
    return { success: false, error: result.error };
  }
}

// src/routing.ts
function evaluateCondition(condition, metadata) {
  try {
    const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    const identifiers = [...new Set(condition.match(identifierPattern) || [])];
    const knownVars = identifiers.filter((id) => {
      if (["true", "false", "null", "undefined", "NaN", "Infinity"].includes(id)) return false;
      if (["typeof", "void", "delete", "in", "instanceof"].includes(id)) return false;
      return true;
    });
    const values = knownVars.map((v) => metadata[v]);
    const fn = new Function(
      ...knownVars,
      `"use strict"; return (${condition});`
    );
    return fn(...values);
  } catch {
    return false;
  }
}
function findStepByName(steps, name) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].config?.step === name) {
      return i;
    }
  }
  return -1;
}
function resolveNextStep(next, steps, metadata) {
  if (!next) {
    return null;
  }
  if (typeof next === "string") {
    const index = findStepByName(steps, next);
    if (index !== -1) {
      return index;
    }
    return null;
  }
  if (typeof next === "object") {
    let conditionMatched = false;
    let defaultStep = null;
    for (const [key, value] of Object.entries(next)) {
      if (key === "_") {
        defaultStep = value;
        continue;
      }
      const evalResult = evaluateCondition(key, metadata);
      if (evalResult) {
        conditionMatched = true;
        const index = findStepByName(steps, value);
        if (index !== -1) {
          return index;
        }
        break;
      }
    }
    if (!conditionMatched && defaultStep !== null) {
      const index = findStepByName(steps, defaultStep);
      if (index !== -1) {
        return index;
      }
    }
    return null;
  }
  return null;
}

// src/plugin.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
var COMMANDS_DIR = ".opencode/commands";
var sessionStates = /* @__PURE__ */ new Map();
async function log(_client, _msg) {
}
async function getLatestAssistantResponse(client, sessionID) {
  try {
    const response = await client.session.messages({ path: { id: sessionID } });
    const messages = response.data;
    let latestAssistant = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info?.role === "assistant") {
        latestAssistant = msg;
        break;
      }
    }
    if (!latestAssistant) {
      return null;
    }
    const texts = [];
    for (const part of latestAssistant.parts || []) {
      if (part.type === "text" && part.text) {
        texts.push(part.text);
      }
    }
    return texts.join("\n");
  } catch (e) {
    console.error("[literate-commands] Error fetching messages:", e.message);
    return null;
  }
}
async function literateCommandsPlugin({ client, $ }) {
  await log(client, "[literate-commands] Plugin initialized");
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "command.execute.before": async (input, outputObj) => {
      const { command, sessionID, arguments: args } = input;
      await log(client, `[literate-commands] Intercepting /${command}`);
      const commandPath = join(COMMANDS_DIR, `${command}.md`);
      if (!existsSync(commandPath)) {
        await log(client, `[literate-commands] Command not found: ${commandPath}`);
        return;
      }
      const content = readFileSync(commandPath, "utf-8");
      const isLiterate = hasLiterateFrontmatter(content);
      if (!isLiterate) {
        await log(client, `[literate-commands] /${command} is not literate, skipping`);
        return;
      }
      await log(client, `[literate-commands] /${command} is literate, setting up state`);
      const steps = parseLiterateMarkdown(content);
      await log(client, `[literate-commands] Parsed ${steps.length} steps`);
      await log(client, `[literate-commands] Parsed ${steps.length} steps:`);
      for (let i = 0; i < steps.length; i++) {
        await log(client, `[literate-commands]   Step ${i}: "${steps[i].prompt.slice(0, 50)}..."`);
      }
      sessionStates.set(sessionID, {
        steps,
        currentStep: 0,
        metadata: { ARGUMENTS: args || "" },
        sessionID,
        commandName: command,
        pendingParse: null,
        retries: 3,
        awaitingResponse: false,
        awaitingRetry: false
      });
      await log(client, `[literate-commands] State set for session ${sessionID}`);
      const out = outputObj;
      out.parts.length = 1;
      out.parts[0] = {
        type: "text",
        text: `We are preparing to run the /${command} command.
I will give you more instructions.
Please acknowledge and await.`
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;
      const state = sessionStates.get(sessionID);
      if (!state) {
        await log(client, `[literate-commands] No state for session ${sessionID}`);
        return;
      }
      await log(client, `[literate-commands] session.idle for ${sessionID}, step ${state.currentStep}, awaitingResponse=${state.awaitingResponse}, awaitingRetry=${state.awaitingRetry}`);
      const stepIndex = state.currentStep;
      const step = state.steps[stepIndex];
      if (!step) {
        await log(client, `[literate-commands] No more steps, done`);
        sessionStates.delete(sessionID);
        return;
      }
      if (state.awaitingRetry || state.awaitingResponse) {
        const responseText = await getLatestAssistantResponse(client, sessionID);
        await log(client, `[literate-commands] Got response: ${responseText?.slice(0, 100) || "null"}...`);
        if (!responseText) {
          await log(client, `[literate-commands] No response yet, waiting...`);
          return;
        }
        const parseResult = processParse(step, responseText, state.metadata, client);
        if (parseResult.success) {
          state.awaitingRetry = false;
          state.awaitingResponse = false;
          state.pendingParse = null;
          state.retries = 3;
          await log(client, `[literate-commands] Parse succeeded, metadata: ${JSON.stringify(state.metadata)}`);
          const routedIndex = resolveNextStep(step.config.next, state.steps, state.metadata);
          if (routedIndex !== null) {
            await log(client, `[literate-commands] Routing to step ${routedIndex} via next config`);
            state.currentStep = routedIndex;
          } else {
            state.currentStep++;
            await log(client, `[literate-commands] Advancing to step ${state.currentStep}`);
          }
          const nextStepIndex = state.currentStep;
          const nextStep = state.steps[nextStepIndex];
          if (!nextStep) {
            await log(client, `[literate-commands] No more steps, done`);
            sessionStates.delete(sessionID);
            return;
          }
          await log(client, `[literate-commands] Processing step ${nextStepIndex}: "${nextStep.prompt.slice(0, 50)}..."`);
          const processedPrompt2 = await processScripts(nextStep, state.metadata, $);
          let finalPrompt2 = interpolate(processedPrompt2, state.metadata);
          if (nextStep.config.parse) {
            const formatInstruction = buildParseFormatInstruction(nextStep.config.parse);
            finalPrompt2 = finalPrompt2 + formatInstruction;
            state.pendingParse = nextStep.config.parse;
            state.awaitingResponse = true;
            await log(client, `[literate-commands] Added parse instruction, awaiting response`);
          }
          await log(client, `[literate-commands] Injecting: ${finalPrompt2.slice(0, 100)}...`);
          await client.session.promptAsync({
            path: { id: sessionID },
            body: { parts: [{ type: "text", text: finalPrompt2 }] }
          });
          if (!nextStep.config.parse) {
            const nextRoutedIndex = resolveNextStep(nextStep.config.next, state.steps, state.metadata);
            if (nextRoutedIndex !== null) {
              state.currentStep = nextRoutedIndex;
            } else {
              state.currentStep++;
            }
          }
          return;
        } else {
          state.retries--;
          state.awaitingRetry = true;
          state.awaitingResponse = false;
          await log(client, `[literate-commands] Parse failed (${state.retries} retries left): ${parseResult.error}`);
          if (state.retries > 0) {
            const retryPrompt = `Could not parse your response as valid JSON. Error: ${parseResult.error}

Please respond with ONLY a JSON block containing the required keys. Format: {${Object.keys(state.pendingParse || step.config.parse || {}).join(", ")}}.`;
            await client.session.promptAsync({
              path: { id: sessionID },
              body: { parts: [{ type: "text", text: retryPrompt }] }
            });
          } else {
            const stopPrompt = `Command stopped. Parse failed after 3 retries at step ${stepIndex}.

Current step: "${step.prompt.slice(0, 100)}..."
Variables so far: ${JSON.stringify(state.metadata)}

Please provide instructions.`;
            await client.session.promptAsync({
              path: { id: sessionID },
              body: { parts: [{ type: "text", text: stopPrompt }] }
            });
            sessionStates.delete(sessionID);
          }
          return;
        }
      }
      await log(client, `[literate-commands] Processing step ${stepIndex}: "${step.prompt.slice(0, 50)}..."`);
      const processedPrompt = await processScripts(step, state.metadata, $);
      let finalPrompt = interpolate(processedPrompt, state.metadata);
      if (step.config.parse) {
        const formatInstruction = buildParseFormatInstruction(step.config.parse);
        finalPrompt = finalPrompt + formatInstruction;
        state.pendingParse = step.config.parse;
        state.awaitingResponse = true;
        await log(client, `[literate-commands] Added parse instruction, awaiting response`);
      }
      await log(client, `[literate-commands] Injecting: ${finalPrompt.slice(0, 100)}...`);
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: finalPrompt }] }
      });
      if (step.config.stop === true) {
        await log(client, `[literate-commands] Stop requested, ending command`);
        sessionStates.delete(sessionID);
        return;
      }
      if (!step.config.parse) {
        const routedIndex = resolveNextStep(step.config.next, state.steps, state.metadata);
        if (routedIndex !== null) {
          await log(client, `[literate-commands] Routing to step ${routedIndex} via next config`);
          state.currentStep = routedIndex;
        } else {
          await log(client, `[literate-commands] Advancing to step ${stepIndex + 1}`);
          state.currentStep++;
        }
      }
    }
  };
}
export {
  buildParseFormatInstruction,
  literateCommandsPlugin as default,
  evaluateCondition,
  findStepByName,
  getNestedValue,
  hasLiterateFrontmatter,
  interpolate,
  interpolateForShell,
  parseCodeBlocks,
  parseExecMeta,
  parseLiterateMarkdown,
  parseNestedYaml,
  parseResponse,
  parseSimpleYaml,
  parseStep,
  processParse,
  processScripts,
  resolveNextStep,
  runScript
};
