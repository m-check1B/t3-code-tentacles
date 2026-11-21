// KRA-10870: the fixed refusal texts a paired turn can end with, each with one
// typed code and one plain fix. Only exact fixed texts map; anything else is
// `unknown`, so no raw error text, path or token ever gets a code's words.
// shortcut: matched by exact message, not by a typed error class; upgrade when the
// throw sites carry their code themselves (bot-connectors belongs to KRA-10869).
import { BOT_CONNECTOR_REFUSALS } from "./bot-connector-refusals.mjs";

export const REFUSALS = Object.freeze({
  "bot_connectors.pair_again": "Pair this computer again from the Agent Jack you use, on its latest release (Settings > Local labs > pair this computer).",
  "bot_connectors.lab_not_covered": "This Local lab can't use Agent Jack's tools yet; run this Bot on Local Claude Code, Local Codex or Server.",
  "bot_connectors.new_talk": "This Talk can't take tools on this computer; start a new Talk for this Bot.",
  "bot_connectors.bot_folder": "A folder or file in this Bot's workspace on this computer is a link or the wrong type; make it a plain folder or file, then send again.",
  "bot_connectors.codex_home": "Trust this Bot's folder in Codex first, or check config.toml in the Codex home T3 uses, then send again.",
  "bot_connectors.grok_home": "Trust this Bot's folder in Grok first, or check trusted_folders.toml and GROK_HOME in the Grok home T3 uses, then send again.",
  "bot_connectors.clock": "Check that this computer's clock is right, then send again.",
  "bot_connectors.admission": "Agent Jack and this computer disagree about the Bot's tools; update both, then send again.",
  "talk.still_answering": "This Talk is still answering; send again once it finishes.",
  "talk.workspace_custody": "This computer refused the Talk's folder; check the Tentacles log on this computer.",
  "model.thinking_level_twice": "This Antigravity model already sets a thinking level; drop the old -low/-medium/-high from the model or the thinking-level option.",
  "model.fast_mode_twice": "This Cursor model already sets fast mode; use composer-2.5 with the fast-mode option, or composer-2.5-fast without it.",
  "tentacles.update": "Update Tentacles on this computer, then send again.",
  "t3.unreachable": "Start T3 Code (Beta) on this computer, then send again.",
  try_again: "This computer was busy as the turn started; send again.",
  unknown: "This computer could not run the turn; check the Tentacles log on this computer.",
});

// Every BOT_CONNECTOR_REFUSALS key needs a code here; a test fails on a new key without one.
export const BOT_CONNECTOR_CODES = Object.freeze({
  labWithoutJackTools: "bot_connectors.lab_not_covered",
  oldTalk: "bot_connectors.new_talk",
  notOwnWorkspace: "bot_connectors.new_talk",
  notBotWorkspace: "bot_connectors.new_talk",
  realDirectory: "bot_connectors.bot_folder",
  fileIsDirectory: "bot_connectors.bot_folder",
  opencodeFileNotOurs: "bot_connectors.bot_folder",
  guardFileIsDirectory: "bot_connectors.bot_folder",
  codexHomeNotDirectory: "bot_connectors.codex_home",
  codexLinkMissing: "bot_connectors.codex_home",
  codexProjectsForm: "bot_connectors.codex_home",
  codexChanged: "try_again",
  grokHomeNotDirectory: "bot_connectors.grok_home",
  grokHomeForm: "bot_connectors.grok_home",
  grokTrustLink: "bot_connectors.grok_home",
  grokTrustForm: "bot_connectors.grok_home",
  grokNotTrusted: "bot_connectors.grok_home",
  grokGitRepo: "bot_connectors.lab_not_covered",
  grokChanged: "try_again",
  cursorGitRepo: "bot_connectors.lab_not_covered",
  cursorFileNotOurs: "bot_connectors.bot_folder",
});

const BY_TEXT = new Map([
  ...Object.entries(BOT_CONNECTOR_CODES).map(([key, code]) => [BOT_CONNECTOR_REFUSALS[key], code]),
  ["Jack tools need this computer paired again from an updated Agent Jack (Settings > Local labs > pair this computer)", "bot_connectors.pair_again"],
  ["Bot connector metadata requires mcpServers", "bot_connectors.admission"],
  ["Bot connectors are not an admitted list", "bot_connectors.admission"],
  ["Bot connectors require exact ownership", "bot_connectors.admission"],
  ["Bot connector admission expired", "bot_connectors.clock"],
  ["Bot connectors name a host this computer is not paired with", "bot_connectors.pair_again"],
  ["This Talk is still answering. Its tools change once it finishes; try again then.", "talk.still_answering"],
  ["Local Talk workspace custody or scope refused", "talk.workspace_custody"],
  ["Thread workspace could not be resolved; continue refused before T3", "bot_connectors.new_talk"],
  ["Bridge state is busy; retry originate after the active watcher operation completes", "try_again"],
]);

// Texts that carry a value: matched by shape, and the value is never logged.
const BY_SHAPE = [
  [/^[a-z-]{1,40} does not accept remote parameter \S{1,200}$/, "tentacles.update"],
  [/^T3 RPC [\w.:/-]{1,80} websocket failed$/, "t3.unreachable"],
  [/^Antigravity model alias gemini-[a-z0-9.-]{1,80} conflicts with option thought_level$/, "model.thinking_level_twice"],
  [/^Cursor model alias composer-2\.5-fast conflicts with option fastMode$/, "model.fast_mode_twice"],
];

function codeOf(error) {
  if (!(error instanceof Error)) return "unknown";
  // Same test as doctor's t3_unreachable (KRA-10852): only a refused connection means T3 is not running.
  if (error instanceof TypeError && error.cause?.code === "ECONNREFUSED") return "t3.unreachable";
  const { message } = error;
  if (typeof message !== "string") return "unknown";
  return BY_TEXT.get(message) ?? BY_SHAPE.find(([shape]) => shape.test(message))?.[1] ?? "unknown";
}

/** `{ code, text }` for a thrown refusal; `text` is the table's own words, never the error's. */
export function refusalOf(error) {
  let code;
  try { code = codeOf(error); } catch { code = "unknown"; } // A throwing `message` getter still logs.
  return { code, text: REFUSALS[code] };
}
