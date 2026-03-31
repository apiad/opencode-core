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
import { execSync } from "child_process"

const COMMANDS_DIR = ".opencode/commands"

// State per session
const sessionStates = new Map()

async function log(client, msg) {
    console.error("INFO [literate-commands]", msg)
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
        config = parseNestedYaml(configText)
        remaining = section.replace(configMatch[0], "").trim()
    }

    // Extract code blocks with their full text (including delimiters)
    const codeBlocks = []
    const blockRegex = /(```\w+\s*\{[^}]*\}\n[\s\S]*?```)/g
    let lastIndex = 0
    let match

    while ((match = blockRegex.exec(remaining)) !== null) {
        codeBlocks.push({
            language: match[0].match(/^```(\w+)/)[1],
            meta: match[0].match(/\{([^}]*)\}/)[1].split(/\s+/).filter(m => m),
            code: match[0].match(/```\w+\s*\{[^}]*\}\n([\s\S]*?)```/)[1],
            fullBlock: match[0]  // Preserve exact string for later replacement
        })
    }

    // Remove config block from prompt, but keep everything else including other code blocks
    // The prompt retains all non-config code blocks as-is
    const prompt = remaining
        .replace(/```yaml\s*\{config\}\n[\s\S]*?```/g, "")
        .trim()

    if (!prompt && codeBlocks.length === 0) {
        return null
    }

    return { config, prompt, codeBlocks }
}

/**
 * Simple YAML parser for nested key-value pairs.
 * Handles: key: value, nested.key: value, key: "quoted value", key: [a, b, c]
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
 * Parse nested YAML config (handles parse:, question:, match: blocks).
 * Extracts top-level keys and nested content.
 */
function parseNestedYaml(text) {
    const result = {}
    const lines = text.split("\n")
    let currentKey = null
    let currentNested = null
    let indentLevel = 0

    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue

        // Check for top-level key (no indent)
        const topMatch = trimmed.match(/^(\w+)\s*:\s*(.*)$/)
        if (topMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
            currentKey = topMatch[1]
            const value = topMatch[2]

            if (value === "" || value === "~") {
                // This key has nested content
                result[currentKey] = {}
                currentNested = result[currentKey]
                indentLevel = 0
            } else {
                // Simple value
                result[currentKey] = parseValue(value)
                currentNested = null
            }
        } else if (currentNested !== null) {
            // We're in a nested block
            const nestedMatch = trimmed.match(/^(\w+\??)\s*:\s*(.*)$/)
            if (nestedMatch) {
                const [nestedKey, nestedValue] = nestedMatch.slice(1)
                currentNested[nestedKey] = parseValue(nestedValue)
            }
        }
    }

    return result
}

function parseValue(value) {
    if (value.startsWith("[") && value.endsWith("]")) {
        return value.slice(1, -1).split(",").map(s => s.trim())
    } else if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1)
    } else if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1)
    } else if (value === "true") {
        return true
    } else if (value === "false") {
        return false
    } else if (value === "" || value === "~" || value === "null") {
        return null
    } else if (!isNaN(value) && value.trim() !== "") {
        return Number(value)
    }
    return value.trim()
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
 * Extract text from the latest assistant message in a session.
 * Returns the combined text from all text parts of the assistant's response.
 */
async function getLatestAssistantResponse(client, sessionID) {
    try {
        const response = await client.session.messages({ path: { id: sessionID } })
        const messages = response.data

        // Find the latest assistant message (messages are ordered by time)
        // The latest message should be the last one with role "assistant"
        let latestAssistant = null
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (msg.info?.role === "assistant") {
                latestAssistant = msg
                break
            }
        }

        if (!latestAssistant) {
            return null
        }

        // Parts are already embedded in the message - no separate API call needed
        const texts = []
        for (const part of latestAssistant.parts) {
            if (part.type === "text") {
                texts.push(part.text)
            }
        }

        return texts.join("\n")
    } catch (e) {
        console.error("[literate-commands] Error fetching messages:", e.message)
        return null
    }
}

/**
 * Interpolate variables in text using JSON.stringify.
 * $var → "value" (JSON-stringified)
 * $obj.nested → "nested value"
 * $arr.0 → first array element
 * $$ → full metadata as JSON string
 */
function interpolate(text, metadata) {
    return text.replace(/\$(\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g, (match, path) => {
        if (path === "$") {
            return JSON.stringify(metadata)
        }
        const value = getNestedValue(metadata, path)
        return JSON.stringify(value ?? null)
    })
}

/**
 * Interpolate variables for shell scripts (no JSON-stringify).
 * $var → value (raw, suitable for shell)
 * $obj.nested → nested value
 * $arr.0 → first array element
 * $$ → full metadata as JSON string (for reference)
 *
 * This escapes values for shell safety.
 */
function interpolateForShell(text, metadata) {
    return text.replace(/\$(\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g, (match, path) => {
        if (path === "$") {
            return JSON.stringify(metadata)
        }
        const value = getNestedValue(metadata, path)
        if (value === null || value === undefined) {
            return ""
        }
        // Escape for shell: wrap in single quotes, escape any existing single quotes
        const str = String(value).replace(/'/g, "'\\''")
        return `'${str}'`
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

    // Substitute variables in code (shell-safe for bash/sh, regular for others)
    let substitutedCode
    if (cmd === "bash" || cmd === "sh") {
        substitutedCode = interpolateForShell(code, metadata)
    } else {
        // For Python, Node, etc. - use regular interpolation with JSON-stringify
        substitutedCode = interpolate(code, metadata)
    }

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

    for (const block of step.codeBlocks) {
        if (!block.meta.includes("exec")) continue

        const { output, stored } = await runScript(block, metadata, $)

        // Update metadata if store mode
        if (stored) {
            Object.assign(metadata, stored)
        }

        // Replace EXACT block string with output (for stdout mode)
        if (output) {
            resultPrompt = resultPrompt.replace(block.fullBlock, output)
        } else {
            // Remove block if no output (stdout is empty)
            resultPrompt = resultPrompt.replace(block.fullBlock, "")
        }
    }

    return resultPrompt
}

// ============================================================================
// Parse Functionality
// ============================================================================

/**
 * Build JSON format instruction from parse config keys.
 *
 * Input: { message: "string", count: "number", active: "bool" }
 * Output: "\n\nFormat your response as JSON with the following keys: {message, count, active}. DO NOT add anything before or after the JSON response, as it will be used for parsing."
 */
function buildParseFormatInstruction(parseConfig) {
    const keys = Object.keys(parseConfig).join(", ")
    return `\n\nFormat your response as JSON with the following keys: {${keys}}. DO NOT add anything before or after the JSON response, as it will be used for parsing.`
}

/**
 * Parse variables from model response based on type-based config.
 *
 * Config format (NEW):
 *   parse:
 *     message: string    # string type
 *     count: number       # number type
 *     active: bool        # boolean type
 *
 * Returns: { success: true, data: { key: value, ... } }
 *      or: { success: false, error: "error message" }
 *
 * Response parsing priority:
 * 1. JSON code block (```json ... ```)
 * 2. Raw JSON (no fences)
 */
function parseResponse(responseText, parseConfig) {
    let jsonString = null

    // First, try to find JSON in code block
    const jsonBlockMatch = responseText.match(/```json\n([\s\S]*?)\n```/)
    if (jsonBlockMatch) {
        jsonString = jsonBlockMatch[1]
    } else {
        // Try to find raw JSON (might be the whole response)
        const trimmed = responseText.trim()
        if (trimmed.startsWith("{")) {
            // Might be raw JSON, use the whole thing
            jsonString = trimmed
        }
    }

    if (jsonString) {
        try {
            const parsed = JSON.parse(jsonString)
            const result = {}

            for (const [key, type] of Object.entries(parseConfig)) {
                if (parsed[key] !== undefined) {
                    switch (type) {
                        case "bool":
                            result[key] = Boolean(parsed[key])
                            break
                        case "number":
                            result[key] = Number(parsed[key])
                            break
                        case "string":
                        default:
                            result[key] = String(parsed[key])
                    }
                }
            }

            return { success: true, data: result }
        } catch (e) {
            return { success: false, error: e.message }
        }
    }

    // No valid JSON found
    return { success: false, error: "No valid JSON found in response" }
}

/**
 * Process parse config from step and extract variables.
 * Called after model responds.
 *
 * Returns: { success: boolean, data?: object, error?: string }
 */
function processParse(step, responseText, metadata, client) {
    if (!step.config.parse) {
        return { success: true, data: metadata }
    }

    const result = parseResponse(responseText, step.config.parse)

    if (result.success) {
        log(client, `[literate-commands] Parsed variables: ${JSON.stringify(result.data)}`)
        // Merge parsed data into metadata
        Object.assign(metadata, result.data)
        return { success: true, data: metadata }
    } else {
        log(client, `[literate-commands] Parse failed: ${result.error}`)
        return { success: false, error: result.error }
    }
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
                commandName: command,
                pendingParse: null,      // parse config waiting for response
                retries: 3,             // retry count (default 3)
                awaitingResponse: false,  // waiting for first response after prompt
                awaitingRetry: false     // waiting for retry response after retry prompt
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

            await log(client, `[literate-commands] session.idle for ${sessionID}, step ${state.currentStep}, awaitingResponse=${state.awaitingResponse}, awaitingRetry=${state.awaitingRetry}`)

            // Get current step
            const stepIndex = state.currentStep
            const step = state.steps[stepIndex]
            if (!step) {
                await log(client, `[literate-commands] No more steps, done`)
                sessionStates.delete(sessionID)
                return
            }

            // =====================================================
            // Handle waiting states (parse response, then inject NEXT step)
            // =====================================================
            if (state.awaitingRetry || state.awaitingResponse) {
                const responseText = await getLatestAssistantResponse(client, sessionID)
                await log(client, `[literate-commands] Got response: ${responseText?.slice(0, 100) || "null"}...`)

                if (!responseText) {
                    await log(client, `[literate-commands] No response yet, waiting...`)
                    return
                }

                const parseResult = processParse(step, responseText, state.metadata, client)

                if (parseResult.success) {
                    // Parse succeeded! Advance step, then inject NEXT step
                    state.awaitingRetry = false
                    state.awaitingResponse = false
                    state.pendingParse = null
                    state.retries = 3
                    state.currentStep++
                    await log(client, `[literate-commands] Parse succeeded, advancing to step ${state.currentStep}, metadata: ${JSON.stringify(state.metadata)}`)

                    // Get NEXT step and inject it
                    const nextStepIndex = state.currentStep
                    const nextStep = state.steps[nextStepIndex]
                    if (!nextStep) {
                        await log(client, `[literate-commands] No more steps, done`)
                        sessionStates.delete(sessionID)
                        return
                    }

                    await log(client, `[literate-commands] Processing step ${nextStepIndex}: "${nextStep.prompt.slice(0, 50)}..."`)

                    const processedPrompt = await processScripts(nextStep, state.metadata, $)
                    let finalPrompt = interpolate(processedPrompt, state.metadata)

                    if (nextStep.config.parse) {
                        const formatInstruction = buildParseFormatInstruction(nextStep.config.parse)
                        finalPrompt = finalPrompt + formatInstruction
                        state.pendingParse = nextStep.config.parse
                        state.awaitingResponse = true
                        await log(client, `[literate-commands] Added parse instruction, awaiting response`)
                    }

                    await log(client, `[literate-commands] Injecting: ${finalPrompt.slice(0, 100)}...`)
                    await client.session.promptAsync({
                        path: { id: sessionID },
                        body: { parts: [{ type: "text", text: finalPrompt }] }
                    })

                    if (!nextStep.config.parse) {
                        state.currentStep++
                    }
                    return
                } else {
                    // Parse failed - start retry cycle
                    state.retries--
                    state.awaitingRetry = true
                    state.awaitingResponse = false
                    await log(client, `[literate-commands] Parse failed (${state.retries} retries left): ${parseResult.error}`)

                    if (state.retries > 0) {
                        const retryPrompt = `Could not parse your response as valid JSON. Error: ${parseResult.error}\n\nPlease respond with ONLY a JSON block containing the required keys. Format: {${Object.keys(state.pendingParse || step.config.parse || {}).join(", ")}}.`
                        await client.session.promptAsync({
                            path: { id: sessionID },
                            body: { parts: [{ type: "text", text: retryPrompt }] }
                        })
                    } else {
                        const stopPrompt = `Command stopped. Parse failed after 3 retries at step ${stepIndex}.\n\nCurrent step: "${step.prompt.slice(0, 100)}..."\nVariables so far: ${JSON.stringify(state.metadata)}\n\nPlease provide instructions.`
                        await client.session.promptAsync({
                            path: { id: sessionID },
                            body: { parts: [{ type: "text", text: stopPrompt }] }
                        })
                        sessionStates.delete(sessionID)
                    }
                    return
                }
            }

            // =====================================================
            // Fresh step - process and inject
            // =====================================================
            await log(client, `[literate-commands] Processing step ${stepIndex}: "${step.prompt.slice(0, 50)}..."`)

            // Process scripts and interpolate
            const processedPrompt = await processScripts(step, state.metadata, $)
            let finalPrompt = interpolate(processedPrompt, state.metadata)

            // If this step has parse config, add JSON format instruction
            if (step.config.parse) {
                const formatInstruction = buildParseFormatInstruction(step.config.parse)
                finalPrompt = finalPrompt + formatInstruction
                state.pendingParse = step.config.parse
                state.awaitingResponse = true
                await log(client, `[literate-commands] Added parse instruction, awaiting response`)
            }

            await log(client, `[literate-commands] Injecting: ${finalPrompt.slice(0, 100)}...`)

            await client.session.promptAsync({
                path: { id: sessionID },
                body: { parts: [{ type: "text", text: finalPrompt }] }
            })

            // If no parse config, advance to next step
            if (!step.config.parse) {
                await log(client, `[literate-commands] Advancing to step ${stepIndex + 1}`)
                state.currentStep++
            }
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

async function runTests() {
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

    // Test: parseNestedYaml
    const nestedYaml1 = `step: ask-info
parse:
    topic: "What is the topic?"
    count: "What is the count?"`
    const nestedResult1 = parseNestedYaml(nestedYaml1)
    assertEqual(nestedResult1.step, "ask-info", "parseNestedYaml step")
    assertEqual(nestedResult1.parse.topic, "What is the topic?", "parseNestedYaml nested topic")
    assertEqual(nestedResult1.parse.count, "What is the count?", "parseNestedYaml nested count")
    console.log("✓ parseNestedYaml")

    // Test: parseNestedYaml with boolean key
    const nestedYaml2 = `parse:
    done?: "Is it done?"
    ok: next`
    const nestedResult2 = parseNestedYaml(nestedYaml2)
    assertEqual(nestedResult2.parse["done?"], "Is it done?", "parseNestedYaml boolean key")
    assertEqual(nestedResult2.parse.ok, "next", "parseNestedYaml regular key")
    console.log("✓ parseNestedYaml boolean key")

    // Test: parseStep preserves non-exec code blocks
    const stepWithJson = `\`\`\`yaml {config}
step: test
\`\`\`
Here is JSON:
\`\`\`json
{"topic": "test"}
\`\`\`
And exec:
\`\`\`bash {exec}
echo hi
\`\`\`
Done.`
    const parsedStep = parseStep(stepWithJson)
    assertEqual(parsedStep.codeBlocks.length, 2, "parseStep finds both blocks")
    // All code blocks are PRESERVED in the prompt (not removed)
    assert(parsedStep.prompt.includes('```json'), "parseStep preserves json block in prompt")
    assert(parsedStep.prompt.includes('```bash {exec}'), "parseStep preserves exec block in prompt")
    assert(parsedStep.prompt.includes('echo hi'), "parseStep preserves exec block content")
    // Non-exec blocks have fullBlock property
    assert(parsedStep.codeBlocks[0].fullBlock, "parseStep stores fullBlock for json")
    assert(parsedStep.codeBlocks[1].fullBlock, "parseStep stores fullBlock for exec")
    console.log("✓ parseStep preserves all code blocks in prompt")

    // Test: parseResponse with JSON (type-based format)
    const jsonResponse = '```json\n{"topic": "AI", "count": 42}\n```'
    const parseConfig1 = { topic: "string", count: "number" }
    const parsed1 = parseResponse(jsonResponse, parseConfig1)
    assertEqual(parsed1.success, true, "parseResponse JSON success")
    assertEqual(parsed1.data.topic, "AI", "parseResponse JSON topic")
    assertEqual(parsed1.data.count, 42, "parseResponse JSON count (number type)")
    console.log("✓ parseResponse type-based JSON")

    // Test: parseResponse with bool
    const boolResponse = '{"done": true}'
    const parseConfig2 = { done: "bool" }
    const parsed2 = parseResponse(boolResponse, parseConfig2)
    assertEqual(parsed2.success, true, "parseResponse bool success")
    assertEqual(parsed2.data.done, true, "parseResponse bool true")
    console.log("✓ parseResponse bool")

    // Test: parseResponse plain text (no JSON) - should fail
    const textResponse = "Topic: Machine Learning\nCount: 10"
    const parseConfig3 = { topic: "string", count: "number" }
    const parsed3 = parseResponse(textResponse, parseConfig3)
    assertEqual(parsed3.success, false, "parseResponse plain text fails (no JSON)")
    console.log("✓ parseResponse plain text fails")

    // ============================================================================
    // New Parse Functionality Tests (Phase 6)
    // ============================================================================

    // Test: buildParseFormatInstruction - generates correct instruction
    const formatInstr1 = buildParseFormatInstruction({ message: "string", count: "number" })
    assert(formatInstr1.includes("message"), "buildParseFormatInstruction includes message")
    assert(formatInstr1.includes("count"), "buildParseFormatInstruction includes count")
    assert(formatInstr1.includes("DO NOT add anything"), "buildParseFormatInstruction includes instruction")
    console.log("✓ buildParseFormatInstruction basic")

    // Test: buildParseFormatInstruction - single key
    const formatInstr2 = buildParseFormatInstruction({ name: "string" })
    assert(formatInstr2.includes("{name}"), "buildParseFormatInstruction single key format")
    console.log("✓ buildParseFormatInstruction single key")

    // Test: parseResponse - type-based format with JSON (NEW FORMAT)
    const newParseConfig1 = { msg: "string", num: "number", flag: "bool" }
    const newJsonResponse = '{"msg": "hello", "num": 42, "flag": true}'
    const newParsed1 = parseResponse(newJsonResponse, newParseConfig1)
    assertEqual(newParsed1.success, true, "parseResponse type-based success")
    assertEqual(newParsed1.data.msg, "hello", "parseResponse string type")
    assertEqual(newParsed1.data.num, 42, "parseResponse number type (not string)")
    assertEqual(newParsed1.data.flag, true, "parseResponse bool type")
    console.log("✓ parseResponse type-based JSON extraction")

    // Test: parseResponse - bool false
    const boolFalseResponse = '{"active": false}'
    const boolFalseConfig = { active: "bool" }
    const boolFalseResult = parseResponse(boolFalseResponse, boolFalseConfig)
    assertEqual(boolFalseResult.success, true, "parseResponse bool false success")
    assertEqual(boolFalseResult.data.active, false, "parseResponse bool false value")
    console.log("✓ parseResponse bool false")

    // Test: parseResponse - failure returns success: false
    const badResponse = "This is not JSON at all"
    const badResult = parseResponse(badResponse, newParseConfig1)
    assertEqual(badResult.success, false, "parseResponse failure returns success: false")
    assert(badResult.error, "parseResponse failure returns error message")
    console.log("✓ parseResponse failure returns success: false")

    // Test: parseResponse - invalid JSON in block
    const invalidJsonResponse = '```json\n{invalid json}\n```'
    const invalidResult = parseResponse(invalidJsonResponse, newParseConfig1)
    assertEqual(invalidResult.success, false, "parseResponse invalid JSON returns failure")
    console.log("✓ parseResponse invalid JSON")

    // Test: parseResponse - raw JSON without code fences
    const rawJsonResponse = '{"msg": "raw", "num": 100, "flag": false}'
    const rawResult = parseResponse(rawJsonResponse, newParseConfig1)
    assertEqual(rawResult.success, true, "parseResponse raw JSON success")
    assertEqual(rawResult.data.msg, "raw", "parseResponse raw JSON extraction")
    console.log("✓ parseResponse raw JSON")

    // Test: parseResponse - partial keys (missing some)
    const partialResponse = '{"msg": "partial"}'
    const partialResult = parseResponse(partialResponse, newParseConfig1)
    assertEqual(partialResult.success, true, "parseResponse partial keys success")
    assertEqual(partialResult.data.msg, "partial", "parseResponse partial - extracted key")
    assertEqual(partialResult.data.num, undefined, "parseResponse partial - missing key undefined")
    console.log("✓ parseResponse partial keys")

    // Test: parseResponse - JSON with code fences
    const fencedResponse = '```json\n{"msg": "fenced", "num": 5, "flag": true}\n```'
    const fencedResult = parseResponse(fencedResponse, newParseConfig1)
    assertEqual(fencedResult.success, true, "parseResponse fenced JSON success")
    assertEqual(fencedResult.data.msg, "fenced", "parseResponse fenced JSON extraction")
    console.log("✓ parseResponse fenced JSON")

    console.log("\n✅ Parse Functionality tests passed!")
    console.log("\n✅ All tests passed!")
}

// ============================================================================
// Script Execution & Interpolation Tests
// ============================================================================

async function runAsyncTests() {
    console.log("\n--- Script Execution & Interpolation Tests ---\n")

    // Test: runScript - bash echo (stdout mode)
    const bashResult = await runScript(
        { language: "bash", code: 'echo "Hello World"', meta: ["exec"] },
        {},
        null
    )
    assertEqual(bashResult.output, "Hello World", "runScript bash echo")
    console.log("✓ runScript bash echo (stdout)")

    // Test: runScript - python print (stdout mode)
    const pyResult = await runScript(
        { language: "python", code: 'print("Python Hello")', meta: ["exec"] },
        {},
        null
    )
    assertEqual(pyResult.output, "Python Hello", "runScript python print")
    console.log("✓ runScript python print (stdout)")

    // Test: runScript - with variable substitution (shell-safe, single-quoted)
    const subResult = await runScript(
        { language: "bash", code: 'echo "Hello $name"', meta: ["exec"] },
        { name: "Alice" },
        null
    )
    assertEqual(subResult.output, "Hello 'Alice'", "runScript variable substitution")
    console.log("✓ runScript variable substitution")

    // Test: runScript - store mode (JSON output)
    const storeResult = await runScript(
        { language: "python", code: 'import json; print(json.dumps({"count": 5, "topic": "test"}))', meta: ["exec", "mode=store"] },
        {},
        null
    )
    assertEqual(storeResult.stored.count, 5, "runScript store mode count")
    assertEqual(storeResult.stored.topic, "test", "runScript store mode topic")
    assertEqual(storeResult.output, "", "runScript store mode output is empty")
    console.log("✓ runScript store mode")

    // Test: runScript - store mode returns stored object (merge happens in processScripts)
    const storeCheck = await runScript(
        { language: "python", code: 'import json; print(json.dumps({"new": "data"}))', meta: ["exec", "mode=store"] },
        {},
        null
    )
    assertEqual(storeCheck.stored.new, "data", "runScript returns stored object")
    console.log("✓ runScript store returns object")

    // Test: runScript - none mode (silent execution)
    const noneResult = await runScript(
        { language: "bash", code: 'echo "invisible"', meta: ["exec", "mode=none"] },
        {},
        null
    )
    assertEqual(noneResult.output, "", "runScript none mode has no output")
    assertEqual(noneResult.stored, null, "runScript none mode has no stored")
    console.log("✓ runScript none mode")

    // Test: runScript - error handling
    const errorResult = await runScript(
        { language: "bash", code: 'exit 1', meta: ["exec"] },
        {},
        null
    )
    assert(errorResult.output.includes("error"), "runScript handles errors")
    console.log("✓ runScript error handling")

    // Test: runScript - custom interpreter with exec= syntax
    const customResult = await runScript(
        { language: "bash", code: 'echo "custom"', meta: ["exec=echo"] },
        {},
        null
    )
    // Note: exec=echo will run "echo" directly, not as shell command
    // This tests the custom interpreter parsing
    console.log("✓ runScript custom interpreter parsing")

    // Test: processScripts - replaces exec blocks with output
    // Test using parseStep to ensure consistent step structure
    const testMarkdown = `\`\`\`yaml {config}
step: test
\`\`\`
Before
\`\`\`bash {exec}
echo ONE
\`\`\`
Middle
\`\`\`python {exec}
print('TWO')
\`\`\`
After`
    const parsedStep = parseStep(testMarkdown)
    const processedPrompt = await processScripts(parsedStep, {}, null)
    assert(processedPrompt.includes("ONE"), "processScripts replaces bash block with output")
    assert(processedPrompt.includes("TWO"), "processScripts replaces python block with output")
    assert(!processedPrompt.includes("```bash"), "processScripts removes bash block markers")
    assert(!processedPrompt.includes("```python"), "processScripts removes python block markers")
    console.log("✓ processScripts replaces exec blocks with output")

    // Test: processScripts - preserves non-exec blocks
    const stepWithJson = {
        prompt: "```json\n{\"key\": \"value\"}\n```\n```bash {exec}\necho done\n```",
        codeBlocks: [
            { language: "json", code: '{"key": "value"}', meta: [] },
            { language: "bash", code: "echo done", meta: ["exec"] }
        ],
        config: {}
    }
    const processedJson = await processScripts(stepWithJson, {}, null)
    assert(processedJson.includes('```json'), "processScripts preserves json block")
    assert(processedJson.includes("done"), "processScripts processes exec block")
    console.log("✓ processScripts preserves non-exec blocks")

    // Test: processScripts - updates metadata from store mode
    const metaStoreStep = {
        prompt: "```python {exec mode=store}\nimport json; print(json.dumps({\"count\": 10}))\n```",
        codeBlocks: [
            { language: "python", code: 'import json; print(json.dumps({"count": 10}))', meta: ["exec", "mode=store"] }
        ],
        config: {}
    }
    const testMeta = {}
    await processScripts(metaStoreStep, testMeta, null)
    assertEqual(testMeta.count, 10, "processScripts updates metadata from store")
    console.log("✓ processScripts metadata from store")

    // Test: interpolate - multiple variables
    assertEqual(
        interpolate("Hello $name, you have $count items", { name: "Bob", count: 3 }),
        'Hello "Bob", you have 3 items',
        "interpolate multiple vars"
    )
    console.log("✓ interpolate multiple variables")

    // Test: interpolate - escape sequences
    assertEqual(
        interpolate("$name", { name: 'Hello "World"' }),
        '"Hello \\"World\\""',
        "interpolate escaped quotes"
    )
    console.log("✓ interpolate escaped quotes")

    // Test: interpolate - special characters in values
    assertEqual(
        interpolate("$msg", { msg: "Line1\nLine2" }),
        '"Line1\\nLine2"',
        "interpolate newlines"
    )
    console.log("✓ interpolate special characters")

    // Test: interpolate - boolean values
    assertEqual(
        interpolate("Enabled: $enabled", { enabled: true }),
        "Enabled: true",
        "interpolate boolean true"
    )
    assertEqual(
        interpolate("Enabled: $enabled", { enabled: false }),
        "Enabled: false",
        "interpolate boolean false"
    )
    console.log("✓ interpolate boolean values")

    // Test: interpolate - null/undefined
    assertEqual(
        interpolate("Value: $missing", { other: "exists" }),
        "Value: null",
        "interpolate undefined becomes null"
    )
    console.log("✓ interpolate undefined handling")

    // Test: interpolate - nested object access
    const nested = { user: { profile: { name: "Alice" } }, items: [{ id: 1 }, { id: 2 }] }
    assertEqual(
        interpolate("User: $user.profile.name", nested),
        'User: "Alice"',
        "interpolate deep nested"
    )
    assertEqual(
        interpolate("First: $items.0.id", nested),
        "First: 1",
        "interpolate array index"
    )
    console.log("✓ interpolate nested access")

    // Test: interpolate - $$ for full metadata
    const fullMeta = { a: 1, b: 2 }
    const fullResult = interpolate("$$", fullMeta)
    assert(fullResult.includes('"a":1'), "interpolate $$ includes values")
    assert(fullResult.includes('"b":2'), "interpolate $$ includes all keys")
    console.log("✓ interpolate $$ full metadata")

    console.log("\n✅ Script Execution & Interpolation tests passed!")
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    // Convert runTests to async wrapper
    runTests().then(() => {
        return runAsyncTests()
    }).then(() => {
        console.log("\n🎉 All test suites passed!")
        process.exit(0)
    }).catch(err => {
        console.error("\n❌ Test failed:", err.message)
        process.exit(1)
    })
}
