// Offline replacement for the live stress suite: never loads DEV or .env.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
console.log('Offline edge cases: stubbed providers and temporary databases; no model accuracy measurement.');
const files=['../ai/review.test.js','../ai/compatibility.test.js','../server/integration.test.js']
  .map(file=>fileURLToPath(new URL(file,import.meta.url)));
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
if(result.error) {console.error(result.error.message);process.exitCode=1;}
else process.exitCode=result.status ?? 1;
