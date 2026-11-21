// Fixed refusal texts for Bot connector set-up, in one place so a later change
// (KRA-10870) can attach a code to each. Never interpolate paths or values here.
export const BOT_CONNECTOR_REFUSALS = Object.freeze({
  labWithoutJackTools: "This lab cannot use Jack tools on Local yet; run this Bot on Server to use them",
  oldTalk: "This Talk started before plugins worked on Local; start a new Talk to use plugins on Local",
  notOwnWorkspace: "Bot connectors need this Bot's own workspace",
  notBotWorkspace: "Bot connectors need a Bot workspace",
  realDirectory: "Bot connector directory must be a real directory",
  fileIsDirectory: "Bot connector file must not be a directory",
  guardFileIsDirectory: "Talk instruction guard file must not be a directory",
  codexHomeNotDirectory: "Codex home is not a directory",
  codexLinkMissing: "Codex home config.toml links to a missing file; fix the link first",
  codexProjectsForm: "Codex home config keeps projects in a form Tentacles does not edit; trust this Bot workspace in Codex first",
  grokHomeNotDirectory: "Grok home is not a directory",
  grokTrustLink: "Grok trusted_folders.toml is a link; trust this Bot workspace in Grok first",
  grokHomeForm: "Grok home in T3's grok settings is not an absolute path; set GROK_HOME there to an absolute path, or remove it",
  grokNotTrusted: "Grok does not trust this Bot workspace; trust it in Grok first, or run this Bot on Server",
  grokGitRepo: "This Bot workspace is inside a git repository, where Grok decides trust for the whole repository; run this Bot on Server to use Jack tools",
  grokChanged: "Grok trusted_folders.toml changed while trusting this Bot workspace; try again",
  grokTrustForm: "Grok trusted_folders.toml holds a form Tentacles does not edit; trust this Bot workspace in Grok first",
  cursorGitRepo: "This Bot workspace is inside a git repository, where Cursor reads the repository's own .cursor/mcp.json; run this Bot on Server to use Jack tools",
  cursorFileNotOurs: "This Bot workspace has a .cursor/mcp.json that Tentacles did not write; remove it, then send again",
  codexChanged: "Codex home config changed while trusting this Bot workspace; try again",
});
