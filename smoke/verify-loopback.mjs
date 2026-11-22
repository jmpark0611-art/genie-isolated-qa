import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const ORIGIN='http://127.0.0.1:55321', CONFIRM='isolated-genie-synthetic-only';
function guard(e,mode){
  if(mode!=='--run'||e.GENIE_CONFIRM!==CONFIRM||e.GENIE_SUPABASE_URL!==ORIGIN)
    throw Error('Refusing request: exact loopback origin and explicit local test opt-in required.');
  const k=e.GENIE_SUPABASE_PUBLIC_KEY??'';
  if(/^sb_publishable_[\w-]+$/.test(k))return k;
  let role; try{const p=k.split('.');if(p.length===3)role=JSON.parse(Buffer.from(p[1],'base64url')).role;}catch{}
  if(role!=='anon')throw Error('Only a local publishable key or anon JWT is accepted.');
  return k;
}
function transport(key,send=fetch){
  return (method,p,body,token)=>{
    if(!/^\/(auth\/v1\/signup|functions\/v1\/vs-decide|rest\/v1\/(rpc\/vs_[a-z_]+|vs_polls))(?:\?[^#]*)?$/.test(p))throw Error('Unexpected endpoint');
    const url=new URL(p,ORIGIN);
    if(url.origin!==ORIGIN)throw Error('External requests rejected');
    return send(url,{method,redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{apikey:key,Authorization:'Bearer '+(token||key),'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
  };
}
function must(ok,label){if(!ok)throw Error(label);}
// Read at most 512 bytes from the one deterministic synthetic response.
async function edgeFailure(r){
  const prefix='Deterministic local Edge HTTP '+r.status;
  if(!(r.headers.get('content-type')??'').startsWith('application/json')||!r.body) return prefix;
  const allowed={
    400:['SYNTHETIC_INPUT_REQUIRED'],
    401:['AUTH_REQUIRED','ANONYMOUS_FIXTURE_USER_REQUIRED'],
    404:['NOT_FOUND'],
    405:['METHOD_NOT_ALLOWED'],
    502:['LOCAL_AUTH_UNAVAILABLE','LOCAL_CLAIM_FAILED','LOCAL_WRITE_FAILED','LOCAL_SAVE_INVALID','LOCAL_BACKEND_UNAVAILABLE'],
  };
  if(!Object.hasOwn(allowed,r.status))return prefix;
  const reader=r.body.getReader(), data=new Uint8Array(512);
  let size=0;
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      if(size+value.byteLength>data.length)return prefix;
      data.set(value,size);size+=value.byteLength;
    }
    const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,size)));
    return allowed[r.status].includes(body?.error)?prefix+' '+body.error:prefix;
  }catch{return prefix;}
  finally{void reader.cancel().catch(()=>{});}
}
async function real(key){
  const req=transport(key);
  const json=async(r,label)=>{must(r.ok,label+' HTTP '+r.status);return r.json();};
  const denies=async(r,message)=>{
    if(r.status<400||r.status>=500)return false;
    const body=await r.json().catch(()=>({}));
    return body.code===message||body.message===message;
  };
  const signup=async()=>json(await req('POST','/auth/v1/signup',{data:{}}),'Anonymous Auth');
  const a=await signup(),b=await signup();
  must(a.user?.is_anonymous===true&&b.user?.is_anonymous===true&&a.user.id&&b.user.id&&a.user.id!==b.user.id&&a.access_token&&b.access_token&&a.access_token!==b.access_token,'Distinct anonymous users required');
  const o=a.access_token,v=b.access_token,marker='QA '+randomUUID().slice(0,8);
  const rpc=(name,body,t)=>req('POST','/rest/v1/rpc/vs_'+name,body,t);
  const read=async(name,body,t)=>json(await rpc(name,body,t),name);
  let id,removed=false;
  try{
    const edge=await req('POST','/functions/v1/vs-decide',{a:marker+' A',b:marker+' B',note:''},o);
    if(!edge.ok)throw Error(await edgeFailure(edge));
    const d=await edge.json();
    must(d.kind==='pick'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(d.id??''),'Expected synthetic decision UUID');
    id=d.id;const p={p_id:id},table='/rest/v1/vs_polls?select=id,did&id=eq.'+id;
    const own=await read('my_poll',p,o);
    must(own.id===id&&own.isOwner===true&&own.a===marker+' A','Owner result mismatch');
    const rows=async(t)=>json(await req('GET',table,undefined,t),'PostgREST owner visibility');
    must((await rows(o)).length===1&&(await rows(v)).length===0,'Direct table reads not isolated');
    must(await denies(await req('PATCH',table,{did:'b'},v),'42501'),'Direct voter write allowed');
    must(await denies(await rpc('my_poll',p,v),'NOT_FOUND')&&await denies(await rpc('set_did',{...p,p_did:'a'},v),'NOT_FOUND'),'Foreign owner RPC allowed');
    const code=await read('share',p,o);
    must(typeof code==='string'&&/^[\w-]{1,128}$/.test(code)&&await read('share',p,o)===code,'Share was invalid or not idempotent');
    const s={p_code:code},before=await read('shared_poll',s,v);
    must(before.isOwner===false&&before.id===null&&before.shareCode===null&&before.myVote===null&&!('pick' in before)&&!('reason' in before)&&!('votes' in before),'Unexpected private fields before vote');
    must(await denies(await rpc('vote',{...s,p_choice:'b'},o),'OWNER_CANNOT_VOTE'),'Owner vote was allowed');
    const one=await read('vote',{...s,p_choice:'a'},v),again=await read('vote',{...s,p_choice:'b'},v);
    const tally=await read('my_poll',p,o);
    must(one.myVote==='a'&&again.myVote==='a'&&tally.votes?.a===1&&tally.votes?.b===0,'Vote not idempotent or tally differs');
    must((await rpc('set_did',{...p,p_did:'a'},o)).ok&&(await read('my_poll',p,o)).did==='a','Owner choice did not persist');
    must((await rpc('delete_poll',p,v)).ok,'Foreign delete RPC should be a no-op');
    must((await rows(o)).length===1,'Voter removed owner record');
    must((await rpc('delete_poll',p,o)).ok,'Owner delete unsuccessful');
    must((await rows(o)).length===0&&await denies(await rpc('shared_poll',s,v),'NOT_FOUND'),'Deleted record or invitation remained accessible');
    removed=true;
    console.log('PASS: local Auth, Edge, PostgREST visibility, owner policy, vote privacy, tally, choice and deletion.');
  }finally{
    if(id&&!removed)try{if(!(await rpc('delete_poll',{p_id:id},o)).ok)throw Error();}catch{console.error('Synthetic record cleanup unconfirmed. Discard test volume.');}
  }
}
async function selfTest(){
  const env={GENIE_CONFIRM:CONFIRM,GENIE_SUPABASE_URL:ORIGIN,GENIE_SUPABASE_PUBLIC_KEY:'sb_publishable_fake'};
  assert.equal(guard(env,'--run'),'sb_publishable_fake');
  const jwt=(role)=>'header.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.sig';
  assert.equal(guard({...env,GENIE_SUPABASE_PUBLIC_KEY:jwt('anon')},'--run'),jwt('anon'));
  for(const url of ['',ORIGIN+'/',ORIGIN+'@host.invalid','http://localhost:55321','http://127.1:55321','http://0.0.0.0:55321','https://prod.supabase.co','http://127.0.0.1:54321']) assert.throws(()=>guard({...env,GENIE_SUPABASE_URL:url},'--run'));
  for(const k of ['sb_secret_fake',jwt('service_role'),''])assert.throws(()=>guard({...env,GENIE_SUPABASE_PUBLIC_KEY:k},'--run'));
  assert.throws(()=>guard(env,undefined));assert.throws(()=>guard({...env,GENIE_CONFIRM:undefined},'--run'));
  let accepted=0;
  const send=transport('fake',async(u,opt)=>{assert.equal(u.origin,ORIGIN);assert.equal(opt.redirect,'error');accepted++;});
  for(const p of ['//external.invalid/rest/v1/vs_polls','/auth/v1/admin/users','/rest/v1/rpc/bc_reset','/rest/v1/vs_polls#fragment'])assert.throws(()=>send('GET',p));
  await send('GET','/rest/v1/vs_polls?select=id');assert.equal(accepted,1);
  console.log('PASS: exact loopback, opt-in, public-key-only, bounded endpoint and fail-on-redirect guards. No network.');
}
try{
  const m=process.argv[2];
  if(m==='--self-test')await selfTest();
  else if(m==='--run')await real(guard(process.env,m));
  else if(!m)console.log('No requests made. Read README or use --self-test.');
  else throw Error('Unknown mode.');
}catch(e){console.error(e instanceof Error?e.message:'QA failed');process.exitCode=1;}
