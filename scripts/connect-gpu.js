// Restore the laptop-to-GPU link without exposing Ollama to the public network.
import { execFileSync } from 'node:child_process';
import { loadRegisteredEndpoint, ollamaUrl, probe, ollamaModel } from '../ai/router.js';

try {
  loadRegisteredEndpoint();
  if (await probe()) {
    console.log(`GPU connection already works; ${ollamaModel()} is available.`);
  } else {
    const url = new URL(ollamaUrl());
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname))
      throw Error('Configured Ollama endpoint is not local; this command only restores a localhost SSH tunnel');
    const port = url.port || '80';
    const host = process.env.GPU_SSH_HOST || 'loxlka-d05391';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) throw Error('Invalid GPU_SSH_HOST');
    execFileSync('ssh', ['-fN', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${port}:127.0.0.1:11434`, host], { stdio: 'inherit', timeout: 25000 });
    if (!await probe()) throw Error('SSH connected, but Ollama or the configured model is unavailable on the GPU server');
    console.log(`GPU connection restored; ${ollamaModel()} is available. Auto routing will refresh within 20 seconds.`);
  }
} catch (error) {
  console.error(`[gpu:connect] ${error.message}`);
  process.exitCode = 1;
}
