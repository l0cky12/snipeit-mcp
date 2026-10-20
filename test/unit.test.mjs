import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnipeIT, trim } from '../dist/snipeit.js';
import { startServer } from './rpc.mjs';
import { createServer } from 'node:http';

test('redirects are not followed and a stalled response body times out', async t => {
    let requests = 0;
    const server = createServer((req, res) => {
        requests++;
        if (req.url.endsWith('/redirect')) {
            res.writeHead(302, { Location: '/api/v1/destination' });
            res.end();
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const api = new SnipeIT(`http://127.0.0.1:${server.address().port}`, 't');
    await assert.rejects(api.get('redirect'), /fetch failed/);
    assert.equal(requests, 1);
    const timeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, 'timeout', ms => {
        assert.equal(ms, 30_000);
        return timeout(50);
    });
    await assert.rejects(api.get('stall'), /abort|timeout/i);
});

test('pagination stops at exhaustion or an empty page and rejects malformed totals', async t => {
    const api = new SnipeIT('http://x', 't');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return Response.json({ total: 1, rows: [{ id: 1 }] });
    });
    assert.equal(await api.findRow('hardware', () => false), undefined);
    assert.equal(calls, 1);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ total: 9, rows: [] }));
    assert.equal(await api.findRow('hardware', () => false), undefined);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ total: 'invalid', rows: [{ id: 1 }] }));
    await assert.rejects(api.findRow('hardware', () => false), /invalid total/);
});

test('HTTP client rejects redirects and non-JSON success, and bounds requests', async t => {
    const api = new SnipeIT('http://x', 't');
    let options;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        options = init;
        return new Response('<html>Login</html>');
    });
    await assert.rejects(api.post('hardware', {}), /JSON/);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
});

test('HTTP null error bodies keep the status instead of throwing a TypeError', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('null', { status: 502 }));
    await assert.rejects(new SnipeIT('http://x', 't').get('hardware'), /HTTP 502/);
});

test('invalid base URLs fail before sending credentials', () => {
    for (const url of ['ftp://x', 'http://user:password@x', 'https://x?proxy=1', 'https://x#fragment']) {
        assert.throws(() => new SnipeIT(url, 'secret'), /URL/);
    }
});

test('custom field metadata retries failed requests and includes later pages', async t => {
    const api = new SnipeIT('http://x', 't');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async url => {
        if (++calls === 1) return new Response('{}', { status: 503 });
        const offset = Number(url.searchParams.get('offset'));
        return Response.json({ total: 2, rows: [{ name: offset ? 'Second' : 'First', db_column_name: `_snipeit_${offset}` }] });
    });
    await assert.rejects(api.customFields(), /503/);
    assert.deepEqual(await api.mapCustomFields({ Second: 'value' }), { _snipeit_1: 'value' });
    assert.equal(calls, 3);
});

test('trim only collapses date wrappers and preserves special JSON keys', () => {
    assert.deepEqual(trim({ formatted: 'display', value: 3 }), { formatted: 'display', value: 3 });
    const input = JSON.parse('{"__proto__":{"safe":true},"custom_fields":{"__proto__":{"value":"custom"}}}');
    assert.equal(JSON.stringify(trim(input)), '{"__proto__":{"safe":true},"custom_fields":{"__proto__":"custom"}}');
});

test('trim collapses Snipe-IT wrappers', () => {
    const raw = {
        id: 1,
        name: '',
        notes: null,
        warranty: {},
        custom_fields: [],
        created_at: { datetime: '2024-01-01 10:00:00', formatted: 'Jan 1' },
        purchase_date: { date: '2023-05-05', formatted: 'May 5' },
        available_actions: { update: true },
        model: { id: 3, name: 'X', image: 'x.png' },
        rows: [{ a: null, b: 0, c: false }]
    };
    assert.deepEqual(trim(raw), {
        id: 1,
        created_at: '2024-01-01 10:00:00',
        purchase_date: '2023-05-05',
        model: { id: 3, name: 'X' },
        rows: [{ b: 0, c: false }]
    });
    assert.deepEqual(trim({ custom_fields: { 'MAC Address': { field: '_snipeit_mac_5', value: 'aa:bb', field_format: 'MAC' }, RAM: { value: null } } }), {
        custom_fields: { 'MAC Address': 'aa:bb' }
    });
});

test('custom field names map to db columns and raw keys pass through', async t => {
    const api = new SnipeIT('http://x', 't');
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ rows: [{ name: 'MAC Address', db_column_name: '_snipeit_mac_address_5' }] })));
    assert.deepEqual(await api.mapCustomFields({ name: 'pc', 'mac address': 'aa', _snipeit_ram_3: '16' }), {
        name: 'pc',
        _snipeit_mac_address_5: 'aa',
        _snipeit_ram_3: '16'
    });
});

test('Snipe-IT status:error bodies become thrown errors', async t => {
    const api = new SnipeIT('http://x', 't');
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 'error', messages: { asset_tag: ['taken'] } })));
    await assert.rejects(api.post('hardware', {}), /taken/);
});

test('server exposes 11 tools, 4 in read-only mode, and refuses to start unconfigured', async () => {
    const env = { SNIPEIT_URL: 'http://127.0.0.1:9', SNIPEIT_API_TOKEN: 'x', XDG_CONFIG_HOME: '/nonexistent' };
    const s = startServer(env);
    const init = await s.init();
    assert.match(init.instructions, /Snipe-IT/);
    const tools = (await s.send('tools/list', {})).tools.map(t => t.name).sort();
    assert.deepEqual(tools, ['audit', 'checkin', 'checkout', 'create', 'delete', 'describe', 'get', 'list', 'lookup', 'restore', 'update']);
    await assert.rejects(s.call('delete', { resource: 'hardware', id: 1 }), /confirm/);
    s.close();

    const r = startServer({ ...env, SNIPEIT_READ_ONLY: '1' });
    await r.init();
    assert.deepEqual((await r.send('tools/list', {})).tools.map(t => t.name).sort(), ['describe', 'get', 'list', 'lookup']);
    r.close();

    const u = startServer({ XDG_CONFIG_HOME: '/nonexistent', SNIPEIT_URL: '', SNIPEIT_API_TOKEN: '' });
    const { code, stderr } = await u.exited;
    assert.equal(code, 1);
    assert.match(stderr, /snipeit-mcp setup/);
});
