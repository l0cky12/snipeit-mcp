import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, setup } from '../dist/config.js';
import { createInterface } from 'node:readline/promises';

function config(t, contents) {
    const dir = mkdtempSync(join(tmpdir(), 'snipeit-config-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ['XDG_CONFIG_HOME', 'SNIPEIT_URL', 'SNIPEIT_API_TOKEN', 'SNIPEIT_READ_ONLY']) {
        const previous = process.env[key];
        t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
        delete process.env[key];
    }
    process.env.XDG_CONFIG_HOME = dir;
    mkdirSync(join(dir, 'snipeit-mcp'));
    const path = join(dir, 'snipeit-mcp/config.json');
    if (contents !== undefined) writeFileSync(path, contents, { mode: 0o644 });
    return path;
}

test('configuration rejects malformed files and invalid read-only values', t => {
    const path = config(t);
    process.env.SNIPEIT_URL = 'http://localhost';
    process.env.SNIPEIT_API_TOKEN = 'secret';
    for (const contents of ['null', '[]', '{broken', '{"readOnly":"false"}', '{"token":4}']) {
        writeFileSync(path, contents);
        assert.throws(loadConfig, /config/i);
    }
    writeFileSync(path, '{}');
    for (const value of ['', 'treu', 'enabled', '2']) {
        process.env.SNIPEIT_READ_ONLY = value;
        assert.throws(loadConfig, /SNIPEIT_READ_ONLY/);
    }
    for (const [value, expected] of [['1', true], [' TRUE ', true], ['yes', true], ['0', false], ['false', false], ['no', false]]) {
        process.env.SNIPEIT_READ_ONLY = value;
        assert.equal(loadConfig().readOnly, expected);
    }
});

test('setup replaces loose token files with owner-only files and preserves read-only', async t => {
    const path = config(t, JSON.stringify({ url: 'http://old', token: 'old', readOnly: true }));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const proto = Object.getPrototypeOf(rl);
    rl.close();
    const answers = ['http://localhost', 'new-token'];
    t.mock.method(proto, 'question', async () => answers.shift());
    t.mock.method(globalThis, 'fetch', async () => Response.json({ username: 'test', permissions: { superuser: '1' } }));
    await setup();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { url: 'http://localhost', token: 'new-token', readOnly: true });
});
