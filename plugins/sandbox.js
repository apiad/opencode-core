// sandbox.js - Routes shell commands through Docker sandbox
// Hooks into tool.execute.before to intercept bash commands

import { existsSync } from "fs";
import { join } from "path";

export const SandboxPlugin = async ({ project, $ }) => {
  // Get the current mode from environment
  const mode = process.env.OPENCODE_MODE || "analyze";

  // Path to sandbox.sh
  const sandboxPath = join(project.root || ".", ".opencode", "sandbox", "sandbox.sh");

  // Commands that are safe to run on host (fast, no isolation needed)
  const hostSafePatterns = [
    /^ls(\s|$)/,
    /^grep(\s|$)/,
    /^find(\s|$)/,
    /^cat(\s|$)/,
    /^head(\s|$)/,
    /^tail(\s|$)/,
    /^pwd(\s|$)/,
    /^which(\s|$)/,
    /^cd(\s|$)/,
    /^echo(\s|$)/,
    /^printf(\s|$)/,
    /^wc(\s|$)/,
    /^sort(\s|$)/,
    /^uniq(\s|$)/,
    /^cut(\s|$)/,
    /^tr(\s|$)/,
    /^stat(\s|$)/,
    /^file(\s|$)/,
    /^git\s+(status|log|diff|show|branch|remote|stash|tag|describe)(\s|$)/,
  ];

  function shouldRunOnHost(command) {
    if (command.includes("|")) {
      return false;
    }

    return hostSafePatterns.some((pattern) => pattern.test(command));
  }

  return {
    "tool.execute.before": async (input, output) => {
      // Only intercept bash tool
      if (input.tool !== "bash") return;

      const command = output.args.command;
      if (!command) return;

      // Check if sandbox.sh exists
      if (!existsSync(sandboxPath)) {
        output.args.command = `echo 'sandbox.sh not found!'`;
        return;
      }

      // Decide where to run
      if (shouldRunOnHost(command)) {
        // Run on host - no modification needed
        return;
      }

      output.args.command = `OPENCODE_MODE=${mode} ${sandboxPath} ${mode} ${command}`;
    },
  };
};
