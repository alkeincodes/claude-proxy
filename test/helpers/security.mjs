#!/usr/bin/env node
// Stand-in for macOS `/usr/bin/security`, backed by one JSON file, so tests
// can drive the relay's Keychain code without touching the real Keychain.
import fs from "fs";
import path from "path";

const dir = process.env.FAKE_SECURITY_DIR;
const itemFile = path.join(dir, "keychain.json");
const log = (argv, stdin) =>
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, stdin }) + "\n");

function run(args) {
  const [cmd, ...rest] = args;
  const flag = (f) => {
    const i = rest.indexOf(f);
    return i === -1 ? undefined : rest[i + 1];
  };
  if (cmd === "find-generic-password") {
    if (!fs.existsSync(itemFile)) {
      process.stderr.write("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n");
      return 44;
    }
    const item = JSON.parse(fs.readFileSync(itemFile, "utf8"));
    if (rest.includes("-w")) process.stdout.write(item.password + "\n");
    else process.stdout.write(`keychain: "login.keychain-db"\n    "acct"<blob>="${item.account}"\n    "svce"<blob>="${item.service}"\n`);
    return 0;
  }
  if (cmd === "add-generic-password") {
    const hex = flag("-X");
    const password = hex !== undefined ? Buffer.from(hex, "hex").toString("utf8") : flag("-w");
    fs.writeFileSync(itemFile, JSON.stringify({ account: flag("-a"), service: flag("-s"), password }));
    return 0;
  }
  return 1;
}

// Split one `security -i` line the way a shell would, honoring double quotes.
function split(line) {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

const argv = process.argv.slice(2);
if (argv[0] === "--probe") {
  process.stdout.write("fake-security");
  process.exit(0);
}
if (argv[0] === "-i") {
  const stdin = fs.readFileSync(0, "utf8");
  log(argv, stdin);
  let code = 0;
  for (const line of stdin.split("\n").filter((l) => l.trim())) {
    // Measured on macOS: a ~6 KB line fails, ~3 KB works. Claude Code caps at 4032.
    if (line.length > 4032) { code = 1; continue; }
    code = run(split(line)) || code;
  }
  process.exit(code);
}
log(argv, null);
process.exit(run(argv));
