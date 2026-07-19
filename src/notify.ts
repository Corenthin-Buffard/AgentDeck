import { config } from "./config.ts";
import type { Task } from "./types.ts";

// Notification-only (A3 decision): the bots SEND, they never receive commands.
// The reply happens in the dashboard (behind the SSH tunnel). So there is no
// bot-side authorization to get wrong — you just keep the token secret.

type Reason = "waiting" | "done" | "error";

function line(task: Task, reason: Reason): string {
  switch (reason) {
    case "waiting": return `🟠 ${task.title} attend ta réponse (phase ${task.phase}).`;
    case "done":    return `✅ ${task.title} terminé.`;
    case "error":   return `🔴 ${task.title} — erreur : ${task.error ?? "inconnue"}`;
  }
}

export function notify(task: Task, reason: Reason): void {
  const text = line(task, reason);
  const tg = config.notify.telegram;
  if (tg) {
    fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text }),
    }).catch((e) => console.error("[notify] telegram failed:", e.message));
  }
  const slack = config.notify.slack;
  if (slack) {
    fetch(slack.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch((e) => console.error("[notify] slack failed:", e.message));
  }
  if (!tg && !slack) console.log(`[notify:stdout] ${text}`);
}
