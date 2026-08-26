import path from "node:path";
import { pathToFileURL } from "node:url";
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
  env = process.env,
  ...options
} = {}) {
  const binary = grokBin || resolveGrokBinary(env);
  return startKimiAcpProxy({
    ...options,
    kimiBin: binary,
    childArgs: ["agent", "stdio"],
    errorLabel: "t3-native-grok-cached-auth",
    env: grokChildEnvironment(env),
  });
}

export function main() {
  let binary;
  try {
    binary = resolveGrokBinary();
  } catch (error) {
    console.error(`t3-native-grok-cached-auth: ${error.message}`);
    process.exit(1);
  }
  startGrokAcpProxy({ grokBin: binary });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
