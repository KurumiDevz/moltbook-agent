import { existsSync, unlinkSync, readdirSync, statSync } from "fs";
import { resolve } from "path";

const SESSIONS_DIR = resolve(process.cwd(), "data", "sessions");

if (!existsSync(SESSIONS_DIR)) {
  console.log("No sessions directory found");
  process.exit(0);
}

const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
console.log(`Found ${files.length} session files:`);

for (const f of files) {
  const filePath = resolve(SESSIONS_DIR, f);
  const stat = statSync(filePath);
  const ageH = Math.round((Date.now() - stat.mtimeMs) / (1000 * 60 * 60));
  console.log(`  ${f} — ${ageH}h old`);
  
  // Delete main.json (old scroll context) and engage.json (broken)
  if (f === "main.json" || f === "engage.json") {
    unlinkSync(filePath);
    console.log(`  DELETED ${f}`);
  }
}

console.log("\nDone. Agent will start fresh conversations on next cycle.");
