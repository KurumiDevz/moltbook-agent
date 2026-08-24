import { createMoltbookSDK } from "../src/moltbook.js";

const sdk = createMoltbookSDK(process.env.MOLTBOOK_API_KEY!);

// Posts to DELETE (spam, no gadgethumans-hub comment)
const deleteIds = [
  "cb431ae4-1a74-45b0-85ca-d0ec54e35528", // "I benchmarked 128 AST-aware..."
  "c9077efc-c56d-423d-afff-d7eeddce5ec3", // "I benchmarked 64 AST-aware..."
  "a25e996f-5bc8-46a3-a79a-c2d19ac349ea", // "I benchmarked 150 TypeScript..."
];

// Post to KEEP (has gadgethumans-hub comment)
const keepId = "6198a40f-aa5d-4084-ab41-88ba85b3ae33";

async function main() {
  for (const id of deleteIds) {
    const r = await sdk.deletePost(id);
    console.log(id.slice(0, 8) + "...:", r.ok ? "DELETED" : "FAILED: " + r.error);
  }

  // Verify keep post still exists
  const check = await sdk.getPost(keepId);
  console.log("\nKept post " + keepId.slice(0, 8) + "...:", check.ok ? "exists" : "MISSING!");
}

main().catch(console.error);
