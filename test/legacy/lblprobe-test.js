// "GetShipmentLabels succeeds and I still don't see any." The probe now answers
// that in one click, in the words the question is asked in.
const BASE='http://localhost:4636', HUB='http://localhost:4926', MK='201432547E';
const fails=[]; const ok=(c,m)=>{console.log((c?'PASS':'FAIL')+' - '+m); if(!c)fails.push(m);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let T='';
const J=async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json','x-master-key':MK,'x-auth-token':T,...(o.headers||{})}});return{status:r.status,body:await r.json().catch(()=>({}))};};
const probe=async id=>(await J(`/api/master/zort/stores/${id}/probe`,{method:'POST',body:'{}'})).body;
const stepOf=(b,n)=>(b.steps||[]).find(s=>s.name===n);

(async()=>{
  T=(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'demo',password:'demo'})})).json()).token;
  ok(!!T,'logged in');
  for (const s of ((await J('/api/master/zort/stores')).body?.stores||[])) if (s.clientName==='PbCo') await J(`/api/master/zort/stores/${s.id}`,{method:'DELETE'});
  const store=(await J('/api/master/zort/stores',{method:'POST',body:JSON.stringify({
    clientName:'PbCo', storename:'hub', apikey:'k', apisecret:'s', endpoint:HUB, enabled:true, completeAction:'none' })})).body;
  ok(!!store?.id,'store connected');

  // ── THE REPORTED CASE: the call succeeds, the list is empty.
  await fetch(HUB+'/__mode?m=none');
  const a=await probe(store.id);
  const s5=stepOf(a,'GetShipmentLabels');
  ok(!!s5,'the probe now asks about the label as its fifth question');
  ok(/Is there a label/i.test(s5?.what||''),`in plain words ("${s5?.what}")`);
  ok(/NO label for this order yet/i.test(s5?.verdict||''),'and says the channel has none yet');
  ok(/Ready to Ship/i.test(s5?.verdict||''),'explaining that the label is created at Ready to Ship');
  ok(/nothing on our side can produce one/i.test(s5?.verdict||''),'and that this is not ours to fix');
  ok(s5?.sample==='[]' && /0 label row/.test(s5?.shape||''),
     `with the raw reply shown, not just a conclusion (${s5?.shape}, ${s5?.sample})`);
  ok(a.calls===5,`five calls, not a sweep (${a.calls})`);

  // ── A LABEL WE CAN IMPORT: then it IS ours.
  await fetch(HUB+'/__mode?m=pdf');
  const b=await probe(store.id);
  const b5=stepOf(b,'GetShipmentLabels');
  ok(/HAS a label \(Pdf\)/i.test(b5?.verdict||''),`it says the label exists ("${(b5?.verdict||'').slice(0,50)}…")`);
  ok(/ours to fix/i.test(b5?.verdict||''),'and that a missing one is then our problem');

  // ── A FORMAT WE CANNOT IMPORT.
  await fetch(HUB+'/__mode?m=html');
  const c=await probe(store.id);
  const c5=stepOf(c,'GetShipmentLabels');
  ok(/serves it as Html/i.test(c5?.verdict||''),`the format is named ("${(c5?.verdict||'').slice(0,60)}…")`);
  ok(/Print it from the channel/i.test(c5?.verdict||''),'with what to do instead');

  console.log('\n'+(fails.length?`${fails.length} FAILED: ${fails.join(' | ')}`:'ALL PASS'));
})();
