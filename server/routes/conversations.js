import { Router } from 'express';
import { importGroup, getConversation } from '../import.js';
import { getEvaluation } from '../evaluations.js';
import { asyncRoute, fail } from '../http.js';
export function conversationRoutes(db) {
 const router=Router();
 router.post('/import',asyncRoute(async(req,res)=>res.json({imported:await importGroup(db,req.body.group_id)})));
 router.get('/conversations',(_req,res)=>res.json(db.prepare(`SELECT c.conversation_id,c.channel,c.language,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.conversation_id) AS message_count,
  (SELECT id FROM evaluations e WHERE e.conversation_id=c.conversation_id ORDER BY id DESC LIMIT 1) AS evaluation_id
  FROM conversations c ORDER BY c.conversation_id`).all().map(({evaluation_id,...row})=>{
   const e=evaluation_id?getEvaluation(db,evaluation_id):null;
   return {...row,total:e?.total??null,gross_error:e?.gross_error??false,status:e?.status??null};
  })));
 router.get('/conversations/:id',(req,res)=>{const c=getConversation(db,req.params.id);if(!c)throw fail(404,'Conversation not found');res.json(c);});
 return router;
}
