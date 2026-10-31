#!/usr/bin/env bash
# Existing tools only: no Docker, apt, global npm installs, or database installation.
set -Eeuo pipefail
umask 027

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_ROOT="${DEPLOY_ROOT:-$PROJECT_DIR/.deploy}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
NGINX_AVAILABLE_DIR="${NGINX_AVAILABLE_DIR:-/etc/nginx/sites-available}"
NGINX_ENABLED_DIR="${NGINX_ENABLED_DIR:-/etc/nginx/sites-enabled}"
NGINX_SNIPPETS_DIR="${NGINX_SNIPPETS_DIR:-/etc/nginx/snippets}"
LOGROTATE_DIR="${LOGROTATE_DIR:-/etc/logrotate.d}"
ACME_WEBROOT="${ACME_WEBROOT:-/var/www/letsencrypt}"
TLS_DIRECTORY="${TLS_DIRECTORY:-/etc/letsencrypt/live/ai-sales-backend.omnisuiteai.com}"
SITE_NAME='ai-sales-mail-backend'
API_NAME='ai-sales-mail-api'
WORKER_NAME='ai-sales-mail-worker'
DOMAIN='ai-sales-backend.omnisuiteai.com'
WWW_DOMAIN='www.ai-sales-backend.omnisuiteai.com'
PORT=5921
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_RETRY_SECONDS="${HEALTH_RETRY_SECONDS:-2}"
PULL=1
ROLLBACK_REQUEST=0
TLS_MODE=auto

usage() {
  cat <<'HELP'
Usage: bash deploy.sh [--no-pull] [--https | --http] [--rollback]
  Default: fast-forward origin/main, stage a release, install production app
  dependencies, start/reload PM2, install/link/test Nginx, and check readiness.
  --no-pull   Deploy the current committed HEAD without contacting Git.
  --https     Require the existing certificate for both configured domains.
  --http      Use HTTP, for example before issuing the initial certificate.
  --rollback  Activate the previous successful release without pulling/installing.

Run as the same Unix user that owns the app's PM2 processes. Nginx operations
use sudo when necessary. The script does not install server tools.
HELP
}
for argument in "$@"; do
  case "$argument" in
    --no-pull) PULL=0 ;;
    --https) TLS_MODE=on ;;
    --http) TLS_MODE=off ;;
    --rollback) ROLLBACK_REQUEST=1; PULL=0 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; usage; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for tool in node npm pm2 git tar curl flock install ln readlink mktemp sed find sort mv date chmod id basename cp rm touch sleep grep; do
  command -v "$tool" >/dev/null 2>&1 || die "Required tool is missing: $tool. No tools were installed."
done
NGINX_BIN="$(command -v nginx || true)"
if [[ -z "$NGINX_BIN" && -x /usr/sbin/nginx ]]; then NGINX_BIN=/usr/sbin/nginx; fi
[[ -n "$NGINX_BIN" ]] || die 'Nginx is not available in PATH or /usr/sbin/nginx.'
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (!((major===22 && minor>=12)||major===24)) { console.error("Use the existing Node.js 22.12+ or 24 runtime."); process.exit(1); }'
DEPLOY_USER="$(id -un)"
DEPLOY_GROUP="$(id -gn)"
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] && (( KEEP_RELEASES >= 2 )) || die 'KEEP_RELEASES must be at least 2.'
[[ "$HEALTH_ATTEMPTS" =~ ^[0-9]+$ ]] && (( HEALTH_ATTEMPTS >= 1 )) || die 'HEALTH_ATTEMPTS must be at least 1.'
[[ "$HEALTH_RETRY_SECONDS" =~ ^[0-9]+$ ]] || die 'HEALTH_RETRY_SECONDS must be a nonnegative integer.'
[[ "$DEPLOY_REMOTE" =~ ^[a-zA-Z0-9_.-]+$ ]] || die 'Invalid Git remote name.'
git -C "$PROJECT_DIR" rev-parse --show-toplevel >/dev/null 2>&1 || die 'Run this script from a cloned backend repository.'
git -C "$PROJECT_DIR" check-ref-format --branch "$DEPLOY_BRANCH" >/dev/null
for directory in "$NGINX_AVAILABLE_DIR" "$NGINX_ENABLED_DIR" "$NGINX_SNIPPETS_DIR" "$LOGROTATE_DIR" "$ACME_WEBROOT" "$TLS_DIRECTORY"; do
  [[ "$directory" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'Nginx/certificate directory paths must be absolute and contain only letters, numbers, dots, underscores, slashes, or hyphens.'
done
[[ "$(readlink -m -- "$NGINX_AVAILABLE_DIR")" != "$(readlink -m -- "$NGINX_ENABLED_DIR")" ]] || die 'Nginx sites-available and sites-enabled must be different directories.'
if (( EUID == 0 )); then SUDO=(); else
  command -v sudo >/dev/null 2>&1 || die 'sudo or root access is required for Nginx configuration.'
  sudo -v
  SUDO=(sudo)
fi

mkdir -p -- "$DEPLOY_ROOT"
DEPLOY_ROOT="$(cd -- "$DEPLOY_ROOT" && pwd -P)"
[[ "$DEPLOY_ROOT" != / ]] || die 'DEPLOY_ROOT cannot be the filesystem root.'
RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT="$DEPLOY_ROOT/current"
PREVIOUS="$DEPLOY_ROOT/previous"
mkdir -p -- "$RELEASES_DIR" "$DEPLOY_ROOT/logs" "$DEPLOY_ROOT/backups"
exec 9>"$DEPLOY_ROOT/deploy.lock"
flock -n 9 || die 'Another deployment is already running.'
[[ ! -e "$CURRENT" || -L "$CURRENT" ]] || die 'The current release path must be a symlink, not a directory.'

if [[ ! -f "$ENV_FILE" ]]; then
  install -m 600 "$PROJECT_DIR/.env.example" "$ENV_FILE"
  die "Created $ENV_FILE. Fill in MongoDB, mailbox credentials and distinct secrets, then rerun."
fi
ENV_FILE="$(readlink -f -- "$ENV_FILE")"
chmod 600 -- "$ENV_FILE"

OLD_RELEASE="$(readlink -f -- "$CURRENT" 2>/dev/null || true)"
OLD_WORKER_ACTIVE=0
if [[ -n "$OLD_RELEASE" && -d "$OLD_RELEASE" ]]; then
  [[ "$OLD_RELEASE" == "$RELEASES_DIR/"* ]] || die 'Current release points outside this deployment.'
else
  OLD_RELEASE=''
  # Never overwrite unrelated or manually managed PM2 apps with the same names.
  if pm2 describe "$API_NAME" >/dev/null 2>&1 || pm2 describe "$WORKER_NAME" >/dev/null 2>&1; then
    die 'PM2 app names already exist but this deployment has no current release. Migrate/remove those app entries first.'
  fi
fi
if [[ -n "$OLD_RELEASE" ]] && pm2 jlist | node -e 'let s=""; process.stdin.on("data",x=>s+=x); process.stdin.on("end",()=>process.exit(JSON.parse(s).some(p=>p.name==="ai-sales-mail-worker" && p.pm2_env.status==="online")?0:1));'; then OLD_WORKER_ACTIVE=1; fi

if (( ROLLBACK_REQUEST )); then
  RELEASE="$(readlink -f -- "$PREVIOUS" 2>/dev/null || true)"
  [[ -d "$RELEASE" && "$RELEASE" == "$RELEASES_DIR/"* && "$RELEASE" != "$OLD_RELEASE" ]] || die 'No previous successful release is available.'
  [[ -d "$RELEASE/node_modules" ]] || die 'Previous release dependencies are missing.'
  RELEASE_ID="$(basename -- "$RELEASE")"
else
  git -C "$PROJECT_DIR" diff --quiet && git -C "$PROJECT_DIR" diff --cached --quiet || die 'Commit/stash tracked source changes before deployment. The private .env file is preserved.'
  if (( PULL )); then
    [[ "$(git -C "$PROJECT_DIR" branch --show-current)" == "$DEPLOY_BRANCH" ]] || die "Checkout $DEPLOY_BRANCH in the source repository before deploying."
    say "Updating $DEPLOY_REMOTE/$DEPLOY_BRANCH"
    git -C "$PROJECT_DIR" pull --ff-only "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"
  fi
  REVISION="$(git -C "$PROJECT_DIR" rev-parse --short=12 HEAD)"
  RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$REVISION-$$"
  RELEASE="$RELEASES_DIR/$RELEASE_ID"
  mkdir -- "$RELEASE"
  git -C "$PROJECT_DIR" archive HEAD | tar -xf - -C "$RELEASE"
  ln -s -- "$ENV_FILE" "$RELEASE/.env"
  say "Installing production application dependencies for $RELEASE_ID"
  (cd -- "$RELEASE" && npm ci --omit=dev --no-audit --no-fund)
fi

say 'Checking application configuration and entry points'
(cd -- "$RELEASE" && NODE_ENV=production HOST=127.0.0.1 PORT="$PORT" node scripts/check-config.js && node --check server.js && node --check worker.js && node --check ecosystem.config.cjs)
say 'Checking database access, indexes, and SMTP authentication without sending mail'
(cd -- "$RELEASE" && NODE_ENV=production HOST=127.0.0.1 PORT="$PORT" node scripts/preflight.js)

TLS=0
if [[ "$TLS_MODE" != off ]] && "${SUDO[@]}" test -s "$TLS_DIRECTORY/fullchain.pem" && "${SUDO[@]}" test -s "$TLS_DIRECTORY/privkey.pem"; then TLS=1; fi
[[ "$TLS_MODE" != on || "$TLS" == 1 ]] || die "Existing fullchain.pem and privkey.pem are required in $TLS_DIRECTORY."
if [[ "$TLS_MODE" == auto && "$TLS" == 0 ]] && "${SUDO[@]}" test -f "$NGINX_AVAILABLE_DIR/$SITE_NAME" && "${SUDO[@]}" grep -Eq 'listen[[:space:]]+443[[:space:]]+ssl' "$NGINX_AVAILABLE_DIR/$SITE_NAME"; then
  die 'The active site uses HTTPS, but its certificate is missing. Refusing to downgrade automatically.'
fi

BACKUP_DIR="$(mktemp -d "$DEPLOY_ROOT/backups/$RELEASE_ID.XXXXXX")"
SITE_AVAILABLE="$NGINX_AVAILABLE_DIR/$SITE_NAME"
SITE_ENABLED="$NGINX_ENABLED_DIR/$SITE_NAME"
SNIPPET="$NGINX_SNIPPETS_DIR/$SITE_NAME.conf"
LOGROTATE_FILE="$LOGROTATE_DIR/$SITE_NAME"
[[ ! -d "$SITE_AVAILABLE" && ! -d "$SITE_ENABLED" && ! -d "$SNIPPET" && ! -d "$LOGROTATE_FILE" ]] || die 'A reserved server configuration path is a directory.'
NGINX_CHANGED=0
LOGROTATE_CHANGED=0
APP_CHANGED=0
WORKER_STOPPED=0

backup_file() {
  local source="$1" name="$2"
  if "${SUDO[@]}" test -e "$source" || "${SUDO[@]}" test -L "$source"; then
    "${SUDO[@]}" cp -a -- "$source" "$BACKUP_DIR/$name"
    touch "$BACKUP_DIR/$name.exists"
  fi
}
restore_file() {
  local destination="$1" name="$2"
  "${SUDO[@]}" rm -f -- "$destination"
  if [[ -f "$BACKUP_DIR/$name.exists" ]]; then "${SUDO[@]}" cp -a -- "$BACKUP_DIR/$name" "$destination"; fi
}
switch_release() {
  local destination="$1" link="$2"
  ln -s -- "$destination" "$link.next.$$"
  mv -Tf -- "$link.next.$$" "$link"
}
pm2_apply() {
  local directory="$1" id="$2" only="$3"
  APP_ROOT="$CURRENT" APP_LOG_DIR="$DEPLOY_ROOT/logs" RELEASE_ID="$id" \
    pm2 startOrReload "$directory/ecosystem.config.cjs" --only "$only" --env production --update-env
}
rollback_on_error() {
  local status="$1" line="$2"
  # A command-substitution failure must propagate to its parent, not perform
  # service changes from a subshell while the parent continues deploying.
  if (( BASH_SUBSHELL > 0 )); then exit "$status"; fi
  trap - ERR INT TERM
  set +e
  printf '\nDeployment failed at line %s; restoring the previous application and Nginx configuration.\n' "$line" >&2
  if (( APP_CHANGED )); then
    pm2 stop "$WORKER_NAME" >/dev/null 2>&1
    if [[ -n "$OLD_RELEASE" ]]; then
      switch_release "$OLD_RELEASE" "$CURRENT"
      pm2_apply "$OLD_RELEASE" "$(basename -- "$OLD_RELEASE")" "$API_NAME"
      if (( OLD_WORKER_ACTIVE )); then pm2_apply "$OLD_RELEASE" "$(basename -- "$OLD_RELEASE")" "$WORKER_NAME"; fi
    else
      pm2 delete "$API_NAME" "$WORKER_NAME" >/dev/null 2>&1
      rm -f -- "$CURRENT"
    fi
  elif (( WORKER_STOPPED && OLD_WORKER_ACTIVE )) && [[ -n "$OLD_RELEASE" ]]; then
    pm2_apply "$OLD_RELEASE" "$(basename -- "$OLD_RELEASE")" "$WORKER_NAME"
  fi
  if (( NGINX_CHANGED )); then
    restore_file "$SITE_AVAILABLE" site
    restore_file "$SITE_ENABLED" enabled
    restore_file "$SNIPPET" snippet
    "${SUDO[@]}" "$NGINX_BIN" -t && "${SUDO[@]}" "$NGINX_BIN" -s reload
  fi
  if (( LOGROTATE_CHANGED )); then restore_file "$LOGROTATE_FILE" logrotate; fi
  pm2 save >/dev/null 2>&1
  printf 'Failed release retained for inspection: %s\n' "$RELEASE" >&2
  exit "$status"
}
trap 'rollback_on_error "$?" "$LINENO"' ERR
trap 'rollback_on_error 130 "$LINENO"' INT
trap 'rollback_on_error 143 "$LINENO"' TERM

backup_file "$SITE_AVAILABLE" site
backup_file "$SITE_ENABLED" enabled
backup_file "$SNIPPET" snippet
backup_file "$LOGROTATE_FILE" logrotate
"${SUDO[@]}" install -d -m 755 "$NGINX_AVAILABLE_DIR" "$NGINX_ENABLED_DIR" "$NGINX_SNIPPETS_DIR" "$ACME_WEBROOT"
TEMPLATE="$RELEASE/deploy/nginx/ai-sales-mail-backend.conf"
if (( TLS )); then TEMPLATE="$RELEASE/deploy/nginx/ai-sales-mail-backend.ssl.conf"; fi
sed -e "s|/etc/nginx/snippets|$NGINX_SNIPPETS_DIR|g" -e "s|/var/www/letsencrypt|$ACME_WEBROOT|g" -e "s|/etc/letsencrypt/live/ai-sales-backend.omnisuiteai.com|$TLS_DIRECTORY|g" "$TEMPLATE" > "$BACKUP_DIR/new-site"
sed "s|/var/www/letsencrypt|$ACME_WEBROOT|g" "$RELEASE/deploy/nginx/ai-sales-mail-backend.snippet.conf" > "$BACKUP_DIR/new-snippet"
NGINX_CHANGED=1
"${SUDO[@]}" install -m 644 "$BACKUP_DIR/new-site" "$SITE_AVAILABLE"
"${SUDO[@]}" install -m 644 "$BACKUP_DIR/new-snippet" "$SNIPPET"
"${SUDO[@]}" ln -sfn -- "$SITE_AVAILABLE" "$SITE_ENABLED"
say 'Validating Nginx before reloading it'
"${SUDO[@]}" "$NGINX_BIN" -t

if [[ -n "$OLD_RELEASE" ]] && pm2 describe "$WORKER_NAME" >/dev/null 2>&1; then
  say 'Draining the previous mail worker'
  WORKER_STOPPED=1
  pm2 stop "$WORKER_NAME"
fi
APP_CHANGED=1
switch_release "$RELEASE" "$CURRENT"
say 'Starting the API on 127.0.0.1:5921'
pm2_apply "$RELEASE" "$RELEASE_ID" "$API_NAME"

READY=0
for ((attempt=1; attempt<=HEALTH_ATTEMPTS; attempt++)); do
  if curl --silent --show-error --fail --connect-timeout 2 --max-time 5 "http://127.0.0.1:$PORT/ready" > "$BACKUP_DIR/ready.json" 2>/dev/null && \
    node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1])); process.exit(r.status==="ready" && r.release===process.argv[2] ? 0 : 1)' "$BACKUP_DIR/ready.json" "$RELEASE_ID"; then READY=1; break; fi
  sleep "$HEALTH_RETRY_SECONDS"
done
[[ "$READY" == 1 ]] || { printf 'API readiness check failed.\n' >&2; false; }

say 'Reloading Nginx and checking both hostnames'
"${SUDO[@]}" "$NGINX_BIN" -s reload
for hostname in "$DOMAIN" "$WWW_DOMAIN"; do
  if (( TLS )); then
    curl --silent --show-error --fail --connect-timeout 5 --max-time 15 --resolve "$hostname:443:127.0.0.1" "https://$hostname/ready" > "$BACKUP_DIR/proxy-ready.json"
  else
    curl --silent --show-error --fail --connect-timeout 5 --max-time 15 -H "Host: $hostname" http://127.0.0.1/ready > "$BACKUP_DIR/proxy-ready.json"
  fi
  node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1])); process.exit(r.status==="ready" && r.release===process.argv[2] ? 0 : 1)' "$BACKUP_DIR/proxy-ready.json" "$RELEASE_ID"
done

if (( TLS )); then
  say 'Starting the persistent mail worker'
  pm2_apply "$RELEASE" "$RELEASE_ID" "$WORKER_NAME"
else
  say 'HTTP bootstrap is ready; mail worker remains paused until HTTPS is configured'
fi
pm2 jlist | node -e 'let s=""; process.stdin.on("data",x=>s+=x); process.stdin.on("end",()=>{const apps=JSON.parse(s),names=["ai-sales-mail-api",...(process.argv[2]==="1"?["ai-sales-mail-worker"]:[])]; for(const name of names){const p=apps.find(x=>x.name===name); if(!p || p.pm2_env.status!=="online" || p.pm2_env.RELEASE_ID!==process.argv[1]){console.error(name+" did not become ready on this release"); process.exitCode=1;}}});' "$RELEASE_ID" "$TLS"
say 'Writing application log rotation configuration'
node -e 'const fs=require("fs"); const text=fs.readFileSync(process.argv[1],"utf8").replace("__LOG_GLOB__",JSON.stringify(process.argv[2]+"/*.log")).replace("__DEPLOY_USER__",process.argv[3]).replace("__DEPLOY_GROUP__",process.argv[4]); process.stdout.write(text);' "$RELEASE/deploy/logrotate/ai-sales-mail-backend.template" "$DEPLOY_ROOT/logs" "$DEPLOY_USER" "$DEPLOY_GROUP" > "$BACKUP_DIR/new-logrotate"
"${SUDO[@]}" install -d -m 755 "$LOGROTATE_DIR"
LOGROTATE_CHANGED=1
"${SUDO[@]}" install -m 644 "$BACKUP_DIR/new-logrotate" "$LOGROTATE_FILE"
LOGROTATE_BIN="$(command -v logrotate || true)"
if [[ -z "$LOGROTATE_BIN" && -x /usr/sbin/logrotate ]]; then LOGROTATE_BIN=/usr/sbin/logrotate; fi
if [[ -n "$LOGROTATE_BIN" ]]; then "${SUDO[@]}" "$LOGROTATE_BIN" -d "$LOGROTATE_FILE"; fi
pm2 save
if [[ -n "$OLD_RELEASE" && "$OLD_RELEASE" != "$RELEASE" ]]; then switch_release "$OLD_RELEASE" "$PREVIOUS"; fi

# Retain recent releases plus the active and previous targets. Validate every
# resolved target before recursive removal; never follow a release symlink.
count=0
while IFS= read -r name; do
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}-[0-9]+$ ]] || continue
  count=$((count + 1))
  (( count <= KEEP_RELEASES )) && continue
  candidate="$RELEASES_DIR/$name"
  [[ -d "$candidate" && ! -L "$candidate" ]] || continue
  resolved="$(readlink -f -- "$candidate")"
  active="$(readlink -f -- "$CURRENT")"
  previous="$(readlink -f -- "$PREVIOUS" 2>/dev/null || true)"
  if [[ "$resolved" == "$RELEASES_DIR/"* && "$resolved" != "$active" && "$resolved" != "$previous" ]]; then rm -rf -- "$resolved"; fi
done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort -r)

trap - ERR INT TERM
say "Deployment complete: $RELEASE_ID"
printf 'API: %s\nWorker: %s\nLogs: %s\n' "$API_NAME" "$WORKER_NAME" "$DEPLOY_ROOT/logs"
if (( TLS )); then printf 'URL: https://%s\n' "$DOMAIN"; else
  printf 'HTTP bootstrap only; mail worker is paused. Issue a certificate for BOTH domains, then run: bash deploy.sh --no-pull --https\n'
fi
printf 'For boot persistence, ensure the existing PM2 startup service is enabled (pm2 startup); pm2 save has completed.\n'
