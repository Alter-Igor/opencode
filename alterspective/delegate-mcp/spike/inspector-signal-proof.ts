// Only the disposable child created here receives SIGUSR1. No production box or real tokens.
import { bunExec } from "../src/supervisor/docker.ts"

const script = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const child = spawn('/usr/local/bin/opencode', ['serve','--hostname','0.0.0.0','--port','4096'], { stdio: 'ignore', env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' } });
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
function ports() {
  try {
    const sockets = new Set(fs.readdirSync('/proc/'+child.pid+'/fd').flatMap(fd => {
      try { const link=fs.readlinkSync('/proc/'+child.pid+'/fd/'+fd); return link.startsWith('socket:[') ? [link.slice(8,-1)] : []; } catch { return []; }
    }));
    return ['tcp','tcp6'].flatMap(f => fs.readFileSync('/proc/'+child.pid+'/net/'+f,'utf8').trim().split('\n').slice(1).flatMap(l => { const p=l.trim().split(/\s+/); return p[3]==='0A' && sockets.has(p[9]) ? [parseInt(p[1].split(':')[1],16)] : []; }));
  } catch { return []; }
}
(async()=> {
  try {
    for (let i=0;i<100 && !ports().includes(4096);i++) { if (child.exitCode!==null || child.signalCode!==null) throw Error('server exited before listening'); await sleep(100); }
    const before=ports(); if (!before.includes(4096)) throw Error('server did not listen');
    child.kill('SIGUSR1'); await sleep(1500);
    const after=ports(); const outcome=await Promise.race([exited,sleep(10).then(()=>({ code:null,signal:null }))]);
    console.log(JSON.stringify({ runtime: 'compiled Bun 1.3.14 image', before, after, outcome, inspectorOpened: after.some(p=>p!==4096) }));
    if (after.some(p=>p!==4096)) process.exitCode=1;
  } catch(e) { console.log(JSON.stringify({error:e.message})); process.exitCode=1; }
  finally { if (child.exitCode===null && child.signalCode===null) { child.kill('SIGTERM'); await Promise.race([exited,sleep(2000)]); if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); } }
})();`
const result = await bunExec(["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--ulimit", "core=0:0", "--tmpfs", "/tmp:mode=1777", "--tmpfs", "/home/agent:uid=10001,gid=10001,mode=0700", "--tmpfs", "/data:uid=10001,gid=10001,mode=0700", "--entrypoint", "node", process.argv[2] ?? "opencode-delegate-box:1.18.31-bc1a3343c278", "-e", script], { timeoutMs: 25_000 })
console.log(result.stdout.trim())
if (result.code !== 0) throw new Error(`isolated inspector proof failed (exit ${result.code})`)
