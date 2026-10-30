# AI SalesMail API

Node.js 22 / Express / MongoDB API. Each signed-in user owns their campaigns and templates. Existing records without an owner are hidden until explicitly migrated.

## Local setup

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and fill in your settings.
3. For local development, set `FRONTEND_URL=http://localhost:5173` and `SERVER_URL=http://localhost:3000`. Start MongoDB and run `npm run dev`.
4. Open `http://localhost:3000/health`.

Required configuration:
- `MONGO_URI`: MongoDB connection string.
- `JWT_SECRET`: a long random signing secret.
- `FRONTEND_URL`: comma-separated exact frontend origins (no paths), including localhost for development.
- `SERVER_URL`: public backend origin, without a path. Tracking links use this origin.
- `EMAIL_USER` and `EMAIL_PASS`: the configured sender mailbox and its app password.
- `TRACKING_SECRET`: a separate long random secret for tracking signatures.
- `CRON_SECRET`: a separate random secret protecting scheduled processing.

Optional configuration:
- `SMTP_HOST`, `SMTP_PORT` (465 for implicit TLS, 587 for STARTTLS), `IMAP_HOST`.
- `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`: an OpenAI-compatible chat completion provider. The default URL is xAI. Choose a model available to your account; no model is silently assumed. Manual email templates work without AI.

The old hardcoded provider credential has been removed. Revoke it in the provider dashboard, since deletion from source does not revoke it or remove it from Git history. Do not put mailbox credentials or AI keys in the frontend.

## Deploy on Vercel

Import this repository as a separate Vercel project. If importing the parent workspace, use `ai-sales-mail-backend` as the Root Directory. Use the Express framework and Node.js 22. The root `index.js` exports the Express application; it only listens on a port during local execution. Vercel uses its native Express integration, so no legacy builds/routes configuration is needed.

Add all required environment variables in Vercel, then deploy. Set `FRONTEND_URL=https://ai-sales-mail-frontend.vercel.app` and `SERVER_URL=https://ai-sales-mail-backend-ten.vercel.app`. These deployment URLs are already filled in both backend environment files. If your deployment URLs are not known initially, update the values and redeploy after both projects exist. Preview frontend origins must be explicitly included to use the backend. Configure your MongoDB provider to allow connections from your deployment and use a dedicated database user.

Use Fluid compute with a function duration of 300 seconds (the documented default). Background work finishes within the request; the job worker limits its processing window and sends at most 25 messages per invocation. There are no background timers or unawaited email tasks.

The included cron runs at 08:00 UTC once per day so the configuration can deploy on Hobby. Hobby cron timing is approximate. **For timely delivery, inbox replies, and campaigns larger than 25 recipients, use a more frequent scheduler**: on a plan supporting it, change `schedule` to `*/5 * * * *`; alternatively call `GET /api/cron/process` from an external scheduler with `Authorization: Bearer <CRON_SECRET>`. Cron runs automatically on production deployments. Keep backend deployment protection compatible with scheduled calls and public tracking pixels.

The queue persists in MongoDB. The worker holds a database lease to prevent overlapping runs. Failed sends retry at most three times. A send interrupted after SMTP acceptance remains in a `sending` state and eventually shows `attention`; review the mailbox and that recipient's database state before retrying. SMTP cannot guarantee exactly-once delivery when acceptance is ambiguous. Never reset every recipient indiscriminately.

Reply matching uses the original sent message ID plus the sender address, rather than a tracking image in quoted HTML. It examines up to 50 unread messages from the last 30 days per invocation, marks only matched messages as read, and avoids responding to automatic messages. Use a dedicated sender inbox and keep campaign replies unread until processed. One automated acknowledgement and one follow-up are sent per recipient. Follow-ups go only to recipients who have not replied after the configured number of days. Mail-provider policies and outbound SMTP/IMAP availability still need a live deployment check.

## Tests

Run `npm test` for isolated integration tests. They start a temporary MongoDB instance, exercise HTTP endpoints, validate ownership and tracking, and use a fake mail transport; they do not send real mail or call AI. The first run downloads MongoDB to `.cache/mongodb`. Network access is required for that first download.

## Legacy data

No records are claimed automatically. For a database previously used by one owner:

```sh
node scripts/claim-legacy-data.js --user-email owner@example.com
node scripts/claim-legacy-data.js --user-email owner@example.com --apply
```

The first command is a dry run. Back up the database and verify the counts and owner before using `--apply`. For a database shared by multiple people, assign records individually after identifying their owners; do not use this bulk script. Historical mail lacks the new message IDs and signed tracking links, so reliable reply matching and signed open tracking apply to newly sent mail.
