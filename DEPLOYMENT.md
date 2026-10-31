# VPS deployment with PM2 and Nginx

The API listens on **127.0.0.1:5921**. Nginx serves both:

- `ai-sales-backend.omnisuiteai.com`
- `www.ai-sales-backend.omnisuiteai.com`

The deployment uses your existing Node.js, npm, Git, PM2, Nginx, Bash and standard Linux tools. It does not install system packages or global npm packages. Production application dependencies are installed from the lockfile in each new release using `npm ci --omit=dev`. Supported runtimes are Node.js 22.12+ and Node.js 24.

## First deployment

Point the A records for both hostnames to your VPS. If you publish AAAA records, they must point to the working IPv6 address of this same server. Allow incoming HTTP/HTTPS; the Node port remains bound to loopback.

Use the Unix account that should own the PM2 processes. The script uses `sudo` for Nginx and logrotate files when the account is not root. Do not alternate between `pm2` and `sudo pm2`: those manage different PM2 process lists.

Clone the backend to any directory writable by that account, for example:

```bash
git clone https://github.com/macworldgithub/ai-sales-mail-backend.git ~/ai-sales-mail-backend
cd ~/ai-sales-mail-backend
install -m 600 .env.example .env
nano .env
```

Fill in `MONGO_URI`, `EMAIL_USER`, `EMAIL_PASS`, and the signing secrets. For an existing deployment, copy the existing JWT, tracking and cron secrets instead of regenerating them. Existing login tokens and tracking signatures depend on those values. The script preserves `.env` across deployments and restricts it to the deployment account.

The important VPS settings are already provided in the example:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=5921
TRUST_PROXY=loopback
SERVER_URL=https://ai-sales-backend.omnisuiteai.com
FRONTEND_URL=https://ai-sales-mail-frontend.vercel.app
WORKER_INTERVAL_MS=60000
EXTERNAL_CRON_ENABLED=false
```

`FRONTEND_URL` accepts comma-separated exact origins if more than one frontend uses this API. AI configuration is optional; manual templates work without an AI key. MongoDB must allow connections from your VPS address. The sender's SMTP and IMAP services must allow connections from the VPS as well.

If a valid certificate covering both domains already exists under `/etc/letsencrypt/live/ai-sales-backend.omnisuiteai.com`, run:

```bash
bash deploy.sh --https
```

If the certificate is not present yet, bootstrap HTTP first:

```bash
bash deploy.sh --http
```

HTTP bootstrap starts the API but keeps the mail worker paused. Activate HTTPS before cutting over the frontend or releasing queued mail.

Then use your existing certificate tooling. With Certbot already installed:

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d ai-sales-backend.omnisuiteai.com \
  -d www.ai-sales-backend.omnisuiteai.com
bash deploy.sh --no-pull --https
```

The deploy script does not install Certbot, accept certificate terms, or request certificates automatically. Once a certificate exists, normal deployments automatically select the HTTPS configuration and start the mail worker. An existing HTTPS site is not automatically downgraded if its certificate goes missing. The HTTP listener preserves ACME renewal access and redirects API requests to HTTPS with HTTP 308. Keep your existing certificate renewal service enabled; renewal must reload Nginx after replacing the certificate. For Certbot, an existing deploy hook can run `nginx -t && nginx -s reload` after successful renewal.

If a PM2 startup service is not already configured, run `pm2 startup`, execute the command it prints for this same account, then run `pm2 save`. The deployment script runs `pm2 save` after every successful release.

## Redeployment and rollback

Run the same command from the source checkout:

```bash
bash deploy.sh
```

By default it fast-forwards `origin/main`. To deploy the already checked-out commit without contacting Git:

```bash
bash deploy.sh --no-pull
```

To reactivate the previous successful release:

```bash
bash deploy.sh --rollback
```

The script does the following:

1. Checks the existing tools and takes a deployment lock.
2. Exports committed source into a new `.deploy/releases/` directory. Git-ignored environment files, caches and development dependencies are not copied into releases.
3. Links the shared private `.env`, installs production app dependencies, validates configuration and JavaScript syntax, creates declared MongoDB indexes, and verifies SMTP authentication **without sending mail**. A failure here leaves the running release untouched.
4. Backs up and installs this app's Nginx site and shared snippet, creates the `sites-enabled` symlink, and runs `nginx -t` before reloading anything.
5. Lets an active worker batch finish, switches the `current` release link, and starts/reloads the API through PM2. Both PM2 processes wait for database readiness before announcing they are ready.
6. Verifies the API's database readiness and release identity on port 5921, reloads Nginx, and verifies both hostnames through the proxy. HTTPS checks validate the certificate and both names.
7. Starts the persistent worker, checks both PM2 processes, installs application log rotation, saves PM2 state, and retains five releases plus the active rollback target.

If activation, readiness or proxy checks fail, the script attempts to restore the previous application and Nginx files. The failed release is kept for inspection. Initial deployments have no previous application to restore. Rollback changes code and proxy configuration; it does not reverse sent emails, database indexes, data changes, or edits to the shared `.env`.

PM2 uses one forked API process, so a restart can cause a short interruption while the API switches releases. Active requests and mail batches are allowed to finish before process exit; PM2 has a four-minute shutdown allowance. This setup does not promise zero downtime.

## Nginx files and symlink

The script installs the selected HTTP or HTTPS file as:

```text
/etc/nginx/sites-available/ai-sales-mail-backend
/etc/nginx/snippets/ai-sales-mail-backend.conf
```

It creates the activation link automatically:

```bash
sudo ln -sfn /etc/nginx/sites-available/ai-sales-mail-backend \
  /etc/nginx/sites-enabled/ai-sales-mail-backend
sudo nginx -t
sudo nginx -s reload
```

No default site or other application's site is removed. Make app-specific Nginx changes in `deploy/nginx/` and commit them before redeploying; deployment replaces the generated server files from those templates. Do not enable both the HTTP and SSL templates as separate sites: the script selects exactly one.

## PM2, scheduling, and logs

The two PM2 process names are `ai-sales-mail-api` and `ai-sales-mail-worker`. The API is private to Nginx on port 5921. The worker checks for due mail every minute, runs immediately at startup, avoids overlapping batches, and waits for an active batch during shutdown. MongoDB leases and recipient claims also prevent concurrent workers from sending the same claimed recipient. SMTP acceptance can still be ambiguous after a connection failure; such recipients are held for review instead of automatically resent.

```bash
pm2 status
pm2 logs ai-sales-mail-api --lines 100
pm2 logs ai-sales-mail-worker --lines 100
curl --fail http://127.0.0.1:5921/ready
```

Application logs live in `.deploy/logs/`. The script installs `/etc/logrotate.d/ai-sales-mail-backend` for 14 daily compressed rotations using your existing logrotate service. Nginx logs live in `/var/log/nginx/ai-sales-mail-backend.*.log` and use the existing Nginx log rotation policy. Access logs omit tracking query parameters. Server-side error logging redacts configured credentials.

The public `/health` endpoint reports whether the API responds. `/ready` reports database connectivity and the active release. The protected `/api/cron/status` endpoint remains available for worker status. External `/api/cron/process` calls are disabled on the PM2 production deployment; the worker does not depend on GitHub Actions, Vercel cron, or an open browser.

## Cut over the existing frontend and scheduler

After HTTPS and readiness pass on the VPS:

1. Set the frontend Vercel variable `VITE_API_URL=https://ai-sales-backend.omnisuiteai.com` and redeploy the frontend. Vite embeds this value at build time. The example configuration targets the VPS; the existing source fallback keeps the previous Vercel API until this explicit cutover.
2. Disable the old backend repository's **Process scheduled mail** GitHub Actions workflow and the old backend project's Vercel cron. This prevents the previous Vercel backend from continuing to process this database. The VPS worker replaces both schedulers.
3. Keep the previous tracking endpoint available if existing emails link to the old Vercel hostname, or arrange a redirect/proxy from it to the new API. Preserve `TRACKING_SECRET` for existing signatures. New messages use the VPS `SERVER_URL`.

## Optional path settings

Set variables before running the script when your existing server uses different locations:

```bash
DEPLOY_ROOT=/srv/ai-sales-mail \
ENV_FILE=/srv/ai-sales-mail.env \
NGINX_AVAILABLE_DIR=/etc/nginx/sites-available \
NGINX_ENABLED_DIR=/etc/nginx/sites-enabled \
NGINX_SNIPPETS_DIR=/etc/nginx/snippets \
bash deploy.sh
```

The same settings must be used on later deployments and rollbacks. Additional options are `DEPLOY_BRANCH`, `DEPLOY_REMOTE`, `KEEP_RELEASES`, `ACME_WEBROOT`, `TLS_DIRECTORY`, and `LOGROTATE_DIR`. The Nginx certificate directory must contain `fullchain.pem` and `privkey.pem`. The shared `.env`, source checkout and deployment state should be owned by the PM2 account. The script expects the usual Debian/Ubuntu Nginx layout, with `sites-enabled` included by the main Nginx configuration; its proxy readiness checks fail and roll back if the site is not being served.
