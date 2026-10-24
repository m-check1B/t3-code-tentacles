// Import before source modules: model defaults are captured at module evaluation.
// Each test file runs in its own process, so these fixtures cannot affect runtime.
Object.assign(process.env, {
  T3_HERMES_MODEL: "deepseek:deepseek-v4-flash",
  T3_PI_MODEL: "gpt-5.6-terra",
  T3_DEEPSEEK_MODEL: "deepseek/deepseek-v4-flash",
  T3_KIMI_MODEL: "moonshotai/kimi-k3",
  T3_GROK_MODEL: "grok-4.6",
  T3_CODEX_MODEL: "gpt-5.6-luna",
  T3_CODEX_APP_MODEL: "gpt-5.6-luna",
  T3_CLAUDE_MODEL: "claude-sonnet-5",
  T3_OPENCODE_MODEL: "opencode/big-pickle",
});
