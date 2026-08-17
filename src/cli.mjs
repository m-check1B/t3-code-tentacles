#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3Client } from "./t3-client.mjs";
import {
  ALLOW_ALL_MENTION_POLICY,
  doctor,
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
import { applyIntents, observe } from "./orchestrate.mjs";
import {
  installService,
  restartService,
  serviceIdentity,
  serviceStatus,
  uninstallService,
} from "./service.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      options._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (key === "once" || key === "allow-all-projects" || key === "no-wait") {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
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

function usage() {
  return `t3-agent-bridge — provider-neutral T3 Code ACP bridge

Usage:
  t3-agent-bridge doctor
  t3-agent-bridge install-provider [--instance hermes] [--profile default] [--model MODEL]
  t3-agent-bridge remove-provider [--instance hermes]
  t3-agent-bridge install-pi-provider [--instance pi] [--model gpt-5.6-terra] [--pi-provider openai-codex]
  t3-agent-bridge remove-pi-provider [--instance pi]
  t3-agent-bridge install-deepseek-provider [--instance deepseek] [--model deepseek-v4-flash] [--dsh-acp-bin PATH]
  t3-agent-bridge remove-deepseek-provider [--instance deepseek]
  t3-agent-bridge install-kimi-provider [--instance kimi] [--model kimi-code/k3] [--kimi-bin PATH]
  t3-agent-bridge remove-kimi-provider [--instance kimi]
  t3-agent-bridge restore-native-grok
  t3-agent-bridge observe
  t3-agent-bridge act --intent '{...}' [--intent-file PATH] [--no-wait]
  t3-agent-bridge orchestrate --intent-file PATH [--no-wait]
  t3-agent-bridge originate --workspace PATH --title TITLE --message TEXT [--idempotency-key KEY]
  t3-agent-bridge watch --once --allow-all-projects [--profile PROFILE] [--instance INSTANCE]
  t3-agent-bridge watch --allow-all-projects [--interval 2000] [--state-file PATH] [--max-messages 10]
  t3-agent-bridge install-service --profile PROFILE --instance INSTANCE [service options]
  t3-agent-bridge service-status --profile PROFILE --instance INSTANCE
  t3-agent-bridge restart-service --profile PROFILE --instance INSTANCE
  t3-agent-bridge uninstall-service --profile PROFILE --instance INSTANCE

The legacy t3-hermes command remains an exact compatibility alias.

Environment:
  Service options:
  --model MODEL --interval MS --t3-url LOOPBACK_ORIGIN --hermes-url LOOPBACK_ORIGIN
  --token-file PATH --state-file PATH --max-messages 1..100 --allow-all-projects

Service operations are namespaced by an explicit filesystem-safe profile and
instance. They never choose a profile implicitly.

Environment:
  T3_URL                    default http://127.0.0.1:3773
  T3_HERMES_TOKEN_FILE      default ~/.local/state/t3-hermes-bridge/t3.token
  T3_HERMES_MODEL           default openai-codex:gpt-5.6-sol
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
  const instanceId = options.instance || DEFAULT_INSTANCE_ID;
  const model = options.model || DEFAULT_MODEL;

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
    console.log(JSON.stringify(await doctor(client, { instanceId }), null, 2));
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
    const result = await originate(client, {
      workspace: path.resolve(required(options, "workspace")),
      title: required(options, "title"),
      message: required(options, "message"),
      instanceId,
      model,
      runtimeMode: options["runtime-mode"] || "approval-required",
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
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`t3-agent-bridge: ${error.message}`);
    process.exitCode = 1;
  });
}
