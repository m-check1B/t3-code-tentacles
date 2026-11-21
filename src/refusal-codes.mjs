// KRA-10870: the fixed refusal texts a paired turn can end with, each with one
// typed code and one plain fix. Only exact fixed texts map; anything else is
// `unknown`, so no raw error text, path or token ever gets a code's words.
// shortcut: matched by exact message, not by a typed error class; upgrade when the
// throw sites carry their code themselves (bot-connectors belongs to KRA-10869).
export const REFUSALS = Object.freeze({
  "bot_connectors.pair_again": "Pair this computer again from an updated Agent Jack (Settings > Local labs > pair this computer).",
  "bot_connectors.lab_not_covered": "This Local lab can't use Agent Jack's tools yet; run this Bot on Local Claude Code, Local Codex or Server.",
  "bot_connectors.new_talk": "This Talk can't take tools on this computer; start a new Talk for this Bot.",
  "bot_connectors.codex_home": "Trust this Bot's folder in Codex first, or check config.toml in the Codex home T3 uses, then send again.",
  "bot_connectors.try_again": "The settings changed while this turn started; send again.",
  "bot_connectors.admission": "Agent Jack and this computer disagree about the Bot's tools; update both, then send again.",
  "talk.still_answering": "This Talk is still answering; send again once it finishes.",
  "talk.workspace_custody": "This computer refused the Talk's folder; check the Tentacles log on this computer.",
  unknown: "This computer could not run the turn; check the Tentacles log on this computer.",
});

const BY_TEXT = new Map([
  ["Jack tools need this computer paired again from an updated Agent Jack (Settings > Local labs > pair this computer)", "bot_connectors.pair_again"],
  ["Bot connectors are not supported on this lab", "bot_connectors.lab_not_covered"],
  ["Bot connectors need a Bot workspace", "bot_connectors.new_talk"],
  ["Bot connectors need this Bot's own workspace", "bot_connectors.new_talk"],
  ["Bot connector directory must be a real directory", "bot_connectors.new_talk"],
  ["Codex home is not a directory", "bot_connectors.codex_home"],
  ["Codex home config.toml links to a missing file; fix the link first", "bot_connectors.codex_home"],
  ["Codex home config keeps projects in a form Tentacles does not edit; trust this Bot workspace in Codex first", "bot_connectors.codex_home"],
  ["Codex home config changed while trusting this Bot workspace; try again", "bot_connectors.try_again"],
  ["Bot connector metadata requires mcpServers", "bot_connectors.admission"],
  ["Bot connectors are not an admitted list", "bot_connectors.admission"],
  ["Bot connectors require exact ownership", "bot_connectors.admission"],
  ["Bot connector admission expired", "bot_connectors.admission"],
  ["Bot connectors name a host this computer is not paired with", "bot_connectors.admission"],
  ["This Talk is still answering. Its tools change once it finishes; try again then.", "talk.still_answering"],
  ["Local Talk workspace custody or scope refused", "talk.workspace_custody"],
]);

/** `{ code, text }` for a thrown refusal; `text` is the table's own words, never the error's. */
export function refusalOf(error) {
  const code = BY_TEXT.get(error instanceof Error ? error.message : undefined) ?? "unknown";
  return { code, text: REFUSALS[code] };
}
