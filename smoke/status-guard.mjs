import fs from 'node:fs';
import {createHmac, timingSafeEqual} from 'node:crypto';
const [statusPath,freshPath,outPath,edgeEnvPath]=process.argv.slice(2);
const origin='http://127.0.0.1:55321';
function refuse() { throw Error('Isolated status, origin, or disposable JWT provenance not verified.'); }
try {
  const status=JSON.parse(fs.readFileSync(statusPath,'utf8'));
  const e=status.env;
  if (status.runtime!=='native' || !e || e.API_URL!==origin) refuse();
  const secret=fs.readFileSync(freshPath,'utf8');
  if (!/^[a-f0-9]{64}$/.test(secret)) refuse();
  function verify(key,role){
    if(typeof key!=='string'||key.length>4096||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key))refuse();
    const [h,p,s]=key.split('.');
    if(JSON.parse(Buffer.from(h,'base64url')).alg!=='HS256'||JSON.parse(Buffer.from(p,'base64url')).role!==role)refuse();
    const signature=Buffer.from(s,'base64url');
    const valid=createHmac('sha256',secret).update(h+'.'+p).digest();
    if(signature.length!==valid.length||!timingSafeEqual(signature,valid))refuse();
    return key;
  }
  const anon=verify(e.ANON_KEY,'anon'), writer=verify(e.SERVICE_ROLE_KEY,'service_role');
  if(anon===writer)refuse();
  fs.writeFileSync(outPath,JSON.stringify({anon}),{mode:0o600});
  fs.writeFileSync(edgeEnvPath,`GENIE_EDGE_MODE=isolated-genie-synthetic-only\nGENIE_EDGE_ORIGIN=${origin}\nGENIE_EDGE_ANON_JWT=${anon}\nGENIE_EDGE_WRITER_JWT=${writer}\n`,{mode:0o600});
} catch {console.error('STOP: isolated stack output or freshly minted key provenance mismatch.');process.exitCode=1;}
