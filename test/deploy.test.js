const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

test('deployment stages releases and restores the last release after Nginx or readiness failure', { skip: !fs.existsSync(bash), timeout: 240000 }, () => {
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, '.cache/deploy-test-'));
  const source = path.join(fixture, 'source');
  const bin = path.join(fixture, 'bin');
  fs.mkdirSync(source); fs.mkdirSync(bin);
  const stateFile = path.join(fixture, 'state.json');
  fs.writeFileSync(stateFile, '{"failProxyOnce":true}');
  fs.copyFileSync(path.join(root, 'deploy.sh'), path.join(source, 'deploy.sh'));
  fs.copyFileSync(path.join(root, 'ecosystem.config.cjs'), path.join(source, 'ecosystem.config.cjs'));
  fs.cpSync(path.join(root, 'deploy'), path.join(source, 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts'));
  for (const file of ['scripts/check-config.js', 'scripts/preflight.js', 'server.js', 'worker.js']) fs.writeFileSync(path.join(source, file), 'process.exitCode = 0;\n');
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"deployment-fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(source, '.env'), 'TEST_ENV_ONLY=true\n');
  fs.writeFileSync(path.join(source, '.env.example'), 'TEST_ENV_ONLY=true\n');
  fs.writeFileSync(path.join(source, '.gitignore'), '.env\n.deploy/\n');
  function git(...args) { cp.execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' }); }
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Deployment Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial fixture');

  const fake = `const fs=require('fs'),path=require('path');
const command=process.argv[2], args=process.argv.slice(3), file=process.env.DEPLOY_TEST_STATE;
const read=()=>JSON.parse(fs.readFileSync(file)), save=s=>fs.writeFileSync(file,JSON.stringify(s));
const s=read();s.apps ||= {};s.events ||= [];s.events.push([command,...args]);save(s);
if(command==='pm2'){
 if(args[0]==='describe')process.exit(s.apps[args[1]]?0:1);
 if(args[0]==='jlist'){console.log(JSON.stringify(Object.values(s.apps)));process.exit(0);}
 if(args[0]==='stop'){if(!s.apps[args[1]])process.exit(1);s.apps[args[1]].pm2_env.status='stopped';}
 if(args[0]==='delete')for(const name of args.slice(1))delete s.apps[name];
 if(args[0]==='startOrReload'){
   const config=require(path.resolve(args[1])), only=args[args.indexOf('--only')+1].split(',');
   for(const app of config.apps.filter(x=>only.includes(x.name)))s.apps[app.name]={name:app.name,pm2_env:{...app.env_production,status:'online'}};
 }
 save(s);process.exit(0);
}
if(command==='nginx'){
 if(args[0]==='-t' && s.failNginx){s.failNginx=false;save(s);process.exit(1);}process.exit(0);
}
if(command==='curl'){
 const release=s.apps['ai-sales-mail-api']?.pm2_env.RELEASE_ID;
 if(!args.some(x=>x.includes(':5921/ready')) && s.failProxyOnce){s.failProxyOnce=false;save(s);process.exit(22);}
 if(s.failReady && release!==s.initialRelease)process.exit(22);
 console.log(JSON.stringify({status:'ready',release}));process.exit(0);
}
if(command==='logrotate')process.exit(0);
if(command==='ln'){
 const [src,dest]=args.filter(x=>!x.startsWith('-')).slice(-2);
 try{fs.unlinkSync(dest);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(fs.statSync(src).isDirectory())fs.symlinkSync(src,dest,'junction');else fs.copyFileSync(src,dest);
 process.exit(0);
}
if(command==='mv'){
 const [src,dest]=args.filter(x=>!x.startsWith('-')).slice(-2);
 try{fs.unlinkSync(dest);}catch(e){if(e.code!=='ENOENT')throw e;}
 fs.renameSync(src,dest);process.exit(0);
}
throw Error('Unknown stub command');`;
  fs.writeFileSync(path.join(bin, 'services.cjs'), fake);
  const wrapper = command => `#!/usr/bin/env bash\nset -e\nscript="$(dirname -- "$0")/services.cjs"\nif command -v cygpath >/dev/null 2>&1; then script="$(cygpath -w "$script")"; fi\nexec node "$script" ${command} "$@"\n`;
  for (const command of ['pm2', 'nginx', 'curl', 'logrotate', ...(process.platform === 'win32' ? ['ln', 'mv'] : [])]) fs.writeFileSync(path.join(bin, command), wrapper(command), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/usr/bin/env bash\nif [[ "$1" == -v ]]; then exit 0; fi\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/usr/bin/env bash\nmkdir -p node_modules\n', { mode: 0o755 });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'id'), '#!/usr/bin/env bash\nif [[ "$1" == -un || "$1" == -gn ]]; then echo deploytest; else /usr/bin/id "$@"; fi\n', { mode: 0o755 });
  }
  const unix = value => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
  const env = {
    ...process.env, DEPLOY_TEST_STATE: stateFile, DEPLOY_ROOT: unix(path.join(source, '.deploy')),
    NGINX_AVAILABLE_DIR: unix(path.join(fixture, 'nginx-available')), NGINX_ENABLED_DIR: unix(path.join(fixture, 'nginx-enabled')),
    NGINX_SNIPPETS_DIR: unix(path.join(fixture, 'nginx-snippets')), LOGROTATE_DIR: unix(path.join(fixture, 'logrotate')),
    ACME_WEBROOT: unix(path.join(fixture, 'acme')), TLS_DIRECTORY: unix(path.join(fixture, 'tls')),
    HEALTH_ATTEMPTS: '2', HEALTH_RETRY_SECONDS: '0',
  };
  const invoke = (...options) => cp.spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$1:$PATH"; cd -- "$2"; shift 2; exec bash deploy.sh "$@"', '--', unix(bin), unix(source), ...options], { env, encoding: 'utf8', timeout: 60000 });
  function success(result) { assert.equal(result.status, 0, result.stdout + '\n' + result.stderr); }
  function state() { return JSON.parse(fs.readFileSync(stateFile)); }
  function change(values) { fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...values })); }
  const current = path.join(source, '.deploy/current');
  const site = path.join(fixture, 'nginx-available/ai-sales-mail-backend');
  const bootstrap = invoke('--no-pull', '--http');
  success(bootstrap);
  assert.equal(state().failProxyOnce, false);
  assert.equal(state().apps['ai-sales-mail-worker'], undefined);
  fs.mkdirSync(path.join(fixture, 'tls'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'tls/fullchain.pem'), 'fixture certificate');
  fs.writeFileSync(path.join(fixture, 'tls/privkey.pem'), 'fixture key');
  const initial = invoke('--no-pull', '--https');
  success(initial);
  assert.ok(fs.existsSync(current), initial.stdout + '\n' + initial.stderr);
  const first = fs.realpathSync(current);
  change({ initialRelease: path.basename(first) });
  const originalSite = fs.readFileSync(site, 'utf8');
  fs.writeFileSync(path.join(source, 'version.txt'), 'next release\n');
  fs.appendFileSync(path.join(source, 'deploy/nginx/ai-sales-mail-backend.ssl.conf'), '\n# Next release marker\n');
  git('add', '.'); git('-c', 'user.name=Deployment Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'next fixture');

  change({ failNginx: true });
  assert.notEqual(invoke('--no-pull', '--https').status, 0);
  assert.equal(fs.realpathSync(current), first);
  assert.equal(fs.readFileSync(site, 'utf8'), originalSite);

  change({ failReady: true });
  assert.notEqual(invoke('--no-pull', '--https').status, 0);
  assert.equal(fs.realpathSync(current), first);
  assert.equal(state().apps['ai-sales-mail-api'].pm2_env.RELEASE_ID, path.basename(first));
  assert.equal(state().apps['ai-sales-mail-worker'].pm2_env.status, 'online');

  change({ failReady: false });
  success(invoke('--no-pull', '--https'));
  assert.notEqual(fs.realpathSync(current), first);
  success(invoke('--rollback', '--https'));
  assert.equal(fs.realpathSync(current), first);
});
