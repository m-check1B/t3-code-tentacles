// KRA-6506: public lab names. Mirror of Agent Jack's api/src/jack_api/lab_names.v1.json
// (agent-jack-3). Keep the two tables identical.
export const LAB_NAMES = Object.freeze({
  codex: "Codex CLI",
  "codex-app": "Codex App",
  claudeAgent: "Claude Code CLI",
  opencode: "OpenCode CLI",
  deepseek: "DeepSeek CLI",
  grok: "Grok CLI",
  cursor: "Cursor CLI",
  kimi: "Kimi CLI",
  pi: "Pi CLI",
  hermes: "Hermes CLI",
});

export function labName(instanceId) {
  return Object.hasOwn(LAB_NAMES, instanceId) ? LAB_NAMES[instanceId] : null;
}
