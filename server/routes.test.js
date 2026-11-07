import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { saveConversations } from './import.js';
const conversation=JSON.parse(readFileSync(new URL('../shared/mocks/conversation.json',import.meta.url)));
export async function fixture(fn, options) {
 const db=openDatabase(':memory:');saveConversations(db,[conversation],'DEV');
 const server=createApp(db,options).listen(0);await new Promise(r=>server.once('listening',r));
 const request=async(path,body)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 try{await fn(request,db);}finally{await new Promise(r=>server.close(r));db.close();}
}
test('real routes return persisted conversations and immutable checklist versions',()=>fixture(async request=>{
 assert.deepEqual((await request('/conversations/mock-ru-001')).body,conversation);
 assert.equal((await request('/conversations')).body[0].total,null);
 assert.equal((await request('/conversations/missing')).status,404);
 const first=(await request('/checklists/latest')).body;
 const next=await request('/checklists',{...first,name:'new'});
 assert.equal(next.status,201);assert.equal(next.body.id,2);
 assert.equal((await request('/checklists/1')).body.name,first.name);
 assert.equal((await request('/checklists',{...first,criteria:[{...first.criteria[0],weight:-1}]})).status,400);
 assert.equal((await request('/evaluations')).status,404);
}));
