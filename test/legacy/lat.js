const B = 'http://localhost:4719', MK = '201432547E';
const med = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
(async () => {
  const l = await fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'demo',password:'demo'})}).then(r=>r.json());
  const k = await fetch(B+'/api/master/api-keys',{method:'POST',headers:{'x-master-key':MK,'Content-Type':'application/json'},body:JSON.stringify({name:'lat'+Date.now(),scopes:['read']})}).then(r=>r.json());
  const S = {'x-auth-token': l.token}, K = {'x-api-key': k.key};
  const timeN = async (h, path, n) => { const o=[]; for(let i=0;i<n;i++){const t=process.hrtime.bigint(); const r=await fetch(B+path,{headers:h}); await r.text(); o.push(Number(process.hrtime.bigint()-t)/1e6);} return o; };
  for (const path of ['/api/orders?range=today','/api/stats']) {
    await timeN(S,path,3); await timeN(K,path,3);            // warm both
    const s = await timeN(S,path,9), kk = await timeN(K,path,9);
    console.log(path.padEnd(26), 'staff', med(s).toFixed(1)+'ms', ' key', med(kk).toFixed(1)+'ms',
                ' delta', (med(kk)-med(s)).toFixed(1)+'ms');
    console.log('   staff:', s.map(x=>x.toFixed(0)).join(','), '\n   key  :', kk.map(x=>x.toFixed(0)).join(','));
  }
})();
