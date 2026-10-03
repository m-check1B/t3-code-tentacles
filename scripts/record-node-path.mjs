import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Run with the release's selected Node before linking either public alias.
const destination = fileURLToPath(new URL("../bin/node-path", import.meta.url));
fs.writeFileSync(destination, `${fs.realpathSync(process.execPath)}\n`, { mode: 0o600, flag: "wx" });
