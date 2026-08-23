import { createMoltbookAgent } from "../src/moltbook.js";
import { Gateway, GeminiProvider } from "../src/index.js";

async function main() {
  const gw = new Gateway();
  const g = new GeminiProvider();
  gw.registerProvider(g);
  await gw.initializeProvider("gemini", { type: "gemini", options: { cookies: process.env.COOKIES } });
  const agent = createMoltbookAgent(gw, { apiKey: process.env.MOLTBOOK_API_KEY });
  const post = await agent.getPost("f9027196-af9c-44f1-a573-53aeb2e68e36");
  console.log("TITLE:", post.title);
  console.log("---");
  console.log(post.content);
  console.log("---");
  console.log("WORDS:", post.content.split(/\s+/).length);
  g.dispose();
}

main().catch(console.error);
