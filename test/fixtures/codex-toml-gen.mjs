// KRA-10891 (B3 P2-1/P2-2 on #117): synthetic Codex config.toml files built from a
// fixed seed, with the clash put in (or not) after the noise. The expected answer comes
// from how the file was built, so the reader's test needs no Codex.
const PIECES = [
  '"a \\" [x] {y} # z"',
  "'lit \" [x] {y} # z'",
  '"""\n[x]\nmcp_servers.jack.command = "fake"\n"""',
  '"""q""""',
  '"""say "hi"""""',
  '"""a \\""" [x]\n{y}"""',
  "'''\n[x]\n'''",
  "'''q''''",
  "''''q'''''",
  '""',
  "''",
  '"""\\\n  [x]"""',
];
const CLASHES = [
  { text: '[mcp_servers.jack]\ncommand = "x"\n', topLevel: false },
  { text: 'mcp_servers.jack.command = "x"\n', topLevel: true },
  { text: '[mcp_servers]\njack = { command = "x" }\n', topLevel: false },
];
const DECOYS = ['[mcp_servers.other]\ncommand = "x"\n', '[other]\njack = { command = "x" }\n', ""];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** `count` files `{ text, clash }`; the same seed always gives the same files. */
export function codexTomlFiles(count = 200, seed = 10891) {
  const random = rng(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  const value = level => {
    const roll = random();
    if (level < 2 && roll < 0.25) return `[\n  ${[value(level + 1), value(level + 1)].join(",\n  ")},\n  [${value(level + 1)}],\n]`;
    if (level < 2 && roll < 0.45) return `{ a = ${value(level + 1)}, b = [\n${value(level + 1)}\n] }`;
    if (level < 2 && roll < 0.65) return `[${value(level + 1)}, ${value(level + 1)}, ${value(level + 1)}]`;
    if (level < 2 && roll < 0.75) return `{ a = ${value(level + 1)}, b = ${value(level + 1)} }`;
    return pick(PIECES);
  };
  return Array.from({ length: count }, (_, n) => {
    const lines = [];
    for (let k = 0, entries = 1 + Math.floor(random() * 4); k < entries; k += 1) {
      if (random() < 0.4) lines.push(`# comment " ''' """ [x] {y} ${k}`);
      lines.push(`k${k} = ${value(0)}${random() < 0.3 ? " # trailing \" ' [x]" : ""}`);
    }
    const clash = n % 2 === 0;
    const tail = clash ? pick(CLASHES).text : pick(DECOYS);
    let text = `${lines.join("\n")}\n${tail}`;
    if (random() < 0.3) text = text.replace(/\n/g, "\r\n");
    return { text, clash };
  });
}
