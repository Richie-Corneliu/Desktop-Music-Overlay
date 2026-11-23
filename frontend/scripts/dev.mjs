import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const devUrl = 'http://127.0.0.1:5173';

const rawArgs = process.argv.slice(2);
const isProd = rawArgs.includes('--prod');
const electronArgs = rawArgs.filter((arg) => arg !== '--prod');

const electronBin = require('electron');

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(500, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`Timed out waiting for Vite dev server at ${url}`));
        return;
      }
      setTimeout(check, 200);
    };

    check();
  });
}

function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    proc.kill('SIGTERM');
  }
}

let viteProc = null;
let electronProc = null;

const shutdown = () => {
  killProcessTree(electronProc);
  killProcessTree(viteProc);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  if (!isProd) {
    const viteCli = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
    viteProc = spawn(
      process.execPath,
      [viteCli, '--host', '127.0.0.1', '--port', '5173'],
      { cwd: rootDir, stdio: 'inherit' }
    );
    await waitForServer(devUrl);
    electronEnv.VITE_DEV_SERVER_URL = devUrl;
  } else {
    delete electronEnv.VITE_DEV_SERVER_URL;
  }

  electronProc = spawn(electronBin, ['.', ...electronArgs], {
    cwd: rootDir,
    stdio: 'inherit',
    env: electronEnv,
  });

  electronProc.on('exit', (code) => {
    killProcessTree(viteProc);
    process.exit(code ?? 0);
  });
} catch (err) {
  console.error(err);
  shutdown();
  process.exit(1);
}
