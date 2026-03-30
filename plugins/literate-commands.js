/**
 * Literate Commands Plugin
 *
 * Enables step-by-step command execution from markdown.
 */

import { readFileSync, existsSync } from "fs"
import { join } from "path"

const COMMANDS_DIR = ".opencode/commands"

// State per session
const sessionStates = new Map()

async function log(client, msg) {
    await client.app.log({
        body: {
            service: "literate-commands",
            level: "info",
            message: msg
        }
    })
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
    const prompt = remaining
        .replace(/```\w+\s*\{[^}]+\}\n[\s\S]*?```/g, "")
        .trim()

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

export default async function literateCommandsPlugin({ client }) {
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
            for (let i = 0; i < steps.length; i++) {
                await log(client, `[literate-commands] Step ${i}: ${steps[i].config.step}`)
            }

            // Set up state for this session
            sessionStates.set(sessionID, {
                steps,
                currentStep: 0,
                metadata: { ARGUMENTS: args || "" },
                sessionID,
                commandName: command
            })

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
            if (!state) return

            await log(client, `[literate-commands] session.idle for ${sessionID}, step ${state.currentStep}`)

            // Get current step
            const step = state.steps[state.currentStep]
            if (!step) {
                await log(client, `[literate-commands] No more steps, done`)
                sessionStates.delete(sessionID)
                return
            }

            // Interpolate variables in prompt
            const interpolatedPrompt = interpolate(step.prompt, state.metadata)
            await log(client, `[literate-commands] Injecting step ${state.currentStep}: ${interpolatedPrompt}`)

            // Inject step prompt
            await client.session.promptAsync({
                path: { id: sessionID },
                body: {
                    parts: [{ type: "text", text: interpolatedPrompt }]
                }
            })

            // Advance to next step
            state.currentStep++
        }
    }
}
