
import express from "express";
import cors from "cors";
import pg from "pg";
import webpush from "web-push";

const app = express();
const { Pool } = pg;

app.use(cors({
  origin: "https://prabha-030.github.io"
}));
app.use(express.json({ limit: "20kb" }));

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

app.get("/", (_req, res) => {
  res.json({ status: "To-Do reminder backend running" });
});

app.get("/vapid-public-key", (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post("/subscribe", async (req, res) => {
  try {
    const sub = req.body;

    if (
      !sub?.endpoint?.startsWith("https://") ||
      !sub?.keys?.p256dh ||
      !sub?.keys?.auth
    ) {
      return res.status(400).json({ error: "Invalid subscription" });
    }

    await db.query(
      `INSERT INTO subscriptions(endpoint, subscription)
       VALUES($1, $2)
       ON CONFLICT(endpoint)
       DO UPDATE SET subscription = EXCLUDED.subscription`,
      [sub.endpoint, JSON.stringify(sub)]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Subscribe failed:", error);
    res.status(500).json({ error: "Could not save subscription" });
  }
});

app.post("/reminders", async (req, res) => {
  try {
    const { subscription, taskText, dueAt } = req.body;

    if (
      !subscription?.endpoint ||
      typeof taskText !== "string" ||
      !taskText.trim() ||
      taskText.length > 300 ||
      typeof dueAt !== "string" ||
      !Number.isFinite(Date.parse(dueAt)) ||
      Date.parse(dueAt) <= Date.now()
    ) {
      return res.status(400).json({ error: "Invalid reminder details" });
    }

    const result = await db.query(
      `SELECT id FROM subscriptions WHERE endpoint = $1`,
      [subscription.endpoint]
    );

    if (!result.rowCount) {
      return res.status(400).json({
        error: "Enable push notifications first"
      });
    }

    await db.query(
      `INSERT INTO reminders(subscription_id, task_text, due_at)
       VALUES($1, $2, $3)`,
      [result.rows[0].id, taskText.trim(), new Date(dueAt).toISOString()]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Reminder save failed:", error);
    res.status(500).json({ error: "Could not save reminder" });
  }
});

// Process due reminders. The database prevents the reminder
// from being selected again once sent_at is set.
async function processReminders() {
  const due = await db.query(
    `SELECT r.id, r.task_text, s.subscription
     FROM reminders r
     JOIN subscriptions s ON s.id = r.subscription_id
     WHERE r.sent_at IS NULL AND r.due_at <= NOW()
     ORDER BY r.due_at
     LIMIT 50`
  );

  for (const row of due.rows) {
    try {
      await webpush.sendNotification(
        row.subscription,
        JSON.stringify({
          title: "🔔 To-Do Reminder",
          body: "Task complete cheyyali: " + row.task_text,
          url: "https://prabha-030.github.io/To-Do-List-project/"
        }),
        { TTL: 3600 }
      );

      await db.query(
        "UPDATE reminders SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL",
        [row.id]
      );
    } catch (error) {
      console.error("Push failed for reminder", row.id, error.statusCode);

      if (error.statusCode === 404 || error.statusCode === 410) {
        await db.query(
          "DELETE FROM subscriptions WHERE endpoint = $1",
          [row.subscription.endpoint]
        );
      }
    }
  }
}

setInterval(() => {
  processReminders().catch((error) => {
    console.error("Scheduler error:", error);
  });
}, 15000);

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log("Reminder backend listening on", port);
});
