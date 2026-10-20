import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, setup } from '../dist/config.js';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';

function config(t, contents) {
    const dir = mkdtempSync(join(tmpdir(), 'snipeit-config-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ['XDG_CONFIG_HOME', 'SNIPEIT_URL', 'SNIPEIT_API_TOKEN', 'SNIPEIT_READ_ONLY', 'SNIPEIT_ALLOW_HTTP']) {
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

test('invalid URLs fail at load time and plain HTTP is limited to loopback and private networks', t => {
    config(t);
    process.env.SNIPEIT_API_TOKEN = 'secret';
    process.env.SNIPEIT_URL = 'garbage';
    assert.throws(loadConfig, /Snipe-IT URL must be an absolute HTTP\(S\) URL/);
    const allowed = ['https://203.0.113.5', 'http://localhost:8080', 'http://snipe.localhost', 'http://127.0.0.2', 'http://[::1]',
        'http://10.1.2.3', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.138:8080'];
    for (const url of allowed) {
        process.env.SNIPEIT_URL = url;
        assert.doesNotThrow(loadConfig, url);
    }
    for (const url of ['http://203.0.113.5', 'http://172.32.0.1', 'http://192.169.0.1', 'http://snipe.example.com', 'http://localhost.example.com']) {
        process.env.SNIPEIT_URL = url;
        assert.throws(loadConfig, /SNIPEIT_ALLOW_HTTP=1/, url);
    }
    const warn = t.mock.method(console, 'error', () => {});
    process.env.SNIPEIT_ALLOW_HTTP = '1';
    assert.equal(loadConfig().url, 'http://localhost.example.com');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /unencrypted/);
});

test('setup does not echo the API token on a terminal', async t => {
    config(t);
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    t.after(() => Object.defineProperty(process, 'stdin', stdin));
    let out = '';
    t.mock.method(process.stdout, 'write', chunk => {
        out += chunk;
        if (String(chunk).includes('Snipe-IT URL')) setImmediate(() => input.write('http://localhost\r'));
        if (String(chunk).includes('input hidden')) setImmediate(() => input.write('super-secret-token\r'));
        return true;
    });
    t.mock.method(console, 'log', () => {});
    let auth;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        auth = init.headers.Authorization;
        return Response.json({ username: 'test', permissions: { superuser: '1' } });
    });
    await setup();
    assert.equal(auth, 'Bearer super-secret-token');
    assert.match(out, /http:\/\/localhost/);
    assert.doesNotMatch(out, /super-secret-token/);
});
