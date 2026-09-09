import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "./config.mjs";
import { startKimiAcpProxy } from "./kimi-acp-launch.mjs";

export function grokChildEnvironment(env = process.env) {
  const childEnv = { ...env, GROK_DISABLE_API_KEY_AUTH: "true" };
  delete childEnv.XAI_API_KEY;
  return childEnv;
}

export function resolveGrokBinary(env = process.env) {
  return resolveExecutable("grok", env.PATH || "");
}

// T3's native Grok driver authenticates ACP providers with its cached_token
// method. Grok already owns and refreshes its cached OIDC login, but rejects
// that driver-specific method before session/new. Reuse the local-auth ACP
// relay to acknowledge only authenticate; all other frames remain verbatim.
export function startGrokAcpProxy({
  grokBin,
  childArgs = ["agent", "stdio"],
  env = process.env,
  ...options
} = {}) {
  const binary = grokBin || resolveGrokBinary(env);
  return startKimiAcpProxy({
    ...options,
    kimiBin: binary,
    childArgs,
    configuredModel: null,
    errorLabel: "t3-native-grok-cached-auth",
    env: grokChildEnvironment(env),
  });
}

const SUPPORTED_CHILD_ARGS = new Set([
  "agent\u0000stdio",
  "agent\u0000--always-approve\u0000stdio",
  "--permission-mode\u0000default\u0000agent\u0000stdio",
  "--permission-mode\u0000acceptEdits\u0000agent\u0000stdio",
  "--permission-mode\u0000auto\u0000agent\u0000stdio",
]);

export function normalizeGrokChildArgs(args = []) {
  const normalized = args.length > 0 ? [...args] : ["agent", "stdio"];
  if (!SUPPORTED_CHILD_ARGS.has(normalized.join("\u0000"))) {
    throw new Error("unsupported Grok ACP launch arguments");
  }
  return normalized;
}

function isDirectExecution(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

export function main(argv = process.argv.slice(2)) {
  let binary;
  let childArgs;
  try {
    binary = resolveGrokBinary();
    childArgs = normalizeGrokChildArgs(argv);
  } catch (error) {
    console.error(`t3-native-grok-cached-auth: ${error.message}`);
    process.exit(1);
  }
  startGrokAcpProxy({ grokBin: binary, childArgs });
}

if (isDirectExecution(import.meta.url)) {
  main();
}
