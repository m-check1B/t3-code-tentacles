#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3Client } from "./t3-client.mjs";
import {
  ALLOW_ALL_MENTION_POLICY,
  doctor,
  formatDoctor,
  installDeepSeekProvider,
  installKimiProvider,
  installProvider,
  installPiProvider,
  originate,
  removeDeepSeekProvider,
  removeKimiProvider,
  removeProvider,
  removePiProvider,
  restoreNativeGrok,
  routeMentionsOnce,
  useNativeGrokCachedAuth,
} from "./bridge.mjs";
import {
  DEFAULT_DEEPSEEK_INSTANCE_ID,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_HERMES_PROFILE,
  DEFAULT_INSTANCE_ID,
  DEFAULT_KIMI_INSTANCE_ID,
  DEFAULT_KIMI_MODEL,
  DEFAULT_MODEL,
  DEFAULT_PI_INSTANCE_ID,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_PROVIDER,
  resolveExecutable,
} from "./config.mjs";
import { requireRequestedProviderConstructable } from "./hermes-acp-launch.mjs";
import {
  defaultModelForLab,
  ORIGINATE_LABS,
  parseModelOptionFlags,
  requireAdvertisedLab,
  requireExplicitRuntimeMode,
  resolveModelSelection,
  RUNTIME_MODES,
} from "./model-selection.mjs";
import { applyIntents, observe } from "./orchestrate.mjs";
import { LoopbackRuntimeAdapter, OutboundPairer } from "./outbound-pairer.mjs";
import { DEFAULT_PAIR_STATE_FILE } from "./pair-state.mjs";
import {
  installService,
  restartService,
  serviceIdentity,
  serviceStatus,
  uninstallService,
} from "./service.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const RESERVED_REMOVED_INSTANCE_IDS = new Set(["claude-openrouter"]);
const PROVIDER_INSTANCE_COMMANDS = new Set([
  "install-provider", "remove-provider", "install-pi-provider", "remove-pi-provider",
  "install-deepseek-provider", "remove-deepseek-provider", "install-kimi-provider", "remove-kimi-provider",
]);
const KNOWN_COMMANDS = new Set([
  "doctor", "pair", "install-provider", "remove-provider", "install-pi-provider", "remove-pi-provider",
  "install-deepseek-provider", "remove-deepseek-provider", "install-kimi-provider", "remove-kimi-provider",
  "restore-native-grok", "use-native-grok-cached-auth", "observe", "act", "orchestrate", "originate", "watch",
  "install-service", "service-status", "restart-service", "uninstall-service",
]);

function assertNoReservedRemovedInstance(command, instanceId) {
  if (PROVIDER_INSTANCE_COMMANDS.has(command) && RESERVED_REMOVED_INSTANCE_IDS.has(instanceId)) {
    throw new Error(`Provider instance '${instanceId}' is reserved legacy state and cannot be installed, repurposed, or removed by Tentacles`);
  }
}

const ORIGINATE_OPTION_KEYS = new Set([
  "workspace",
  "title",
  "message",
  "runtime-mode",
  "idempotency-key",
  "instance",
  "model",
  "budget",
  "option",
  "state-file",
]);

export function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      options._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (command === "originate" && !ORIGINATE_OPTION_KEYS.has(key)) {
      throw new Error(`Unknown originate option --${key}; run tentacles help for supported options`);
    }
    if (key === "once" || key === "allow-all-projects" || key === "no-wait" || key === "json") {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    if (key === "option") {
      if (!Array.isArray(options.option)) options.option = [];
      options.option.push(value);
    } else {
      options[key] = value;
    }
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

export function parseIntentOption(options) {
  const hasIntent = options.intent !== undefined;
  const hasIntentFile = options["intent-file"] !== undefined;
  if (hasIntent && hasIntentFile) {
    throw new Error("act accepts --intent or --intent-file, not both; pass exactly one");
  }
  const raw = hasIntent ? options.intent : hasIntentFile ? readIntentFile(options["intent-file"]) : null;
  if (raw === null) throw new Error("act requires --intent '{...}' or --intent-file PATH");
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`Intent is not valid JSON: ${error.message}`); }
}

function parseIntentFileOption(options) {
  const file = required(options, "intent-file");
  const raw = readIntentFile(file);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`Intent file is not valid JSON: ${error.message}`); }
  const intents = Array.isArray(parsed) ? parsed : parsed.intents;
  if (!Array.isArray(intents)) throw new Error("Intent file must contain an array of intents or an object with an intents array");
  return intents;
}

function readIntentFile(file) {
  const destination = path.resolve(file);
  const stat = fs.statSync(destination);
  if (!stat.isFile()) throw new Error(`Intent file is not a regular file: ${destination}`);
  if (stat.size > 4 * 1024 * 1024) throw new Error(`Intent file exceeds the 4 MiB bound: ${destination}`);
  return fs.readFileSync(destination, "utf8");
}

function resolvePiExecutable() {
  const configured = process.env.PI_BIN;
  if (!configured) return resolveExecutable("pi");
  if (!path.isAbsolute(configured)) throw new Error("PI_BIN must be an absolute executable path when installing the Pi provider");
  fs.accessSync(configured, fs.constants.X_OK);
  return fs.realpathSync(configured);
}

function resolveDshAcpExecutable(option) {
  const configured = option || process.env.DSH_ACP_BIN;
  if (!configured) return undefined;
  if (!path.isAbsolute(configured)) throw new Error("DSH_ACP_BIN must be an absolute executable path when installing the DeepSeek provider");
  fs.accessSync(configured, fs.constants.X_OK);
  return fs.realpathSync(configured);
}

function resolveKimiExecutable(option) {
  const configured = option || process.env.KIMI_BIN;
  if (!configured) return resolveExecutable("kimi");
  if (!path.isAbsolute(configured)) throw new Error("KIMI_BIN must be an absolute executable path when installing the Kimi provider");
  fs.accessSync(configured, fs.constants.X_OK);
  return fs.realpathSync(configured);
}

export function usage() {
  return `Tentacles — chair CLI and additive ACP adapters for T3 Code.
Hermes was the first tentacle. The public command is tentacles; t3-agent-bridge is an exact alias.

Usage:
  tentacles --version | -V
  tentacles doctor [--json]
  tentacles pair --pair-file OWNER_ONLY_JSON --machine-id SPHERE_MACHINE_ID [--pair-state-file PATH]
  tentacles install-provider [--instance hermes] [--profile default] [--model MODEL]
  tentacles remove-provider [--instance hermes]
  tentacles install-pi-provider [--instance pi] [--model gpt-5.6-terra] [--pi-provider openai-codex]
  tentacles remove-pi-provider [--instance pi]
  tentacles install-deepseek-provider [--instance deepseek] [--model deepseek/deepseek-v4-flash] [--dsh-acp-bin PATH]
  tentacles remove-deepseek-provider [--instance deepseek]
  tentacles install-kimi-provider [--instance kimi] [--model moonshotai/kimi-k3] [--kimi-bin PATH]
  tentacles remove-kimi-provider [--instance kimi]
  tentacles restore-native-grok
  tentacles use-native-grok-cached-auth
  tentacles observe
  tentacles act --intent '{...}' [--intent-file PATH] [--no-wait]
  tentacles orchestrate --intent-file PATH [--no-wait]
  tentacles originate --workspace PATH --title TITLE --message TEXT --runtime-mode ${RUNTIME_MODES.join("|")} [--idempotency-key KEY] [--instance ${ORIGINATE_LABS.join("|")}] [--model MODEL] [--budget low|medium|high] [--option id=value]
  tentacles watch --once --allow-all-projects [--profile PROFILE] [--instance INSTANCE]
  tentacles watch --allow-all-projects [--interval 2000] [--state-file PATH] [--max-messages 10]
  tentacles install-service --profile PROFILE --instance INSTANCE [service options]
  tentacles service-status --profile PROFILE --instance INSTANCE
  tentacles restart-service --profile PROFILE --instance INSTANCE
  tentacles uninstall-service --profile PROFILE --instance INSTANCE

The tentacles command is the public CLI. t3-agent-bridge is an exact alias.
The legacy t3-hermes command remains an exact compatibility alias.
Run doctor to print the advertised lab matrix for this machine
(ready / installed / explicit). Advertised is not proved. Use --json for the
machine-readable document. Doctor never prints tokens or secrets.

Remote pairing is opt-in. The pair command opens one outbound WSS connection;
T3 remains on loopback. The one-shot pair offer is read from a 0600 file and
removed only after the relay acknowledges the bind. Never pass a token on the
command line.

Runtime mode safety invariant:
  Every originate and every non-empty continue runs full-access, for every lab
  (T3-native selections and every Tentacles-additive adapter). Pass
  --runtime-mode full-access on originate and "runtimeMode":"full-access" on
  thread.continue intents. Omitting the runtime mode fails closed; it is never
  a compliant operation, and no approval popup is part of the validated path.

Environment:
  Service options:
  --model MODEL --interval MS --t3-url LOOPBACK_ORIGIN --hermes-url LOOPBACK_ORIGIN
  --token-file PATH --state-file PATH --max-messages 1..100 --allow-all-projects

Service operations are namespaced by an explicit filesystem-safe profile and
instance. They never choose a profile implicitly.

Environment:
  T3_URL                    default http://127.0.0.1:3773
  T3_HERMES_TOKEN_FILE      default ~/.local/state/t3-hermes-bridge/t3.token
  T3_HERMES_MODEL           default deepseek:deepseek-v4-flash
  HERMES_URL                default http://127.0.0.1:8642
  HERMES_PROFILE            used by bin/t3-hermes-acp; default default`;
}

function serviceOptions(options, { requireIdentity = true } = {}) {
  const identity = requireIdentity
    ? serviceIdentity({ profile: required(options, "profile"), instance: required(options, "instance") })
    : { profile: options.profile || DEFAULT_HERMES_PROFILE, instance: options.instance || DEFAULT_INSTANCE_ID };
  return {
    ...identity,
    model: options.model || DEFAULT_MODEL,
    interval: options.interval || 2000,
    t3Url: options["t3-url"] || process.env.T3_URL,
    hermesUrl: options["hermes-url"] || process.env.HERMES_URL,
    tokenFile: options["token-file"] || process.env.T3_HERMES_TOKEN_FILE,
    stateFile: options["state-file"],
    maxMessages: options["max-messages"] || 10,
    allowAllProjects: options["allow-all-projects"] === true,
  };
}

function writeWatchStatus(statusFile, event) {
  if (!statusFile) return;
  const destination = path.resolve(statusFile);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "--version" || command === "-V") {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (!KNOWN_COMMANDS.has(command)) throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  const instanceId = options.instance || DEFAULT_INSTANCE_ID;
  assertNoReservedRemovedInstance(command, instanceId);
  const model = options.model || DEFAULT_MODEL;
  let originateSelection = null;
  if (command === "originate") {
    const labInstanceId = requireAdvertisedLab(options.instance || DEFAULT_INSTANCE_ID, "--instance");
    const labModel = options.model || defaultModelForLab(labInstanceId);
    if (!labModel) {
      throw new Error(`${labInstanceId} is an explicit lab; pass --model with a model T3 currently advertises`);
    }
    originateSelection = resolveModelSelection({
      instanceId: labInstanceId,
      model: labModel,
      options: parseModelOptionFlags(options.option),
      budget: options.budget,
    });
  }

  if (command === "install-service") {
    console.log(JSON.stringify(installService({ cliPath: fileURLToPath(import.meta.url), ...serviceOptions(options) }), null, 2));
    return;
  }
  if (command === "service-status") {
    console.log(JSON.stringify(serviceStatus(serviceOptions(options)), null, 2));
    return;
  }
  if (command === "restart-service") {
    console.log(JSON.stringify(restartService(serviceOptions(options)), null, 2));
    return;
  }
  if (command === "uninstall-service") {
    console.log(JSON.stringify(uninstallService(serviceOptions(options)), null, 2));
    return;
  }

  const client = new T3Client();

  if (command === "doctor") {
    const result = await doctor(client, {
      instanceId,
      pairStateFile: options["pair-state-file"] || DEFAULT_PAIR_STATE_FILE,
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatDoctor(result));
    return;
  }
  if (command === "pair") {
    const pairStateFile = options["pair-state-file"] || DEFAULT_PAIR_STATE_FILE;
    const runtime = new LoopbackRuntimeAdapter({ client, pairStateFile });
    const pairer = new OutboundPairer({
      runtime,
      pairStateFile,
      onEvent: (event) => console.error(JSON.stringify(event)),
    });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await pairer.run({
        pairFile: path.resolve(required(options, "pair-file")),
        machineId: required(options, "machine-id"),
        signal: controller.signal,
      });
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
    return;
  }
  if (command === "install-provider") {
    const wrapperPath = path.join(repoRoot, "bin", "t3-hermes-acp");
    const result = await installProvider(client, {
      wrapperPath,
      instanceId,
      model,
      hermesBin: process.env.HERMES_BIN || resolveExecutable("hermes"),
      hermesProfile: options.profile || DEFAULT_HERMES_PROFILE,
    });
    console.log(JSON.stringify({ installed: true, instanceId, provider: result.provider?.instanceId || instanceId }, null, 2));
    return;
  }
  if (command === "remove-provider") {
    console.log(JSON.stringify(await removeProvider(client, { instanceId }), null, 2));
    return;
  }
  if (command === "install-pi-provider") {
    const piInstanceId = options.instance || DEFAULT_PI_INSTANCE_ID;
    const piModel = options.model || DEFAULT_PI_MODEL;
    const result = await installPiProvider(client, {
      wrapperPath: path.join(repoRoot, "bin", "t3-pi-acp"),
      instanceId: piInstanceId,
      model: piModel,
      piBin: resolvePiExecutable(),
      piProvider: options["pi-provider"] || process.env.PI_PROVIDER || DEFAULT_PI_PROVIDER,
    });
    console.log(JSON.stringify({ installed: true, instanceId: piInstanceId, provider: result.provider?.instanceId || piInstanceId }, null, 2));
    return;
  }
  if (command === "remove-pi-provider") {
    console.log(JSON.stringify(await removePiProvider(client, { instanceId: options.instance || DEFAULT_PI_INSTANCE_ID }), null, 2));
    return;
  }
  if (command === "install-deepseek-provider") {
    const deepseekInstanceId = options.instance || DEFAULT_DEEPSEEK_INSTANCE_ID;
    const deepseekModel = options.model || DEFAULT_DEEPSEEK_MODEL;
    const result = await installDeepSeekProvider(client, {
      wrapperPath: path.join(repoRoot, "bin", "t3-deepseek-acp"),
      instanceId: deepseekInstanceId,
      model: deepseekModel,
      dshAcpBin: resolveDshAcpExecutable(options["dsh-acp-bin"]),
    });
    console.log(JSON.stringify({ installed: true, instanceId: deepseekInstanceId, provider: result.provider?.instanceId || deepseekInstanceId }, null, 2));
    return;
  }
  if (command === "remove-deepseek-provider") {
    console.log(JSON.stringify(await removeDeepSeekProvider(client, { instanceId: options.instance || DEFAULT_DEEPSEEK_INSTANCE_ID }), null, 2));
    return;
  }
  if (command === "install-kimi-provider") {
    const kimiInstanceId = options.instance || DEFAULT_KIMI_INSTANCE_ID;
    const kimiModel = options.model || DEFAULT_KIMI_MODEL;
    const result = await installKimiProvider(client, {
      wrapperPath: path.join(repoRoot, "bin", "t3-kimi-acp"),
      instanceId: kimiInstanceId,
      model: kimiModel,
      kimiBin: resolveKimiExecutable(options["kimi-bin"]),
    });
    console.log(JSON.stringify({ installed: true, instanceId: kimiInstanceId, provider: result.provider?.instanceId || kimiInstanceId }, null, 2));
    return;
  }
  if (command === "remove-kimi-provider") {
    console.log(JSON.stringify(await removeKimiProvider(client, { instanceId: options.instance || DEFAULT_KIMI_INSTANCE_ID }), null, 2));
    return;
  }
  if (command === "restore-native-grok") {
    console.log(JSON.stringify(await restoreNativeGrok(client), null, 2));
    return;
  }
  if (command === "use-native-grok-cached-auth") {
    console.log(JSON.stringify(await useNativeGrokCachedAuth(client, {
      wrapperPath: path.join(repoRoot, "bin", "t3-native-grok-cached-auth"),
    }), null, 2));
    return;
  }
  if (command === "observe") {
    console.log(JSON.stringify(await observe(client), null, 2));
    return;
  }
  if (command === "act") {
    const intent = parseIntentOption(options);
    console.log(JSON.stringify(await applyIntents(client, [intent], { wait: options["no-wait"] !== true }), null, 2));
    return;
  }
  if (command === "orchestrate") {
    const intents = parseIntentFileOption(options);
    console.log(JSON.stringify(await applyIntents(client, intents, { wait: options["no-wait"] !== true }), null, 2));
    return;
  }
  if (command === "originate") {
    const runtimeMode = requireExplicitRuntimeMode(options["runtime-mode"], "--runtime-mode");
    if (originateSelection.instanceId === "hermes") {
      requireRequestedProviderConstructable(originateSelection.model);
    }
    const result = await originate(client, {
      workspace: path.resolve(required(options, "workspace")),
      title: required(options, "title"),
      message: required(options, "message"),
      instanceId: originateSelection.instanceId,
      model: originateSelection.model,
      options: originateSelection.options,
      runtimeMode,
      idempotencyKey: options["idempotency-key"],
      stateFile: options["state-file"],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "watch") {
    const watch = serviceOptions(options, { requireIdentity: false });
    if (!watch.allowAllProjects) {
      throw new Error("Mention routing is deny-by-default; pass --allow-all-projects to explicitly authorise all non-Hermes T3 projects");
    }
    const interval = Number(watch.interval);
    if (!Number.isFinite(interval) || interval < 250 || interval > 3_600_000) throw new Error("--interval must be between 250ms and 3600000ms");
    const maxMessages = Number(watch.maxMessages);
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) throw new Error("--max-messages must be an integer between 1 and 100");
    let stopping = false;
    let wake = null;
    const stop = () => { stopping = true; wake?.(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    let consecutiveFailures = 0;
    const wait = async (milliseconds) => {
      await new Promise((resolve) => { wake = resolve; delay(milliseconds).then(resolve); });
      wake = null;
    };
    do {
      try {
        const routed = await routeMentionsOnce(client, {
          stateFile: watch.stateFile,
          instanceId: watch.instance,
          model: watch.model,
          maxMessages,
          policy: ALLOW_ALL_MENTION_POLICY,
        });
        for (const route of routed) console.log(JSON.stringify({ event: "mention.routed", ...route }));
        writeWatchStatus(options["status-file"], { event: "watch.ok", profile: watch.profile, instance: watch.instance, routed: routed.length });
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        const baseDelay = Math.min(60_000, 1_000 * (2 ** Math.min(consecutiveFailures - 1, 6)));
        const retryDelayMs = Math.max(250, Math.floor(baseDelay * (0.8 + Math.random() * 0.4)));
        writeWatchStatus(options["status-file"], { event: "watch.error", profile: watch.profile, instance: watch.instance, errorType: error?.name || "Error", consecutiveFailures, retryDelayMs });
        console.error(JSON.stringify({ event: "watch.error", errorType: error?.name || "Error", consecutiveFailures, retryDelayMs }));
        if (options.once) throw error;
        await wait(retryDelayMs);
        continue;
      }
      if (options.once) break;
      await wait(interval);
    } while (!stopping);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

// Only run the CLI when executed directly (bin/t3-agent-bridge execs this
// module); importing it for tests must not start a command.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    const home = os.homedir();
    const message = String(error?.message || "command failed")
      .split(home).join("~")
      .replace(/\/(?:Users|home)\/[^/\s]+/g, "~")
      .replace(/\b(?:authorization|bearer)\s*[:=]?\s*\S+/gi, "$1 [redacted]")
      .replace(/\b(?:sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
    console.error(`tentacles: ${message}`);
    process.exitCode = 1;
  });
}
