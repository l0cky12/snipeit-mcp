import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startServer } from './rpc.mjs';

async function fixture(t, respond, env = {}) {
    const requests = [];
    const http = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = { method: req.method, url: new URL(req.url, 'http://localhost'), body: body ? JSON.parse(body) : undefined };
        requests.push(request);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(respond(request)));
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => { http.closeAllConnections(); http.close(); });
    const rpc = startServer({
        SNIPEIT_URL: `http://127.0.0.1:${http.address().port}`,
        SNIPEIT_API_TOKEN: 'test', SNIPEIT_READ_ONLY: '0', XDG_CONFIG_HOME: '/nonexistent', ...env
    });
    t.after(() => rpc.close());
    await rpc.init();
    return { rpc, requests };
}

test('invalid checkout targets and ambiguous checkins never reach the API', async t => {
    const { rpc, requests } = await fixture(t, () => ({ status: 'success', rows: [{ id: 9 }] }));
    for (const [resource, to] of [['accessories', 'asset'], ['consumables', 'location'], ['licenses', 'location'], ['components', 'user']]) {
        await assert.rejects(rpc.call('checkout', { resource, id: 1, target_id: 2, to }), /only|target/);
    }
    await assert.rejects(rpc.call('checkin', { resource: 'licenses', id: 1, from_user_id: 2, from_asset_id: 3 }), /exactly one/);
    assert.equal(requests.length, 0);
});

test('assignment lookups reach later pages even with a server page cap', async t => {
    const cases = [
        ['checkout', { resource: 'licenses', id: 1, target_id: 7 }, { id: 1, disabled: true }, { id: 8 }, '/api/v1/licenses/1/seats/8'],
        ['checkin', { resource: 'licenses', id: 1, from_user_id: 7 }, { id: 1 }, { id: 8, assigned_user: { id: 7 } }, '/api/v1/licenses/1/seats/8'],
        ['checkin', { resource: 'accessories', id: 1, from_user_id: 7 }, { id: 1, assigned_to: { id: 7, type: 'asset' } }, { id: 8, assigned_to: { id: 7, type: 'user' } }, '/api/v1/accessories/8/checkin'],
        ['checkin', { resource: 'components', id: 1, from_asset_id: 7 }, { id: 1 }, { assigned_pivot_id: 8, name: { id: 7 }, assigned_qty: 4 }, '/api/v1/components/8/checkin']
    ];
    for (const [tool, args, first, second, endpoint] of cases) {
        await t.test(`${tool} ${args.resource}`, async t => {
            const { rpc, requests } = await fixture(t, ({ method, url }) => method === 'GET'
                ? { total: 2, rows: [url.searchParams.get('offset') === '1' ? second : first] }
                : { status: 'success' });
            assert.equal((await rpc.call(tool, args)).status, 'success');
            assert.deepEqual(requests.map(r => r.method), ['GET', 'GET', args.resource === 'licenses' ? 'PUT' : 'POST']);
            assert.equal(requests.at(-1).url.pathname, endpoint);
            if (args.resource === 'components') assert.equal(requests.at(-1).body.checkin_qty, 4);
        });
    }
});

test('list filters cannot override validated pagination', async t => {
    const { rpc, requests } = await fixture(t, () => ({ total: 0, rows: [] }));
    await assert.rejects(rpc.call('list', { resource: 'hardware', filters: { limit: -1, offset: 900 } }), /filters|top-level/);
    assert.equal(requests.length, 0);
});

test('read-only mode refuses write calls, including calls to hidden tools', async t => {
    const { rpc, requests } = await fixture(t, () => ({ status: 'success' }), { SNIPEIT_READ_ONLY: '1' });
    for (const name of ['create', 'update', 'delete', 'restore', 'checkout', 'checkin', 'audit']) {
        await assert.rejects(rpc.call(name, { resource: 'hardware', id: 1, data: {}, confirm: true, target_id: 1 }));
    }
    assert.equal(requests.length, 0);
});

test('privilege and bookkeeping fields and oversized values are rejected before reaching the API', async t => {
    const { rpc, requests } = await fixture(t, () => ({ status: 'success', rows: [] }));
    const rejected = [
        ['create', { resource: 'users', data: { first_name: 'x', username: 'x', password: 'p', password_confirmation: 'p', permissions: '{"superuser":"1"}' } }],
        ['create', { resource: 'users', data: { username: 'x', 'permissions[superuser]': '1' } }],
        ['update', { resource: 'users', id: 1, data: { groups: [1] } }],
        ['update', { resource: 'groups', id: 1, data: { permissions: '{"superuser":"1"}' } }],
        ['update', { resource: 'companies', id: 1, data: { id: 9999 } }],
        ['update', { resource: 'hardware', id: 1, data: { deleted_at: null } }]
    ];
    for (const [tool, args] of rejected) await assert.rejects(rpc.call(tool, args), /cannot be written/);
    await assert.rejects(rpc.call('create', { resource: 'hardware', data: { notes: 'x'.repeat(64 * 1024 + 1) } }), /64 KB.*notes/);
    await assert.rejects(rpc.call('update', { resource: 'hardware', id: 1, data: { tags: ['x'.repeat(64 * 1024 + 1)] } }), /64 KB/);
    assert.equal(requests.length, 0);
    await rpc.call('update', { resource: 'hardware', id: 1, data: { serial: 'S', _snipeit_ram_3: '16', notes: 'x'.repeat(64 * 1024) } });
    assert.deepEqual(requests.map(r => `${r.method} ${r.url.pathname}`), ['PATCH /api/v1/hardware/1']);
    assert.equal(requests[0].body._snipeit_ram_3, '16');
});

test('list rejects payloads without rows and totals count earlier pages', async t => {
    let response;
    const { rpc } = await fixture(t, () => response);
    response = { total: 1, items: [{ id: 1 }] };
    await assert.rejects(rpc.call('list', { resource: 'hardware' }), /no rows/);
    response = { rows: [{ id: 1 }] };
    assert.equal((await rpc.call('list', { resource: 'hardware', offset: 50 })).total, 51);
    response = { assets: [{ id: 2 }] };
    assert.deepEqual((await rpc.call('list', { resource: 'hardware', user_id: 3 })).rows, [{ id: 2 }]);
});

test('checkout and checkin options that do not apply to the resource are rejected', async t => {
    const { rpc, requests } = await fixture(t, () => ({ status: 'success' }));
    const cases = [
        ['checkout', { resource: 'licenses', id: 1, target_id: 2, quantity: 2 }, /quantity/],
        ['checkout', { resource: 'licenses', id: 1, target_id: 2, expected_checkin: '2030-01-01', status_id: 1, name: 'x' }, /expected_checkin, status_id, name/],
        ['checkout', { resource: 'hardware', id: 1, target_id: 2, quantity: 2 }, /quantity/],
        ['checkin', { resource: 'hardware', id: 1, from_user_id: 2 }, /from_user_id/],
        ['checkin', { resource: 'hardware', id: 1, from_asset_id: 2 }, /from_asset_id/],
        ['checkin', { resource: 'accessories', id: 1, from_user_id: 2, status_id: 1 }, /status_id/]
    ];
    for (const [tool, args, message] of cases) await assert.rejects(rpc.call(tool, args), message);
    assert.equal(requests.length, 0);
    await rpc.call('checkout', { resource: 'hardware', id: 1, target_id: 2, note: 'n', expected_checkin: '2030-01-01', status_id: 1, name: 'x' });
    assert.equal(requests.length, 1);
});

test('network failures include the underlying cause', async t => {
    const closed = createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise(resolve => closed.close(resolve));
    const rpc = startServer({ SNIPEIT_URL: `http://127.0.0.1:${port}`, SNIPEIT_API_TOKEN: 'x', XDG_CONFIG_HOME: '/nonexistent' });
    t.after(() => rpc.close());
    await rpc.init();
    await assert.rejects(rpc.call('get', { resource: 'hardware', id: 1 }), /fetch failed \(.*ECONNREFUSED/);
});
