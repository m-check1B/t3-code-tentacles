import fs from "node:fs";
import path from "node:path";
import { NOWEB_LAB_DRIVERS } from "./model-selection.mjs";

const MAX_CONFIG_BYTES = 64 * 1024;
const unknown = () => ({ v: 1, state: "unknown", tools: [] });
const codexState = (state) => ({ v: 1, state, tools: ["web_search"] });
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readConfig(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0, count;
    while ((count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) {
      length += count;
      if (length > MAX_CONFIG_BYTES) return null;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    fs.closeSync(fd);
  }
}

// A deliberately small TOML subset: scalar root settings only. Tables,
// multiline values, duplicates and unknown syntax cannot certify a policy.
// Never extract a matching line from an otherwise unparsed document.
function scalarConfig(text) {
  if (typeof text !== "string") return null;
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*("[^"\\\x00-\x1f]*"|'[^'\x00-\x1f]*'|true|false|-?(?:0|[1-9][0-9]*))\s*(?:#.*)?$/.exec(line);
    if (!match || result.has(match[1])) return null;
    const raw = match[2];
    const value = raw.startsWith("'") ? raw.slice(1, -1) : JSON.parse(raw);
    result.set(match[1], value);
  }
  return result;
}

function explicitEnvironment(instance, name) {
  const entries = (instance.environment || []).filter(entry => entry?.name === name);
  if (entries.length !== 1 || entries[0].valueRedacted === true || entries[0].sensitive === true || typeof entries[0].value !== "string") return null;
  return entries[0].value;
}

function codexWebTools(instance) {
  const config = instance.config;
  if (!record(config) || config.setupMode === "managed" || config.shadowHomePath || !path.isAbsolute(config.homePath || "")) return unknown();
  // No fallback to the doctor's HOME/CODEX_HOME: it is not the T3 process.
  // The launch-args environment override must be explicit, even when empty.
  const override = explicitEnvironment(instance, "T3CODE_CODEX_LAUNCH_ARGS");
  if (override === null) return unknown();
  const values = scalarConfig(readConfig(path.join(config.homePath, "config.toml")));
  if (!values || !["disabled", "cached", "live", "indexed"].includes(values.get("web_search"))) return unknown();
  const args = (override.trim() || config.launchArgs || "").trim();
  if (args === "--search") return codexState("on");
  // Accept one fully understood override, without profiles or other flags.
  // Outer single quotes preserve the TOML string through T3's argv tokenizer.
  const pin = /^(?:-c|--config)\s+'web_search="(disabled|cached|live|indexed)"'$/.exec(args);
  if (pin) return codexState(pin[1] === "disabled" ? "off" : "on");
  // A home setting alone is not enough: project layers can override it.
  return unknown();
}

function openCodeWebTools(instance) {
  if (!record(instance.config) || instance.config.serverUrl) return unknown();
  const inline = explicitEnvironment(instance, "OPENCODE_CONFIG_CONTENT");
  if (!inline || Buffer.byteLength(inline, "utf8") > MAX_CONFIG_BYTES) return unknown();
  const config = JSON.parse(inline);
  if (!record(config) || !record(config.tools) || !record(config.permission)) return unknown();
  // Both explicit enables are observable as on. Denials cannot prove off:
  // T3 can append session-level '*' allow rules in full-access mode.
  const tools = ["webfetch", "websearch"];
  if (tools.every(tool => config.tools[tool] === true && config.permission[tool] === "allow")) {
    return { v: 1, state: "on", tools };
  }
  return unknown();
}

/** Config-derived built-in web policy, never an instance-name assertion.
 * Unsupported drivers (including Grok-backed adapters) remain unknown.
 * OpenCode's full-access session allow rules can override config denials;
 * until that boundary has a proven control, it cannot certify web off.
 */
export function inspectInstanceWebTools(settings, instanceId) {
  try {
    const instance = settings?.providerInstances?.[instanceId];
    if (!record(instance)) return unknown();
    if (Object.hasOwn(NOWEB_LAB_DRIVERS, instanceId) && NOWEB_LAB_DRIVERS[instanceId] !== instance.driver) return unknown();
    if (instance.driver === "codex") return codexWebTools(instance);
    if (instance.driver === "opencode") return openCodeWebTools(instance);
    return unknown();
  } catch {
    // Do not return paths, parse errors, config contents or environment values.
    return unknown();
  }
}
