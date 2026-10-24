import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createParserIdleBarrier} from '../server/parser-idle.mjs';
test('a removed cancelled parser job remains fenced for its full bounded child lifetime',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-parser-idle-'));let time=1000;const gate=createParserIdleBarrier({now:()=>time}),name=randomUUID()+'.json';
 try{
  await fs.mkdir(path.join(root,'pending'));await fs.mkdir(path.join(root,'results'));
  assert.equal(await gate.allowed(root),false);time+=45000;assert.equal(await gate.allowed(root),true);
  await fs.writeFile(path.join(root,'pending',name),'{}');assert.equal(await gate.allowed(root),false);
  await fs.unlink(path.join(root,'pending',name));time+=40000;assert.equal(await gate.allowed(root),false);
  time+=5000;assert.equal(await gate.allowed(root),true);
  gate.markBusy();assert.equal(await gate.allowed(root),false);time+=45000;assert.equal(await gate.allowed(root),true);
 }finally{assert.ok(path.basename(root).startsWith('gargantua-parser-idle-'));await fs.rm(root,{recursive:true,force:true});}
});
test('unknown parser directories fail closed',async()=>{assert.equal(await createParserIdleBarrier().allowed(path.join(os.tmpdir(),randomUUID())),false);});
