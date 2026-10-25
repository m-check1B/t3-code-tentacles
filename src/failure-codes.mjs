// Typed, redacted failure codes (KRA-8958).
//
// Failed or blocked `report` and `turn-result` entries, and orchestrate
// receipts, carry a stable `code` plus a static `message` that is safe to show
// anywhere. Chairs, Jack and GUARDIAN route on `code`, never on provider text.
// Provider error text is only matched against known patterns here; it is never
// copied into a code, a message or any other output.

export const FAILURE_CODES = Object.freeze([
  "session_busy",
  "lab_not_ready",
  "timeout",
  "cancelled",
  "provider_error",
  "usage_limit",
  "approval_required",
]);

export const FAILURE_MESSAGES = Object.freeze({
  session_busy: "The session is busy with another turn; retry after it finishes.",
  lab_not_ready: "The lab or provider is not ready; check tentacles doctor.",
  timeout: "The operation timed out before T3 confirmed an outcome.",
  cancelled: "The turn was cancelled.",
  provider_error: "The provider reported an error; details stay on the owner surface.",
  usage_limit: "The provider usage limit was reached; route to a fallback lab or retry later.",
  approval_required: "The turn is waiting for an approval or user input.",
});

const MAX_CLASSIFIED_TEXT = 4096;

// Ordered: the first matching pattern wins. Patterns describe the failure
// class only; the matched text is discarded.
const TEXT_PATTERNS = [
  // Context-window and token-limit overflow is a request problem, not a
  // usage limit: a fallback lab or a later retry would fail the same way.
  ["provider_error", /\b(?:context[ _-]?(?:length|window|limit)|context_length_exceeded|tokens?[ _-]?limit|prompt is too long|too many (?:input |prompt )?tokens)\b/i],
  ["usage_limit", /\b(?:usage[ _-]?limit|rate[ _-]?limit(?:ed)?|insufficient[ _-]?quota|quota (?:exceeded|exhausted|reached)|too many requests|(?:hit|reached) (?:your|the) (?:usage |rate )?limit|limit (?:reached|exceeded)|out of credits|credit balance is too low)\b/i],
  // A bare `timeout` word (for example a `timeout=30` setting) is not a
  // timeout; only timeout phrases or the whole text `timeout` are.
  ["timeout", /\b(?:timed[ -]?out|deadline exceeded|ETIMEDOUT|(?:request|connection|connect|read|write|gateway|socket|idle|operation|turn|response|upstream)[ _-]timeout|timeout (?:error|exceeded|expired|reached|occurred))\b|^\s*timeout[.!]?\s*$/i],
  ["session_busy", /\b(?:session|thread|state|lab) (?:is )?busy\b|\b(?:turn|session) (?:is )?already (?:running|active|in progress)\b|\banother turn is (?:running|active|in progress)\b/i],
  ["lab_not_ready", /\b(?:lab|provider(?: instance)?|harness|adapter|model)\b[^\n]{0,80}?\b(?:not (?:ready|found|installed|configured|available)|unavailable|is missing)\b|\bharness_not_found\b/i],
  ["cancelled", /\b(?:cancel(?:l)?ed|interrupted|aborted by user)\b/i],
];

export function failure(code) {
  if (!FAILURE_CODES.includes(code)) code = "provider_error";
  return { code, message: FAILURE_MESSAGES[code] };
}

function errorText(error) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return typeof error.message === "string" ? error.message : "";
  if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
  return "";
}

/** Classify provider/error text into a code without retaining the text. */
export function classifyFailureText(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const bounded = text.slice(0, MAX_CLASSIFIED_TEXT);
  for (const [code, pattern] of TEXT_PATTERNS) if (pattern.test(bounded)) return code;
  return null;
}

/**
 * Derive `{code, message}` from existing state, status and error signals.
 * Structured signals win over text; unknown failures are `provider_error`.
 */
export function classifyFailure({
  state = null,
  sessionStatus = null,
  hasPendingApprovals = false,
  hasPendingUserInput = false,
  error = null,
  httpStatus = null,
} = {}) {
  if (hasPendingApprovals === true || hasPendingUserInput === true) return failure("approval_required");
  if (state === "cancelled" || state === "interrupted" || sessionStatus === "interrupted") return failure("cancelled");
  if (error instanceof Error && error.failure && FAILURE_CODES.includes(error.failure.code)) return failure(error.failure.code);
  if (error instanceof Error && error.name === "TimeoutError") return failure("timeout");
  if (error instanceof Error && error.name === "AbortError") return failure("cancelled");
  const status = Number.isInteger(httpStatus) ? httpStatus : (Number.isInteger(error?.status) ? error.status : null);
  if (status === 429) return failure("usage_limit");
  if (status === 409) return failure("session_busy");
  if (status === 408 || status === 504) return failure("timeout");
  return failure(classifyFailureText(errorText(error)) ?? "provider_error");
}
