/**
 * Literate Commands Plugin
 *
 * Enables step-by-step command execution from markdown.
 *
 * TESTING:
 *
 * Unit tests (parsing, interpolation):
 *   node .opencode/plugins/literate-commands.js
 *
 * Plugin integration (single command, no step advancement):
 *   opencode run --print-logs --log-level DEBUG --command test
 *
 *   Note: With `opencode run`, the session exits after the first idle,
 *   so only step 0 is injected. The acknowledgment works, and you can
 *   verify parsing, script execution, and variable interpolation from logs.
 *
 * Full step-through with SDK:
 *   // Start server, create session, run command, then prompt in a loop
 *   // See SDK docs: https://opencode.ai/docs/sdk
 *
 * Manual full test:
 *   opencode serve --print-logs --log-level DEBUG &
 *   opencode run --print-logs --log-level DEBUG --command test --attach http://localhost:PORT
 */

import { readFileSync, existsSync } from "fs"
import { join } from "path"

const COMMANDS_DIR = ".opencode/commands"

// State per session
const sessionStates = new Map()

async function log(client, msg) {
    if (!client) return
    try {
        await client.app.log({
            body: {
                service: "literate-commands",
                level: "info",
                message: msg
            }
        })
    } catch (e) {
        console.error("[literate-commands] Log error:", e.message)
    }
}

// Simple YAML check for literate: true
function hasLiterateFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return false
    const frontmatter = match[1]
    // Simple check for "literate: true" (not full YAML parsing)
    return /^\s*literate\s*:\s*true/m.test(frontmatter)
}

// ============================================================================
// Markdown Parsing
// ============================================================================

/**
 * Parse command markdown into steps.
 * Each step is separated by --- (with optional whitespace).
 */
function parseLiterateMarkdown(content) {
    // Remove frontmatter
    let body = content
    if (body.startsWith("---")) {
        const endIndex = body.indexOf("\n---", 3)
        if (endIndex !== -1) {
            body = body.slice(endIndex + 4)
        }
    }

    // Split by --- separators (with optional leading/trailing whitespace)
    const sections = body.split(/\n---\n/)
    const steps = []

    for (const section of sections) {
        const trimmed = section.trim()
        if (!trimmed) continue

        const step = parseStep(trimmed)
        if (step) {
            steps.push(step)
        }
    }

    return steps
}

/**
 * Parse a single step section.
 */
function parseStep(section) {
    // Extract config block (```yaml {config}...```)
    const configMatch = section.match(/```yaml\s*\{config\}\n([\s\S]*?)```/)
    let config = { step: `step-${Date.now()}` }
    let remaining = section

    if (configMatch) {
        // Simple YAML parsing for config
        const configText = configMatch[1]
        config = parseSimpleYaml(configText)
        remaining = section.replace(configMatch[0], "").trim()
    }

    // Extract code blocks with metadata
    const codeBlocks = parseCodeBlocks(remaining)

    // Remove code blocks from remaining to get prompt
    const blockRemovalRegex = /```\w+\s*\{[^}]+\}\n[\s\S]*?```/g
    const prompt = remaining
        .replace(blockRemovalRegex, "\n")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l)
        .join("\n")

    if (!prompt && codeBlocks.length === 0) {
        return null
    }

    return { config, prompt, codeBlocks }
}

/**
 * Simple YAML parser for flat key-value pairs.
 * Handles: key: value, key: "quoted value", key: [a, b, c]
 */
function parseSimpleYaml(text) {
    const result = {}
    const lines = text.split("\n")

    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue

        // Match "key: value" or "key: [items]"
        const match = trimmed.match(/^(\w+)\s*:\s*(.*)$/)
        if (match) {
            const [, key, value] = match

            // Try to parse the value
            if (value.startsWith("[") && value.endsWith("]")) {
                // Array
                result[key] = value.slice(1, -1).split(",").map(s => s.trim())
            } else if (value.startsWith('"') && value.endsWith('"')) {
                // Double-quoted string
                result[key] = value.slice(1, -1)
            } else if (value.startsWith("'") && value.endsWith("'")) {
                // Single-quoted string
                result[key] = value.slice(1, -1)
            } else if (value === "true") {
                result[key] = true
            } else if (value === "false") {
                result[key] = false
            } else if (value === "" || value === "~" || value === "null") {
                result[key] = null
            } else if (!isNaN(value) && value.trim() !== "") {
                result[key] = Number(value)
            } else {
                result[key] = value.trim()
            }
        }
    }

    return result
}

/**
 * Extract code blocks with their metadata.
 */
function parseCodeBlocks(section) {
    const blocks = []
    const regex = /```(\w+)\s*\{([^}]+)\}\n([\s\S]*?)```/g
    let match

    while ((match = regex.exec(section)) !== null) {
        const language = match[1]
        const metaString = match[2]
        const code = match[3].trim()

        // Parse metadata string into array
        const meta = metaString.split(/\s+/).filter(m => m)

        blocks.push({ language, meta, code })
    }

    return blocks
}

// ============================================================================
// Variable Substitution
// ============================================================================

/**
 * Get nested value from object using dot notation.
 */
function getNestedValue(obj, path) {
    return path.split(".").reduce((o, k) => o?.[k], obj)
}

/**
 * Interpolate variables in text using JSON.stringify.
 * $var → "value" (JSON-stringified)
 * $obj.nested → "nested value"
 * $$ → full metadata as JSON string
 */
function interpolate(text, metadata) {
    return text.replace(/\$(\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g, (match, path) => {
        if (path === "$") {
            return JSON.stringify(metadata)
        }
        const value = getNestedValue(metadata, path)
        return JSON.stringify(value ?? null)
    })
}

// ============================================================================
// Script Execution
// ============================================================================

const INTERPRETERS = {
    python: "python3",
    python3: "python3",
    bash: "bash",
    sh: "sh",
    javascript: "node",
    js: "node"
}

const DEFAULT_TIMEOUT = 30000

/**
 * Parse exec block metadata.
 * {exec} → { interpreter: based on language, mode: 'stdout' }
 * {exec=python3} → { interpreter: 'python3', mode: 'stdout' }
 * {exec mode=store} → { interpreter: based on language, mode: 'store' }
 */
function parseExecMeta(meta, language) {
    // Default interpreter based on language
    let interpreter = INTERPRETERS[language] || language
    let mode = "stdout"

    for (const item of meta) {
        if (item.startsWith("exec=")) {
            interpreter = item.replace("exec=", "")
        } else if (item.startsWith("mode=")) {
            mode = item.replace("mode=", "")
        }
        // "exec" without = is a marker, ignore it
    }

    return { interpreter, mode }
}

/**
 * Execute a script with variable substitution.
 */
async function runScript(block, metadata, $) {
    const { language, code, meta } = block
    const { interpreter: interp, mode } = parseExecMeta(meta, language)

    // Get actual interpreter command
    const cmd = INTERPRETERS[interp] || interp

    // Substitute variables in code
    const substitutedCode = interpolate(code, metadata)

    // Build execution command
    let execCmd
    if (cmd === "bash" || cmd === "sh") {
        execCmd = `${cmd} -c '${substitutedCode.replace(/'/g, "'\\''")}'`
    } else if (cmd === "python3" || cmd === "python") {
        execCmd = `${cmd} -c '${substitutedCode.replace(/'/g, "'\\''")}'`
    } else if (cmd === "node") {
        execCmd = `${cmd} -e '${substitutedCode.replace(/'/g, "'\\''")}'`
    } else {
        execCmd = `${cmd} -c '${substitutedCode.replace(/'/g, "'\\''")}'`
    }

    await log(null, `[literate-commands] Running script`)

    // Execute via docker or locally
    const useDocker = process.env.LITERATE_DOCKER === "true"
    let fullCmd

    if (useDocker) {
        const image = process.env.LITERATE_DOCKER_IMAGE || "python:3.11"
        fullCmd = `docker run --rm ${image} ${execCmd}`
    } else {
        fullCmd = execCmd
    }

    try {
        // Use execSync for reliable execution
        const { execSync } = require("child_process")
        const output = execSync(fullCmd, { encoding: "utf8" }).trim()

        if (mode === "stdout") {
            return { output, stored: null }
        } else if (mode === "store") {
            try {
                const parsed = JSON.parse(output)
                if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                    await log(null, `[literate-commands] Store mode requires object, got ${typeof parsed}`)
                    return { output: "", stored: null }
                }
                return { output: "", stored: parsed }
            } catch (e) {
                await log(null, `[literate-commands] JSON parse failed: ${output}`)
                return { output: "", stored: null }
            }
        } else {
            // mode === "none"
            return { output: "", stored: null }
        }
    } catch (e) {
        await log(null, `[literate-commands] Script error: ${e.message}`)
        return { output: `Script error: ${e.message}`, stored: null }
    }
}

/**
 * Process all {exec} blocks in a step.
 */
async function processScripts(step, metadata, $) {
    let resultPrompt = step.prompt
    console.log("[DEBUG] Initial prompt:\n", resultPrompt)

    for (const block of step.codeBlocks) {
        if (!block.meta.includes("exec")) continue

        const { output, stored } = await runScript(block, metadata, $)

        // Update metadata if store mode
        if (stored) {
            Object.assign(metadata, stored)
            console.log("[DEBUG] Stored metadata:", stored)
        }

        // Replace block in prompt with output (for stdout mode)
        if (output) {
            const blockPattern = `\`\`\`${block.language}\\s*\\{[^}]+\\}\\n[\\s\\S]*?\`\`\``
            console.log("[DEBUG] Block pattern:", blockPattern)
            console.log("[DEBUG] Before replace, checking match:", resultPrompt.match(new RegExp(blockPattern)) !== null)
            resultPrompt = resultPrompt.replace(new RegExp(blockPattern), output)
        } else {
            // Remove block if no output
            const blockPattern = `\`\`\`${block.language}\\s*\\{[^}]+\\}\\n[\\s\\S]*?\`\`\``
            resultPrompt = resultPrompt.replace(new RegExp(blockPattern), "")
        }
    }

    console.log("[DEBUG] Final prompt:\n", resultPrompt)
    return resultPrompt
}

export default async function literateCommandsPlugin({ client, $ }) {
    await log(client, "[literate-commands] Plugin initialized")

    return {
        "command.execute.before": async (input, output) => {
            const { command, sessionID, arguments: args } = input

            await log(client, `[literate-commands] Intercepting /${command}`)

            // Load command markdown
            const commandPath = join(COMMANDS_DIR, `${command}.md`)

            if (!existsSync(commandPath)) {
                await log(client, `[literate-commands] Command not found: ${commandPath}`)
                return // Let normal execution handle it
            }

            const content = readFileSync(commandPath, "utf-8")

            // Check for literate: true in frontmatter
            const isLiterate = hasLiterateFrontmatter(content)

            if (!isLiterate) {
                await log(client, `[literate-commands] /${command} is not literate, skipping`)
                return // Let normal execution handle it
            }

            await log(client, `[literate-commands] /${command} is literate, setting up state`)

            // Parse markdown into steps
            const steps = parseLiterateMarkdown(content)
            await log(client, `[literate-commands] Parsed ${steps.length} steps`)

            // Log each step for debugging
            await log(client, `[literate-commands] Parsed ${steps.length} steps:`)
            for (let i = 0; i < steps.length; i++) {
                await log(client, `[literate-commands]   Step ${i}: "${steps[i].prompt.slice(0, 50)}..."`)
            }

            // Set up state for this session
            sessionStates.set(sessionID, {
                steps,
                currentStep: 0,
                metadata: { ARGUMENTS: args || "" },
                sessionID,
                commandName: command
            })
            await log(client, `[literate-commands] State set for session ${sessionID}`)

            // Inject acknowledgment
            output.parts.length = 1;
            output.parts[0] = {
                type: "text",
                text: `We are preparing to run the /${command} command.\nI will give you more instructions.\nPlease acknowledge and await.`
            };
        },

        event: async ({ event }) => {
            if (event.type !== "session.idle") return

            const sessionID = event.properties?.sessionID
            if (!sessionID) return

            const state = sessionStates.get(sessionID)
            if (!state) {
                await log(client, `[literate-commands] No state for session ${sessionID}`)
                return
            }

            await log(client, `[literate-commands] session.idle for ${sessionID}, step ${state.currentStep}`)

            // Get current step
            const stepIndex = state.currentStep
            const step = state.steps[stepIndex]
            if (!step) {
                await log(client, `[literate-commands] No more steps (${stepIndex} >= ${state.steps.length}), done`)
                sessionStates.delete(sessionID)
                return
            }

            await log(client, `[literate-commands] Processing step ${stepIndex}: "${step.prompt.slice(0, 50)}..."`)
            await log(client, `[literate-commands] Code blocks: ${step.codeBlocks.length}`)

            // Process scripts (with variable substitution) and get modified prompt
            const processedPrompt = await processScripts(step, state.metadata, $)

            // Interpolate remaining variables in prompt
            const interpolatedPrompt = interpolate(processedPrompt, state.metadata)
            await log(client, `[literate-commands] Injecting step ${state.currentStep}: ${interpolatedPrompt}`)

            // Inject step prompt
            await client.session.promptAsync({
                path: { id: sessionID },
                body: {
                    parts: [{ type: "text", text: interpolatedPrompt }]
                }
            })

            // Advance to next step
            await log(client, `[literate-commands] Advancing from step ${stepIndex} to ${stepIndex + 1}`)
            state.currentStep++
        }
    }
}

// ============================================================================
// Tests (run with: node --test literate-commands.js)
// ============================================================================

function assert(condition, message) {
    if (!condition) throw new Error(`FAIL: ${message}`)
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`FAIL: ${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
    }
}

function runTests() {
    console.log("Running literate-commands tests...\n")

    // Test: hasLiterateFrontmatter
    assert(hasLiterateFrontmatter("---\nliterate: true\n---\n"), "hasLiterateFrontmatter should detect literate: true")
    assert(!hasLiterateFrontmatter("---\nliterate: false\n---\n"), "hasLiterateFrontmatter should not detect false")
    assert(!hasLiterateFrontmatter("No frontmatter"), "hasLiterateFrontmatter should return false without frontmatter")
    console.log("✓ hasLiterateFrontmatter")

    // Test: parseSimpleYaml
    assertEqual(parseSimpleYaml("key: value").key, "value", "parseSimpleYaml basic")
    assertEqual(parseSimpleYaml('key: "quoted"').key, "quoted", "parseSimpleYaml double quotes")
    assertEqual(parseSimpleYaml("key: 123").key, 123, "parseSimpleYaml number")
    assertEqual(parseSimpleYaml("key: true").key, true, "parseSimpleYaml boolean")
    assertEqual(parseSimpleYaml("key: [a, b]").key[0], "a", "parseSimpleYaml array")
    console.log("✓ parseSimpleYaml")

    // Test: parseCodeBlocks
    const blocks = parseCodeBlocks('```bash {exec}\necho hi\n```\n```python {exec mode=store}\nprint(1)\n```')
    assertEqual(blocks.length, 2, "parseCodeBlocks should find 2 blocks")
    assertEqual(blocks[0].language, "bash", "parseCodeBlocks language")
    assert(blocks[0].meta.includes("exec"), "parseCodeBlocks should have exec in meta")
    assertEqual(blocks[1].meta[1], "mode=store", "parseCodeBlocks mode")
    console.log("✓ parseCodeBlocks")

    // Test: parseLiterateMarkdown
    const markdown = `---
description: test
---
Step 1
---
Step 2`
    const steps = parseLiterateMarkdown(markdown)
    assertEqual(steps.length, 2, "parseLiterateMarkdown should find 2 steps")
    console.log("✓ parseLiterateMarkdown")

    // Test: parseExecMeta
    assertEqual(parseExecMeta(["exec"], "python").interpreter, "python3", "parseExecMeta default python")
    assertEqual(parseExecMeta(["exec"], "bash").interpreter, "bash", "parseExecMeta default bash")
    assertEqual(parseExecMeta(["exec=uv", "run", "python"], "python").interpreter, "uv", "parseExecMeta custom interpreter")
    assertEqual(parseExecMeta(["exec", "mode=store"], "python").mode, "store", "parseExecMeta mode")
    console.log("✓ parseExecMeta")

    // Test: getNestedValue
    const obj = { a: { b: { c: "deep" } }, arr: [1, 2, 3] }
    assertEqual(getNestedValue(obj, "a.b.c"), "deep", "getNestedValue deep")
    assertEqual(getNestedValue(obj, "arr.0"), 1, "getNestedValue array")
    assertEqual(getNestedValue(obj, "missing"), undefined, "getNestedValue missing")
    console.log("✓ getNestedValue")

    // Test: interpolate
    const meta = { name: "Alice", count: 5, nested: { val: "x" } }
    assertEqual(interpolate("Hello $name", meta), 'Hello "Alice"', "interpolate string")
    assertEqual(interpolate("Count: $count", meta), "Count: 5", "interpolate number")
    assertEqual(interpolate("Nested: $nested.val", meta), 'Nested: "x"', "interpolate nested")
    assert(interpolate("All: $$", meta).includes('"name":"Alice"'), "interpolate $$ includes metadata")
    assertEqual(interpolate("Raw $missing", meta), "Raw null", "interpolate missing")
    console.log("✓ interpolate")

    console.log("\n✅ All tests passed!")
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runTests()
}
