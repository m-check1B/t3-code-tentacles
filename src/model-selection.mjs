export const ORIGINATE_LABS = Object.freeze([
  "hermes",
  "codex",
  "claudeAgent",
  "grok",
  "deepseek",
  "kimi",
  "pi",
  "opencode",
]);

export const RUNTIME_MODES = Object.freeze([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export const BUDGETS = Object.freeze(["low", "medium", "high"]);

const RUNTIME_MODE_SET = new Set(RUNTIME_MODES);
const BUDGET_SET = new Set(BUDGETS);

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
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
  'POL-036/POL-GB-016: runtime mode "full-access" is mandatory on every originate and every non-empty continue for every lab and effort (including Grok Code CLI and Codex xhigh/high); omitting the runtime mode is not a compliant operation';

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
    normalized.push({
      id: requireNonEmptyString(entry.id, `${label} id`),
      value: normalizeOptionValue(entry.value, `${label} value`),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

// Lab effort knobs seen on live T3 threads. Other labs stay instance+model
// only — do not invent option ids T3 has not advertised for that lab.
export function budgetOptionId(instanceId, model) {
  if (instanceId === "claudeAgent") return "effort";
  if (instanceId === "codex") return "reasoningEffort";
  if (instanceId === "hermes" && typeof model === "string" && model.startsWith("openai-codex:")) {
    return "reasoningEffort";
  }
  return null;
}

export function resolveModelSelection({ instanceId, model, options, budget } = {}) {
  const resolvedInstanceId = requireNonEmptyString(instanceId, "modelSelection.instanceId");
  const resolvedModel = requireNonEmptyString(model, "modelSelection.model");
  const explicit = normalizeModelOptions(options) ?? [];
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
  const selection = { instanceId: resolvedInstanceId, model: resolvedModel };
  if (explicit.length > 0) selection.options = explicit;
  return selection;
}
