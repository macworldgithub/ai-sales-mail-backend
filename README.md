# AI SalesMail API

Express / MongoDB backend for personalized email campaigns, tracking, automated replies and scheduled follow-ups.

Recipient personalization is resolved when mail is sent, including scheduled campaigns, replies, and follow-ups. Missing or blank fields (including `N/A`) use a neutral greeting and omit sentences that depend on unavailable details. Names, company names, and designations are never invented. Optional phrases can use `{{Company|your organization}}`. Field names support common case, spacing, and naming variants such as `First Name`, `first_name`, and `Designation`/`Job Title`.

The authenticated `POST /email/preview` endpoint accepts `subject`, `body`, `closing`, and one spreadsheet `recipient`; it returns `emailContent` and `missingFields` using the same renderer as delivery, without sending mail. The frontend Review step uses it to preview each recipient. Sender signatures use `{{Sender Email}}` and optionally `{{Sender Name}}`; configure `EMAIL_FROM_NAME` for a display name. Recipient identity placeholders are omitted from signature-only lines after a sign-off so the recipient is not mistaken for the sender.

## Production VPS deployment

Use [DEPLOYMENT.md](DEPLOYMENT.md) for the complete PM2 and Nginx deployment procedure.

- API: `127.0.0.1:5921`
- Public API: `https://ai-sales-backend.omnisuiteai.com`
- Alias: `https://www.ai-sales-backend.omnisuiteai.com`
- PM2: one API process and one persistent worker.
- Scheduler: the worker checks due campaigns every minute.
- Deployment: `bash deploy.sh` for first deployment and later updates.
- Rollback: `bash deploy.sh --rollback`.
- Existing server tools are used; no system packages, global dependencies or Docker are installed.

The deployment script stages committed source in isolated release directories, installs only production application dependencies, verifies MongoDB/indexes and SMTP authentication without sending mail, configures and symlinks Nginx, validates readiness, saves PM2 state and configures log rotation. See the deployment guide for HTTPS bootstrap and migration from Vercel.

## Configuration

Copy `.env.example` to `.env` and fill in MongoDB, mailbox credentials, and distinct JWT, tracking and cron secrets. Keep the same secrets when migrating an existing deployment so tokens and signed tracking links remain valid. Private environment files are ignored by Git.

Required variables: `MONGO_URI`, `JWT_SECRET`, `TRACKING_SECRET`, `CRON_SECRET`, `FRONTEND_URL`, `SERVER_URL`, `EMAIL_USER`, `EMAIL_PASS`.

The example already sets production defaults for port 5921, loopback binding, the VPS domain, trusted loopback proxy, a one-minute worker interval and disabled external cron.

Optional provider settings:

- `SMTP_HOST`, `SMTP_PORT` (465 for implicit TLS, 587 for STARTTLS), `IMAP_HOST`.
- `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` for an OpenAI-compatible chat-completion provider. The default endpoint is xAI. Templates can be entered manually without AI.

## Local development

Use Node.js 22.12+ or 24. Run `npm ci`, fill in `.env`, and set local values:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=5921
SERVER_URL=http://localhost:5921
FRONTEND_URL=http://localhost:5173
```

Run `npm run dev` for the API and `npm run worker` separately for background mail processing. Point the frontend's `VITE_API_URL` to `http://localhost:5921` when using the local API.

Useful commands:

```sh
npm run check:config
npm run preflight
npm start
npm run worker
npm test
```

`preflight` checks configuration, creates declared MongoDB indexes, and verifies database and SMTP access without sending mail. It uses the configured environment; run it against the intended database. Production disables automatic index creation during normal API/worker startup; deployment performs that step explicitly.

## Campaign delivery

Each signed-in user owns their campaigns and templates. A campaign can send now or store a future UTC `scheduledAt`; the worker never claims an initial email before that time. Owners can change queued campaign schedules until delivery starts. `POST /campaigns/:id/process` handles only the owner's requested campaign for immediate delivery.

Mail batches are limited to 25 attempts. Database leases and atomic recipient claims prevent overlapping workers from claiming the same message. Definitive failures retry at most three times. If SMTP acceptance is uncertain, the recipient remains held for review; inspect the sender mailbox before manually retrying. Code rollback does not reverse already sent messages.

Reply matching uses the original message ID and recipient address. The worker examines up to 50 unread messages from the last 30 days, marks only matched messages as read, and skips automatic messages. Use a dedicated sender inbox and leave replies unread until processed. Each recipient can receive one automated acknowledgement and one follow-up. Follow-ups go only to recipients who have not replied after the configured delay.

## Compatibility and migration

`index.js` continues to export the Express app for the previous Vercel deployment. Server processes use `server.js`; PM2 manages `worker.js` on the VPS. External cron processing is disabled on the PM2 production configuration. The legacy GitHub workflow and Vercel configuration are retained so the existing backend can continue operating during migration; disable their scheduled triggers after the VPS is healthy, as described in DEPLOYMENT.md.

Existing records without an owner remain hidden until explicitly migrated. For a legacy database belonging to a single owner:

```sh
node scripts/claim-legacy-data.js --user-email owner@example.com
node scripts/claim-legacy-data.js --user-email owner@example.com --apply
```

The first command is a dry run. Back up the database and verify the counts and owner before applying. For a database shared by multiple people, assign records individually after identifying their owners. Historical mail may lack the new message IDs and signed tracking links.

## Tests

`npm test` runs isolated integration and runtime tests. They use a temporary MongoDB database, fake mail transport, and fake background jobs. They do not send real emails or call AI. The first run downloads a MongoDB binary into `.cache/mongodb`.

Bash syntax can be checked with `bash -n deploy.sh`. The deployment itself runs the server's real `nginx -t`, configuration checks, database/SMTP preflight, and direct/proxied readiness checks.
