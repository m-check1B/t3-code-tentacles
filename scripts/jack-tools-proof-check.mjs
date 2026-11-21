// The PASS checks of scripts/jack-tools-proof.mjs, kept apart so a test can run them.
import vm from "node:vm";

// JavaScript tokens of OpenCode's execute code: comments dropped, strings kept as values.
export function tokens(code) {
  const out = [];
  for (let i = 0; i < code.length;) {
    const c = code[i];
    if (code.startsWith("//", i)) { i = code.indexOf("\n", i); if (i < 0) break; continue; }
    if (code.startsWith("/*", i)) { i = code.indexOf("*/", i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, value = "";
      while (j < code.length && code[j] !== c) { if (code[j] === "\\") j += 1; value += code[j]; j += 1; }
      out.push(["string", c === "`" ? null : value]); // a template is never the server key
      i = j + 1; continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 200));
    if (word) { out.push(["name", word[0]]); i += word[0].length; continue; }
    if (!/\s/.test(c)) out.push(["punct", c]);
    i += 1;
  }
  return out;
}
// tools [ "microsoft-learn" ] . <tool> ( — a real call, not a mention in a string or comment.
export function codeCallsServer(code) {
  try { new vm.Script(`(async () => {\n${code}\n})`); } catch { return false; }
  const t = tokens(code);
  return t.some((token, i) => token[0] === "name" && token[1] === "tools" && t[i - 1]?.[1] !== "."
    && t[i + 1]?.[1] === "[" && t[i + 2]?.[0] === "string" && t[i + 2][1] === "microsoft-learn"
    && t[i + 3]?.[1] === "]" && t[i + 4]?.[1] === "." && t[i + 5]?.[0] === "name" && t[i + 6]?.[1] === "(");
}
const SERVER = /^(?:mcp__)?(?:[a-z0-9-]+_)?microsoft[-_]learn(?:__|$|_)/i;
export function callsServer(item) {
  if (item.status !== "completed" || !["dynamic_tool", "mcp_tool_call"].includes(item.type)) return false;
  const source = item.toolSource ?? {};
  if (source.key === "mcp:microsoft-learn" || source.name === "microsoft-learn") return true;
  if (typeof item.toolName === "string" && SERVER.test(item.toolName)) return true;
  // OpenCode 2 runs MCP tools inside its code-mode execute tool.
  return item.toolName === "execute" && codeCallsServer(String(item.input?.code ?? ""));
}
// Anything that moves the session or touches a path outside the Bot workspace.
export function leavesWorkspace(item, workspace) {
  const text = JSON.stringify(item.input ?? "");
  if (/session_move|session\.move/i.test(text)) return true;
  // The root itself (`find /`) or any absolute or ~ path; a URL's `//` never matches.
  if (/(?<![\w:/.\\-])\/(?=\s|\\"|'|$)/.test(text)) return true;
  for (const [, found] of text.matchAll(/(?<![\w:/.\\-])((?:\/|~\/)[\w.@%+-]+(?:\/[\w.@%+-]*)*)/g)) {
    if (!found.startsWith(`${workspace}/`) && found !== workspace) return true;
  }
  return false;
}
