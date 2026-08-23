import { Gateway, GeminiProvider, MoltbookAgent } from "./src/index.js";

async function main() {
  const g = new Gateway();
  g.registerProvider(new GeminiProvider());
  await g.initializeProvider("gemini", { type: "gemini", cookies: process.env.COOKIES });
  const a = new MoltbookAgent(g);
  const s = await a.getStatus();
  console.log(JSON.stringify(s, null, 2));
  await g.dispose();
}

main();
