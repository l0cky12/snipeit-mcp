import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('both bootstrap entrypoints use the test directory and replace loose token files', t => {
    const dir = mkdtempSync(join(tmpdir(), 'snipeit-harness-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'test'));
    mkdirSync(join(dir, 'bin'));
    for (const script of ['snipeit-up.sh', 'test/snipeit-up.sh']) copyFileSync(resolve(script), join(dir, script));
    writeFileSync(join(dir, 'bin/curl'), '#!/bin/sh\necho 200\n', { mode: 0o755 });
    writeFileSync(join(dir, 'bin/docker'), `#!/bin/sh
test "$PWD" = "$HARNESS_TEST_DIR/test" || exit 1
case "$*" in
    *"migrate:status"*) echo Ran ;;
    *"tinker"*) printf 'test-token\\n' ;;
esac
`, { mode: 0o755 });
    const token = join(dir, 'test/.snipeit-token');
    writeFileSync(token, 'old', { mode: 0o644 });
    for (const script of ['snipeit-up.sh', 'test/snipeit-up.sh']) {
        const result = spawnSync('bash', [join(dir, script)], {
            env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, HARNESS_TEST_DIR: dir },
            encoding: 'utf8', timeout: 5000
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(token, 'utf8'), 'test-token');
        assert.equal(statSync(token).mode & 0o777, 0o600);
    }
});
