import { createMoltbookSDK } from "../src/moltbook.js";

const sdk = createMoltbookSDK(process.env.MOLTBOOK_API_KEY!);

async function main() {
  const me = await sdk.getMe();
  if (!me.ok) { console.log("FAILED"); process.exit(1); }
  const myId = me.value.id;
  const myName = me.value.name;
  console.log("Agent:", myName);

  // Check all posts from notifications
  const notifR = await sdk.getNotifications({ limit: 100 });
  if (!notifR.ok) { console.log("notif FAILED"); process.exit(1); }
  const postIds = [...new Set(notifR.value.notifications.map((n: any) => n.relatedPostId).filter(Boolean))];
  console.log("Posts with notifications:", postIds.length);

  let totalComments = 0;
  let toDelete: { id: string; postId: string; content: string; reason: string }[] = [];
  let keep: { id: string; postId: string; content: string }[] = [];

  for (const postId of postIds) {
    // Check if post still exists
    const postR = await sdk.getPost(postId);
    if (!postR.ok) {
      console.log("\nPost " + postId.slice(0, 8) + "...: DELETED/MISSING (notifications are phantom)");
      continue;
    }
    const post = postR.value.post;
    console.log("\nPost " + postId.slice(0, 8) + "...: " + (post.title ?? "no title").slice(0, 60));
    console.log("  spam flag:", (post as any).is_spam, "deleted:", (post as any).is_deleted);

    // List comments
    const commentsR = await sdk.listComments(postId, { limit: 100 });
    if (!commentsR.ok) continue;
    const comments = commentsR.value.comments;
    console.log("  Comments:", comments.length);

    for (const c of comments) {
      // Check if it's our comment
      const isOurs = c.author?.id === myId || c.author?.name === myName;
      if (!isOurs) continue;
      totalComments++;

      const content = c.content ?? "";
      const isDeleted = content === "Deleted comment" || content.trim() === "" || (c as any).is_deleted === true;
      const isFlagged = (c as any).is_spam === true;

      if (isDeleted || isFlagged) {
        toDelete.push({ id: c.id, postId, content: content.slice(0, 60), reason: isDeleted ? "deleted" : "spam-flagged" });
      } else {
        keep.push({ id: c.id, postId, content: content.slice(0, 60) });
        console.log("    KEEP: " + c.id.slice(0, 8) + "...: " + content.slice(0, 60));
      }

      // Check replies
      if (c.replies?.length) {
        for (const r of c.replies) {
          const rOurs = r.author?.id === myId || r.author?.name === myName;
          if (!rOurs) continue;
          totalComments++;
          const rc = r.content ?? "";
          const rDel = rc === "Deleted comment" || rc.trim() === "" || (r as any).is_deleted === true;
          const rSpam = (r as any).is_spam === true;
          if (rDel || rSpam) {
            toDelete.push({ id: r.id, postId, content: rc.slice(0, 60), reason: rDel ? "deleted" : "spam-flagged" });
          } else {
            keep.push({ id: r.id, postId, content: rc.slice(0, 60) });
            console.log("    KEEP reply: " + r.id.slice(0, 8) + "...: " + rc.slice(0, 60));
          }
        }
      }
    }
  }

  console.log("\n=== Summary ===");
  console.log("Our comments found:", totalComments);
  console.log("Keeping:", keep.length);
  console.log("To delete:", toDelete.length);

  if (toDelete.length === 0) {
    console.log("Nothing to delete!");
    return;
  }

  console.log("\nDeleting:");
  let deleted = 0;
  for (const d of toDelete) {
    const r = await sdk.deleteComment(d.id);
    if (r.ok) {
      deleted++;
      console.log("  DELETED " + d.id.slice(0, 8) + " (" + d.reason + ")");
    } else {
      console.log("  FAILED " + d.id.slice(0, 8));
    }
  }
  console.log("Done:", deleted, "deleted");
}

main().catch(console.error);
