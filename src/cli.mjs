#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3Client } from "./t3-client.mjs";
import {
  doctor,
  installProvider,
  originate,
  removeProvider,
  routeMentionsOnce,
} from "./bridge.mjs";
import {
  DEFAULT_HERMES_PROFILE,
  DEFAULT_INSTANCE_ID,
  DEFAULT_MODEL,
  resolveExecutable,
} from "./config.mjs";
import { installService, serviceStatus, uninstallService } from "./service.mjs";

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
    if (key === "once") {
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

function usage() {
  return `t3-hermes — source-independent T3 Code ↔ Hermes bridge

Usage:
  t3-hermes doctor
  t3-hermes install-provider [--instance hermes] [--profile default] [--model MODEL]
  t3-hermes remove-provider [--instance hermes]
  t3-hermes originate --workspace PATH --title TITLE --message TEXT
  t3-hermes watch --once
  t3-hermes watch [--interval 2000]
  t3-hermes install-service [--interval 2000]
  t3-hermes service-status
  t3-hermes uninstall-service

Environment:
  T3_URL                    default http://127.0.0.1:3773
  T3_HERMES_TOKEN_FILE      default ~/.local/state/t3-hermes-bridge/t3.token
  T3_HERMES_MODEL           default openai-codex:gpt-5.6-sol
  HERMES_URL                default http://127.0.0.1:8642
  HERMES_PROFILE            used by bin/t3-hermes-acp; default default`;
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
    const interval = Number(options.interval || 2000);
    if (!Number.isFinite(interval) || interval < 250) throw new Error("--interval must be at least 250ms");
    console.log(JSON.stringify(installService({ cliPath: fileURLToPath(import.meta.url), interval }), null, 2));
    return;
  }
  if (command === "service-status") {
    console.log(JSON.stringify(serviceStatus(), null, 2));
    return;
  }
  if (command === "uninstall-service") {
    console.log(JSON.stringify(uninstallService(), null, 2));
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
  if (command === "originate") {
    const result = await originate(client, {
      workspace: path.resolve(required(options, "workspace")),
      title: required(options, "title"),
      message: required(options, "message"),
      instanceId,
      model,
      runtimeMode: options["runtime-mode"] || "approval-required",
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "watch") {
    const interval = Number(options.interval || 2000);
    if (!Number.isFinite(interval) || interval < 250) throw new Error("--interval must be at least 250ms");
    do {
      const routed = await routeMentionsOnce(client, { instanceId, model });
      for (const route of routed) console.log(JSON.stringify({ event: "mention.routed", ...route }));
      if (options.once) break;
      await delay(interval);
    } while (true);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(`t3-hermes: ${error.message}`);
  process.exitCode = 1;
});
