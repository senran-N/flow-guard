// Run one frozen corpus worker with the same 120-second limit used by scans.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [evidenceRootArg, phase, workspaceArg, outputName] = process.argv.slice(2);
assert.ok(evidenceRootArg && phase && workspaceArg && outputName, "Usage: node benchmark/run-frozen-once.mjs <evidence-root> <phase> <workspace> <output-name>");
const evidenceRoot=path.resolve(evidenceRootArg), workspace=path.resolve(workspaceArg), output=path.resolve(evidenceRoot,outputName);
assert.equal(path.dirname(output),evidenceRoot);assert.ok(!fs.existsSync(output));
const worker=path.join(evidenceRoot,`${phase}-corpus`,`engine-snapshot`,`benchmark`,`real-world-worker.mjs`);assert.ok(fs.existsSync(worker));
const git=(...args)=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',windowsHide:true}).trim();const commit=git('rev-parse','HEAD'),initialStatus=git('status','--porcelain');fs.mkdirSync(output);const destination=path.join(output,'scan.json'),startedAt=new Date().toISOString(),start=Date.now();
const child=spawn(process.execPath,[worker,workspace,destination],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PLUGIN_DATA:path.join(output,'state')}});let stdout='',stderr='',timedOut=false;child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const timer=setTimeout(()=>{timedOut=true;try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{child.kill('SIGKILL');}},120000);const {exitCode,signal}=await new Promise(resolve=>child.on('close',(exitCode,signal)=>resolve({exitCode,signal})));clearTimeout(timer);const scan=fs.existsSync(destination)?JSON.parse(fs.readFileSync(destination,'utf8')):null;const result={startedAt,finishedAt:new Date().toISOString(),workspace,commit,initialStatus,exitCode,signal,timedOut,elapsedMs:Date.now()-start,stdout,stderr,verifyMs:scan?.verifyMs,rssMiB:scan?.rssMiB};result.finalCommit=git('rev-parse','HEAD');result.finalStatus=git('status','--porcelain');fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));assert.equal(result.finalCommit,commit);assert.equal(result.finalStatus,initialStatus);console.log(JSON.stringify(result));
