export const ORIGINATE_LABS = Object.freeze([
  "hermes",
  "codex",
  "codex-app",
  "claudeAgent",
  "grok",
  "cursor",
  "deepseek",
  "kimi",
  "pi",
  "opencode",
]);

export const ADAPTER_LABS = Object.freeze(["hermes", "pi", "deepseek", "kimi"]);
export const EXPLICIT_LABS = Object.freeze(["cursor"]);

export const LAB_DEFAULT_MODELS = Object.freeze({
  hermes: process.env.T3_HERMES_MODEL || "deepseek:deepseek-v4-flash",
  pi: process.env.T3_PI_MODEL || "gpt-5.6-terra",
  deepseek: process.env.T3_DEEPSEEK_MODEL || "deepseek/deepseek-v4-flash",
  kimi: process.env.T3_KIMI_MODEL || "moonshotai/kimi-k3",
  grok: process.env.T3_GROK_MODEL || "grok-4.6",
  codex: process.env.T3_CODEX_MODEL || "gpt-5.6-luna",
  "codex-app": process.env.T3_CODEX_APP_MODEL || process.env.T3_CODEX_MODEL || "gpt-5.6-luna",
  claudeAgent: process.env.T3_CLAUDE_MODEL || "claude-sonnet-5",
  opencode: process.env.T3_OPENCODE_MODEL || "opencode/big-pickle",
});

export function labKind(instanceId) {
  if (!ORIGINATE_LABS.includes(instanceId)) return "external";
  if (ADAPTER_LABS.includes(instanceId)) return "adapter";
  if (EXPLICIT_LABS.includes(instanceId)) return "explicit";
  return "native";
}

export function defaultModelForLab(instanceId) {
  const id = requireNonEmptyString(instanceId, "instanceId");
  if (Object.hasOwn(LAB_DEFAULT_MODELS, id)) return LAB_DEFAULT_MODELS[id];
  return null;
}

export function labInstallHint(instanceId) {
  switch (instanceId) {
    case "hermes":
      return "tentacles install-provider --instance hermes";
    case "pi":
      return "tentacles install-pi-provider --instance pi";
    case "deepseek":
      return "tentacles install-deepseek-provider --instance deepseek";
    case "kimi":
      return "tentacles install-kimi-provider --instance kimi";
    case "cursor":
      return "Enable the T3 Cursor instance, then originate with --instance cursor --model <advertised>";
    case "codex-app":
      return "tentacles install-codex-app-provider --instance codex-app";
    default:
      return null;
  }
}

export const RUNTIME_MODES = Object.freeze([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export const BUDGETS = Object.freeze(["low", "medium", "high"]);

const RUNTIME_MODE_SET = new Set(RUNTIME_MODES);
const BUDGET_SET = new Set(BUDGETS);

const CURSOR_PARAMETERIZED_MODEL_ALIASES = Object.freeze({
  "composer-2.5-fast": {
    model: "composer-2.5",
    options: [{ id: "fastMode", value: true }],
  },
});

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function requireAdvertisedLab(instanceId, label = "instance") {
  const id = requireNonEmptyString(instanceId, label);
  if (!ORIGINATE_LABS.includes(id)) {
    throw new Error(`${label} must be an advertised Tentacles lab: ${ORIGINATE_LABS.join(", ")}`);
  }
  return id;
}

function normalizeOptionValue(value, label) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error(`${label} must be a non-empty string or boolean`);
    return trimmed;
  }
  throw new Error(`${label} must be a non-empty string or boolean`);
}

export function requireRuntimeMode(runtimeMode, label = "runtimeMode") {
  const value = requireNonEmptyString(runtimeMode, label);
  if (!RUNTIME_MODE_SET.has(value)) {
    throw new Error(`${label} must be one of ${RUNTIME_MODES.join(", ")}`);
  }
  return value;
}

export const RUNTIME_MODE_INVARIANT =
  'runtime mode "full-access" is mandatory on every originate and every non-empty continue for every lab and effort; omitting it fails closed';

export function requireExplicitRuntimeMode(runtimeMode, label = "runtimeMode") {
  if (runtimeMode === undefined || runtimeMode === null || (typeof runtimeMode === "string" && runtimeMode.trim().length === 0)) {
    throw new Error(`${label} is required — ${RUNTIME_MODE_INVARIANT}`);
  }
  return requireRuntimeMode(runtimeMode, label);
}

export function parseModelOptionFlag(raw) {
  if (typeof raw !== "string") throw new Error("--option must be id=value");
  const separator = raw.indexOf("=");
  if (separator <= 0 || separator === raw.length - 1) throw new Error("--option must be id=value");
  const id = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  if (!id || !value) throw new Error("--option must be id=value");
  return { id, value };
}

export function parseModelOptionFlags(raw) {
  if (raw === undefined) return undefined;
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map(parseModelOptionFlag);
}

export function normalizeModelOptions(options, label = "modelSelection.options") {
  if (options === undefined || options === null) return undefined;
  if (!Array.isArray(options)) throw new Error(`${label} must be an array of {id, value}`);
  const normalized = [];
  for (const entry of options) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} entries must be objects with id and value`);
    }
    const id = requireNonEmptyString(entry.id, `${label} id`);
    // Ambiguous duplicates would let a later entry bypass first-match
    // validation (e.g. high then xhigh), and provider precedence is unproven.
    if (normalized.some((existing) => existing.id === id)) {
      throw new Error(`${label} must not repeat option id ${id}`);
    }
    normalized.push({ id, value: normalizeOptionValue(entry.value, `${label} value`) });
  }
  return normalized.length > 0 ? normalized : undefined;
}

// Lab effort knobs seen on live T3 threads. Other labs stay instance+model
// only — do not invent option ids T3 has not advertised for that lab.
export function budgetOptionId(instanceId, model) {
  if (instanceId === "claudeAgent") return "effort";
  if (instanceId === "codex" || instanceId === "codex-app" || instanceId === "grok") return "reasoningEffort";
  if (instanceId === "hermes" && typeof model === "string" && model.startsWith("openai-codex:")) {
    return "reasoningEffort";
  }
  return null;
}

export function defaultBudget(model) {
  return typeof model === "string" && /(^|[-:/])(claude-opus|gpt-[\d.]+-astra)/.test(model) ? "medium" : "high";
}

export function resolveModelSelection({ instanceId, model, options, budget } = {}) {
  const resolvedInstanceId = requireNonEmptyString(instanceId, "modelSelection.instanceId");
  let resolvedModel = requireNonEmptyString(model, "modelSelection.model");
  const explicit = normalizeModelOptions(options) ?? [];
  const cursorAlias = resolvedInstanceId === "cursor"
    ? CURSOR_PARAMETERIZED_MODEL_ALIASES[resolvedModel]
    : undefined;
  if (cursorAlias) {
    resolvedModel = cursorAlias.model;
    for (const requiredOption of cursorAlias.options) {
      const configured = explicit.find((entry) => entry.id === requiredOption.id);
      if (configured && configured.value !== requiredOption.value) {
        throw new Error(`Cursor model alias ${model} conflicts with option ${requiredOption.id}`);
      }
      if (!configured) explicit.push({ ...requiredOption });
    }
  }
  return pinSelection(resolvedInstanceId, resolvedModel, explicit, budget);
}

function pinSelection(resolvedInstanceId, resolvedModel, explicit, budget) {
  if (budget !== undefined && budget !== null && budget !== "") {
    const resolvedBudget = requireNonEmptyString(budget, "budget");
    if (!BUDGET_SET.has(resolvedBudget)) {
      throw new Error(`budget must be one of ${BUDGETS.join(", ")}`);
    }
    const optionId = budgetOptionId(resolvedInstanceId, resolvedModel);
    if (optionId && !explicit.some((entry) => entry.id === optionId)) {
      explicit.push({ id: optionId, value: resolvedBudget });
    }
  }
  // Founder effort policy: every seat with an effort knob pins one, so no lab
  // inherits a local default (e.g. ~/.grok/config.toml xhigh). Default high;
  // Opus and Astra start at medium. Above high is Founder-manual only.
  const effortId = budgetOptionId(resolvedInstanceId, resolvedModel);
  if (effortId) {
    const effort = explicit.find((entry) => entry.id === effortId);
    if (!effort) {
      explicit.push({ id: effortId, value: defaultBudget(resolvedModel) });
    } else if (!BUDGET_SET.has(effort.value)) {
      throw new Error(`${effortId} must be one of ${BUDGETS.join(", ")}; above high is Founder-manual only`);
    }
  }
  const selection = { instanceId: resolvedInstanceId, model: resolvedModel };
  if (explicit.length > 0) selection.options = explicit;
  return selection;
}

// A continue or restart either keeps the retained selection (every selection
// field omitted) or names a complete new one. Partial input (budget or options
// alone, or only one of instanceId/model, including null/empty values) fails
// closed instead of falling back to Hermes defaults or being silently dropped.
// Returns true for an explicit selection, false for the retained path.
export function requireContinueSelection(fields) {
  const supplied = Object.keys(fields).filter((key) => fields[key] !== undefined);
  if (supplied.length === 0) return false;
  if (fields.instanceId !== undefined && fields.model !== undefined) return true;
  throw new Error(`Partial continue selection (${supplied.join(", ")}): pass both instanceId and model, or omit instanceId, model, options and budget to keep the retained selection`);
}

// Omitted-selection continues keep the thread's retained lab and model, but
// still pass the effort policy: a missing known knob is pinned, and an
// above-high or ambiguous retained effort fails closed before dispatch.
// Returns undefined when the retained selection is already valid as-is, so
// the turn dispatches without a selection exactly as before.
export function retainedSelectionPin(retained) {
  if (!retained || typeof retained !== "object" || Array.isArray(retained)) {
    throw new Error("Retained thread model selection is unproven; pass instanceId and model explicitly");
  }
  const instanceId = requireNonEmptyString(retained.instanceId, "retained modelSelection.instanceId");
  const model = requireNonEmptyString(retained.model, "retained modelSelection.model");
  const options = normalizeModelOptions(retained.options, "retained modelSelection.options") ?? [];
  const pinned = pinSelection(instanceId, model, options, undefined);
  const unchanged = pinned.instanceId === retained.instanceId
    && pinned.model === retained.model
    && JSON.stringify(pinned.options ?? []) === JSON.stringify(retained.options ?? []);
  return unchanged ? undefined : pinned;
}
