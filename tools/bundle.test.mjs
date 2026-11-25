import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('想法画布.html matches what src/ bundles to', () => {
  const script = fileURLToPath(new URL('./bundle.sh', import.meta.url));
  const result = spawnSync('/bin/bash', [script, '--check'], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
