import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDatabase } from "./db.js";
import {
  normalizeConversation,
  saveConversations,
  getConversation,
  importGroup,
} from "./import.js";
const sample = JSON.parse(
  readFileSync(new URL("../shared/mocks/conversation.json", import.meta.url)),
);
test("import assigns stable IDs, preserves timestamps, rejects changing existing content atomically", () => {
  const db = openDatabase(":memory:");
  try {
    saveConversations(db, [sample], "DEV");
    saveConversations(db, [sample], "DEV");
    assert.deepEqual(getConversation(db, sample.conversation_id), sample);
    assert.throws(() =>
      saveConversations(
        db,
        [
          { ...sample, conversation_id: "new" },
          { ...sample, messages: [] },
        ],
        "DEV",
      ),
    );
    assert.equal(getConversation(db, "new"), null);
    const voice = normalizeConversation({
      ...sample,
      channel: "voice call",
      messages: [
        { ...sample.messages[0], timestamp: "2026-11-08T10:00:00+05:00" },
        { ...sample.messages[1], timestamp: "2026-11-08T05:01:30Z" },
      ],
    });
    assert.equal(voice.messages[1].offset_sec, 90);
    assert.throws(() =>
      normalizeConversation({
        ...voice,
        messages: [{ ...voice.messages[0], timestamp: "2026-11-08T10:00:00" }],
      }),
    );
  } finally {
    db.close();
  }
});
test("organizers GET includes group_id and requires success", async () => {
  const db = openDatabase(":memory:");
  try {
    const imported = await importGroup(db, "DEV", {
      url: "https://example.test/api?x=1",
      fetchImpl: async (url) => {
        assert.equal(url.searchParams.get("group_id"), "DEV");
        return {
          ok: true,
          json: async () => ({ isSuccess: true, data: [sample] }),
        };
      },
    });
    assert.equal(imported, 1);
    await assert.rejects(
      importGroup(db, "DEV", {
        url: "https://example.test",
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ isSuccess: false }),
        }),
      }),
    );
  } finally {
    db.close();
  }
});

test('organizer records transcript shape, HH:MM:SS and compact ISO zones normalize explicitly',async()=>{
 const db=openDatabase(':memory:');
 try {
  const raw={conversation_id:'synthetic-chat',channel:'agent chat',language:'RU',transcript:[
   {timestamp:'01:02:03',speaker:'client',text:'Synthetic request'},
   {timestamp:'01:03:04',speaker:'operator',text:'Synthetic reply'},
  ]};
  assert.equal(await importGroup(db,'TEST',{url:'https://organizer.test',fetchImpl:async()=>Response.json({isSuccess:true,data:{records:[raw]}})}),1);
  assert.equal(getConversation(db,raw.conversation_id).messages[1].offset_sec,61);
  const voice=normalizeConversation({...raw,channel:'voice call',transcript:raw.transcript.map((m,i)=>({...m,timestamp:`2026-01-01T01:02:0${3+i}+0500`}))});
  assert.equal(voice.messages[1].offset_sec,1);
  assert.throws(()=>normalizeConversation({...raw,channel:'other'}),/channel.*other/);
  assert.throws(()=>normalizeConversation({...raw,transcript:[{...raw.transcript[0],speaker:'unknown'}]}),/speaker.*unknown/);
  assert.throws(()=>normalizeConversation({...raw,transcript:[raw.transcript[1],raw.transcript[0]]}),/synthetic-chat.*m002.*chronological/);
 }finally {db.close();}
});

test('import errors map configuration, network, timeout, JSON and organizer errors to useful HTTP status',async()=>{
 const db=openDatabase(':memory:');
 const response=(body,status=200)=>async()=>new Response(body,{status});
 const cases=[
  ['',response('{}'),503,/ORG_API_URL/],['not a URL',response('{}'),503,/ORG_API_URL/],['file:///tmp/a',response('{}'),503,/ORG_API_URL/],
  ['https://org.test',async()=>{throw Error('connection lost');},502,/connection lost/],
  ['https://org.test',async()=>{throw new DOMException('expired','TimeoutError');},504,/timeout/i],
  ['https://org.test',response('busy',503),502,/HTTP 503/],
  ['https://org.test',response('<html>bad gateway</html>'),502,/JSON/],
  ['https://org.test',response(JSON.stringify({isSuccess:false,error:'unknown group'})),502,/unknown group/],
  ['https://org.test',response(JSON.stringify({isSuccess:1})),502,/isSuccess/],
  ['https://org.test',response(JSON.stringify({isSuccess:true,data:{records:{}}})),502,/array/],
  ['https://org.test',response(JSON.stringify({isSuccess:true,data:{records:[{conversation_id:'bad'}]}})),502,/Invalid import/],
 ];
 try {for(const [url,fetchImpl,status,pattern] of cases) await assert.rejects(importGroup(db,'TEST',{url,fetchImpl}),e=>{assert.equal(e.status,status,e.message);assert.match(e.message,pattern);return true;});}
 finally {db.close();}
});

test('changed conversations return all conflicting IDs with 409 and roll back the full batch',async()=>{
 const db=openDatabase(':memory:');
 try {
  saveConversations(db,[{...sample,conversation_id:'conflict-a'},{...sample,conversation_id:'conflict-b'}],'TEST');
  const records=['new-id','conflict-a','conflict-b'].map(conversation_id=>({...sample,conversation_id,messages:[]}));
  await assert.rejects(importGroup(db,'TEST',{url:'https://org.test',fetchImpl:async()=>Response.json({isSuccess:true,data:{records}})}),e=>{
   assert.equal(e.status,409);assert.deepEqual(e.conflict_ids,['conflict-a','conflict-b']);assert.match(e.message,/conflict-a.*conflict-b/);return true;
  });assert.equal(getConversation(db,'new-id'),null);
 }finally {db.close();}
});
