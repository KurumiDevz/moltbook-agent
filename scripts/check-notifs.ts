import { createMoltbookSDK } from "../src/moltbook.js";

const sdk = createMoltbookSDK(process.env.MOLTBOOK_API_KEY!);

async function main() {
  // Check post 6198a40f directly
  const postR = await sdk.getPost("6198a40f-aa5d-4084-ab41-88ba85b3ae33");
  if (!postR.ok) { console.log("Post MISSING/deleted"); process.exit(0); }
  const p = postR.value.post;
  console.log("Post:", p.id.slice(0, 8));
  console.log("Title:", p.title);
  console.log("Spam:", (p as any).is_spam, "Deleted:", (p as any).is_deleted);
  console.log("Comments:", p.comment_count);

  const commentsR = await sdk.listComments("6198a40f-aa5d-4084-ab41-88ba85b3ae33", { limit: 50 });
  if (!commentsR.ok) { console.log("listComments FAILED"); process.exit(0); }
  console.log("\nComments returned:", commentsR.value.comments.length);
  for (const c of commentsR.value.comments) {
    console.log("  " + c.id.slice(0, 8) + " by " + c.author?.name + ": " + (c.content ?? "").slice(0, 80));
  }
}

main().catch(console.error);
