import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnipeIT, trim } from '../dist/snipeit.js';
import { startServer } from './rpc.mjs';

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
