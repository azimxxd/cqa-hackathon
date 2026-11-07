import { openDatabase } from './db.js';
import { createApp } from './app.js';
const db=openDatabase();
const app=createApp(db);
const server=app.listen(Number(process.env.PORT)||3000,()=>console.log(`CQA running at http://localhost:${server.address().port}`));
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await app.locals.jobs.close();server.close(()=>{db.close();process.exit(0);});});
