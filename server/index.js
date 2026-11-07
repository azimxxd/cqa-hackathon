import { openDatabase } from "./db.js";
import { createApp } from "./app.js";
import { startAutoRouting } from "../ai/router.js";
const db = openDatabase();
startAutoRouting();
const app = createApp(db);
const server = app.listen(Number(process.env.PORT) || 3000, () =>
  console.log(`CQA running at http://localhost:${server.address().port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    server.close(async () => {
      await Promise.all([app.locals.jobs.close(), app.locals.transcription.close()]);
      db.close();
      process.exit(0);
    });
  });
