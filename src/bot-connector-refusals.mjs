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
  codexChanged: "Codex home config changed while trusting this Bot workspace; try again",
});
