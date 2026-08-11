#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3Client } from "./t3-client.mjs";
import {
  ALLOW_ALL_MENTION_POLICY,
  doctor,
  installProvider,
  installPiProvider,
  originate,
  removeProvider,
  removePiProvider,
  routeMentionsOnce,
} from "./bridge.mjs";
import {
  DEFAULT_HERMES_PROFILE,
  DEFAULT_INSTANCE_ID,
  DEFAULT_MODEL,
  DEFAULT_PI_INSTANCE_ID,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_PROVIDER,
  resolveExecutable,
} from "./config.mjs";
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
    if (key === "once" || key === "allow-all-projects") {
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

function resolvePiExecutable() {
  const configured = process.env.PI_BIN;
  if (!configured) return resolveExecutable("pi");
  if (!path.isAbsolute(configured)) throw new Error("PI_BIN must be an absolute executable path when installing the Pi provider");
  fs.accessSync(configured, fs.constants.X_OK);
  return fs.realpathSync(configured);
}

function usage() {
  return `t3-hermes — source-independent T3 Code ↔ Hermes bridge

Usage:
  t3-hermes doctor
  t3-hermes install-provider [--instance hermes] [--profile default] [--model MODEL]
  t3-hermes remove-provider [--instance hermes]
  t3-hermes install-pi-provider [--instance pi] [--model gpt-5.6-terra] [--pi-provider openai-codex]
  t3-hermes remove-pi-provider [--instance pi]
  t3-hermes originate --workspace PATH --title TITLE --message TEXT [--idempotency-key KEY]
  t3-hermes watch --once --allow-all-projects [--profile PROFILE] [--instance INSTANCE]
  t3-hermes watch --allow-all-projects [--interval 2000] [--state-file PATH] [--max-messages 10]
  t3-hermes install-service --profile PROFILE --instance INSTANCE [service options]
  t3-hermes service-status --profile PROFILE --instance INSTANCE
  t3-hermes restart-service --profile PROFILE --instance INSTANCE
  t3-hermes uninstall-service --profile PROFILE --instance INSTANCE

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

main().catch((error) => {
  console.error(`t3-hermes: ${error.message}`);
  process.exitCode = 1;
});
