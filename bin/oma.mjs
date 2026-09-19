#!/usr/bin/env node
import { run } from '../skill/scripts/oma.mjs';

try {
  process.exitCode = await run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error?.code ?? 'invalid-request' })}\n`);
  process.exitCode = 1;
}
