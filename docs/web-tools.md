# Doctor built-in web tools contract

Every `labs[]` row returned by `doctor` and `doctor-status` includes:

```json
{"webTools":{"v":1,"state":"unknown","tools":[]}}
```

`state` is `off`, `on`, or `unknown`. `tools` contains only known built-in tool
names assessed by that reader. It is not a list of enabled tools: an `off`
Codex row still lists `web_search`. No paths, config values, environment values
or parse diagnostics are returned. Missing, unreadable, malformed or unsupported
configuration returns `unknown` with an empty tool list.

The advertised instance list includes `codex-noweb`, `opencode-noweb`,
`grok-noweb`, `cursor-noweb`, and `deepseek-noweb`. The exact ID is preserved
through selection, originate, continue, legacy/V2 commands, receipts and turn
results. Defaults, effort and Cursor model aliases follow the base lab. The
DeepSeek twin uses the same adapter credential readiness check as DeepSeek.

## Evidence and limits

- Codex: inspect only the exact instance's explicit absolute `config.homePath`
  and its `config.toml`. The current reader recognizes scalar root TOML settings
  without escapes; tables and more complex TOML return `unknown`. It requires
  an explicit nonsensitive `T3CODE_CODEX_LAUNCH_ARGS` instance environment entry
  so it never substitutes the doctor's environment for T3's environment. The
  effective launch arguments must be exactly `--search` or one
  `--config 'web_search="disabled"'` override (`-c` is also accepted, and the
  recognized enabled modes are `cached`, `indexed`, and `live`). A config-only
  disable with no launch override is `unknown` because project configuration
  could supersede it. Managed and shadow homes are unsupported.
- OpenCode: explicit inline `OPENCODE_CONFIG_CONTENT` enables for both
  `tools.webfetch`/`tools.websearch` and their `permission` entries report `on`.
  Config denials remain `unknown`: T3's full-access session rules can override
  config permissions. External OpenCode servers are unsupported.
- Grok, Cursor, DeepSeek, and the other adapters: `unknown`. A twin name,
  disabled provider, or a declared `webTools` config field is never evidence
  that built-in tools are disabled.

These are launch-configuration observations, not inspection of a running
process or an egress sandbox. No provider CLI is spawned by this reader. No
installed-version or live zero-fetch compatibility claim follows from unit
or transport fixtures.

## Jack integration

The Server lab transport doctor allowlist must preserve `webTools`. Its owner
must require the exact twin row to be `ready`, with `webTools.v === 1` and
`webTools.state === "off"`, before dispatching a web-off or unknown-grant Bot.
Missing fields and every other state must refuse. Join `server.getConfig`
providers by exact `instanceId`; never substitute a ready base provider.

`capabilities.jackMcpProviders` is a T3 turn-result capability. This change
neither creates it nor adds twins to an upstream capability list.
