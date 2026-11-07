import express from 'express';
import { fileURLToPath } from 'node:url';
import { conversationRoutes } from './routes/conversations.js';
import { checklistRoutes } from './routes/checklists.js';
import { evaluationRoutes } from './routes/evaluations.js';
export function createApp(db) {
 const app=express();
 app.use(express.json({limit:'5mb'}));
 app.get('/api/health',(_req,res)=>res.json({ok:true}));
 app.use('/api',conversationRoutes(db),checklistRoutes(db),evaluationRoutes(db));
 app.use('/api',(_req,res)=>res.status(404).json({error:'Route not found'}));
 app.use(express.static(fileURLToPath(new URL('../web',import.meta.url))));
 app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.status&&err.status<500?err.message:'Internal server error'}));
 return app;
}
