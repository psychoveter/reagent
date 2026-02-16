import { readFileSync } from "node:fs";
import { parseProgram } from "./parser.js";

function main() {
  const [cmd, file] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error("Usage: cli.js parse <file>");
    process.exit(2);
  }
  if (cmd !== "parse") {
    console.error(`Unknown command: ${cmd}`);
    process.exit(2);
  }
  const src = readFileSync(file, "utf8");
  const res = parseProgram(src);
  if (!res.ok) {
    console.error(JSON.stringify(res.error, null, 2));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(res.ast, null, 2) + "\n");
}

main();

