import subprocess, os, time, json, urllib.request, pathlib, shutil
root=os.getcwd(); bun='/tmp/pod-3953-toolchain/bun'; results=[]
for arm in ['before','after']:
    folder=pathlib.Path('/tmp/pod-3953-measure-'+arm); folder.mkdir(exist_ok=False)
    ready=folder/'ready.json'; log=open(folder/'server.log','w')
    env={k:v for k,v in os.environ.items() if not k.startswith('PODIUM_')}; env['PATH']='/tmp/pod-3953-toolchain:'+env['PATH']
    args=[bun,'--conditions=@podium/source','scripts/sync-measurements/delta-worker.mjs',str(folder/'db.sqlite'),str(ready)]
    if arm=='before': args+=['apps/server/src/sync/delta-baseline.measurement.ts']
    proc=subprocess.Popen(args,stdout=log,stderr=log,env=env)
    try:
        for _ in range(1800):
            if ready.exists(): break
            if proc.poll() is not None: raise RuntimeError((folder/'server.log').read_text()[-5000:])
            time.sleep(.1)
        data=json.loads(ready.read_text()); manifest=data['manifest']; hz=os.sysconf('SC_CLK_TCK')
        def cpu():
            parts=pathlib.Path(f'/proc/{proc.pid}/task/{proc.pid}/stat').read_text().split(') ',1)[1].split();return (int(parts[11])+int(parts[12]))/hz
        c0=cpu(); t0=time.monotonic(); first=None; total=0; rows=0; pages=0; final=None; load=os.getloadavg()
        url=f"http://127.0.0.1:{data['port']}/sync/delta?feedId=f&epoch=e&from={manifest['from']}&to={manifest['through']}"
        with urllib.request.urlopen(urllib.request.Request(url,headers={'Accept-Encoding':'identity'}),timeout=180) as response:
            for line in response:
                if first is None: first=time.monotonic()-t0
                total+=len(line); record=json.loads(line)
                if record['type']=='feedDelta': rows+=len(record['changes']);pages+=1
                final=record
        elapsed=time.monotonic()-t0; spent=cpu()-c0
        assert rows==20000 and final['type']=='syncComplete', (rows,final)
        results.append(dict(arm=arm,bun=data['bun'],seconds=elapsed,mainCpuMs=spent*1000,mainBusyPercent=100*spent/elapsed,firstRecordMs=first*1000,bytes=total,rows=rows,pages=pages,load=load,final=final))
        print(json.dumps(results[-1]),flush=True)
    finally:
        proc.terminate()
        try: proc.wait(timeout=30)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()
        log.close()
        shutil.copyfile(folder/'server.log',root+'/.evidence/'+arm+'-server.log')
        shutil.rmtree(folder)
pathlib.Path('.evidence/delta-worker-measurement.json').write_text(json.dumps(results,indent=2))
