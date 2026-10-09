// Normal workload phase: stop pressing the history pager after minute 19.
// Live intake, model computation, rendering and all caches continue unchanged.
{
  const p=window.__memoryWK,original=p.sample;
  p.sample=function(minute){
    const idle=minute>=20;
    const value=original(idle?-1:minute);
    value.minute=minute;
    value.workloadPhase=idle?'idle':'history';
    if(idle)value.action='idle';
    return value;
  };
}
