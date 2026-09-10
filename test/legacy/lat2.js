const B = 'http://localhost:4719', MK = '201432547E';
const med = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
const mk = async n => (await fetch(B+'/api/master/api-keys',{method:'POST',headers:{'x-master-key':MK,'Content-Type':'application/json'},body:JSON.stringify({name:n,scopes:['read']})}).then(r=>r.json())).key;
const one = async k => { const t=process.hrtime.bigint(); const r=await fetch(B+'/api/orders?range=today',{headers:{'x-api-key':k}}); await r.text(); return Number(process.hrtime.bigint()-t)/1e6; };
(async () => {
  const warmKey = await mk('warm'+Date.now());
  const cold = [], warm = [];
  for (let i = 0; i < 7; i++) {
    const fresh = await mk('cold'+Date.now()+'-'+i);   // never verified before
    cold.push(await one(fresh));                        // must pay scrypt
    warm.push(await one(warmKey));                      // cached after the 1st
  }
  warm.shift();                                         // its own first call was cold
  console.log('cold(new key each time):', cold.map(x=>x.toFixed(1)).join(','), '=> med', med(cold).toFixed(1));
  console.log('warm(same key repeated):', warm.map(x=>x.toFixed(1)).join(','), '=> med', med(warm).toFixed(1));
  console.log('saved per request:', (med(cold)-med(warm)).toFixed(1)+'ms');
})();
