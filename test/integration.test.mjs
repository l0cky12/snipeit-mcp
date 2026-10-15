// End-to-end against the throwaway Snipe-IT from test/snipeit-up.sh (seeded demo data).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startServer } from './rpc.mjs';

const BASE = process.env.SNIPEIT_URL || 'http://localhost:8765';
const TOKEN = process.env.SNIPEIT_API_TOKEN || readFileSync(new URL('./.snipeit-token', import.meta.url), 'utf8').trim();
const s = startServer({ SNIPEIT_URL: BASE, SNIPEIT_API_TOKEN: TOKEN, XDG_CONFIG_HOME: '/nonexistent' });
const tag = `MCP-TEST-${Date.now()}`;
let user, model, status, asset;

before(async () => {
    await s.init();
    user = (await s.call('list', { resource: 'users', limit: 1, filters: { username: 'admin' } })).rows[0] ?? (await s.call('list', { resource: 'users', limit: 1 })).rows[0];
    model = (await s.call('list', { resource: 'models', limit: 1 })).rows[0];
    status = (await s.call('list', { resource: 'status_labels', limit: 50 })).rows.find(r => r.type === 'deployable');
    assert.ok(user && model && status, 'demo data present');
});
after(async () => {
    if (asset) await s.call('delete', { resource: 'hardware', id: asset.id, confirm: true }).catch(() => {});
    s.close();
});

test('describe hardware includes custom fields from the instance', async () => {
    const d = await s.call('describe', { resource: 'hardware' });
    assert.match(d, /asset_tag\*/);
    assert.match(d, /custom fields on this instance/);
});

test('hardware lifecycle: create, lookup, update, checkout, list by user, checkin, audit, delete, restore, activity', async () => {
    const created = await s.call('create', { resource: 'hardware', data: { asset_tag: tag, model_id: model.id, status_id: status.id, name: 'mcp test box', serial: `${tag}-SN` } });
    assert.equal(created.status, 'success');
    asset = created.payload;
    assert.equal((await s.call('lookup', { asset_tag: tag })).id, asset.id);
    assert.equal((await s.call('lookup', { serial: `${tag}-SN` }))[0].id, asset.id);
    assert.equal((await s.call('update', { resource: 'hardware', id: asset.id, data: { name: 'renamed' } })).status, 'success');
    assert.equal((await s.call('get', { resource: 'hardware', id: asset.id })).name, 'renamed');

    assert.equal((await s.call('checkout', { resource: 'hardware', id: asset.id, to: 'user', target_id: user.id, note: 'e2e' })).status, 'success');
    const mine = await s.call('list', { resource: 'hardware', user_id: user.id, limit: 500 });
    assert.ok(mine.rows.some(r => r.id === asset.id), 'asset listed under user');
    assert.equal((await s.call('checkin', { resource: 'hardware', id: asset.id, note: 'back' })).status, 'success');
    assert.equal((await s.call('audit', { id: asset.id, note: 'audited' })).status, 'success');

    assert.equal((await s.call('delete', { resource: 'hardware', id: asset.id, confirm: true })).status, 'success');
    assert.equal((await s.call('restore', { resource: 'hardware', id: asset.id })).status, 'success');
    assert.equal((await s.call('get', { resource: 'hardware', id: asset.id })).id, asset.id);

    const log = await s.call('list', { resource: 'activity', filters: { item_type: 'asset', item_id: asset.id }, limit: 50 });
    const actions = log.rows.map(r => r.action_type);
    for (const a of ['create new', 'update', 'checkout', 'checkin from', 'audit', 'delete', 'restore']) assert.ok(actions.includes(a), `activity has ${a}: ${actions}`);
});

test('accessory checkout and checkin by user', async () => {
    const acc = (await s.call('list', { resource: 'accessories', limit: 50 })).rows.find(r => (r.remaining_qty ?? 0) > 0);
    assert.ok(acc, 'an accessory with stock');
    assert.equal((await s.call('checkout', { resource: 'accessories', id: acc.id, target_id: user.id })).status, 'success');
    assert.equal((await s.call('checkin', { resource: 'accessories', id: acc.id, from_user_id: user.id })).status, 'success');
});

test('license seat checkout and checkin by user', async () => {
    const lic = (await s.call('list', { resource: 'licenses', limit: 50 })).rows.find(r => (r.free_seats_count ?? 0) > 0);
    assert.ok(lic, 'a license with free seats');
    assert.equal((await s.call('checkout', { resource: 'licenses', id: lic.id, target_id: user.id })).status, 'success');
    assert.equal((await s.call('checkin', { resource: 'licenses', id: lic.id, from_user_id: user.id })).status, 'success');
});

test('component checkout to asset and checkin', async () => {
    const comp = (await s.call('list', { resource: 'components', limit: 50 })).rows.find(r => (r.remaining ?? r.qty ?? 0) > 0);
    assert.ok(comp && asset, 'a component with stock and the test asset');
    assert.equal((await s.call('checkout', { resource: 'components', id: comp.id, to: 'asset', target_id: asset.id, quantity: 1 })).status, 'success');
    assert.equal((await s.call('checkin', { resource: 'components', id: comp.id, from_asset_id: asset.id, quantity: 1 })).status, 'success');
});

test('consumable checkout to user', async () => {
    const con = (await s.call('list', { resource: 'consumables', limit: 50 })).rows.find(r => (r.remaining ?? 0) > 0);
    assert.ok(con, 'a consumable with stock');
    assert.equal((await s.call('checkout', { resource: 'consumables', id: con.id, target_id: user.id })).status, 'success');
});

test('delete without confirm and bad resource are rejected before hitting the API', async () => {
    await assert.rejects(s.call('delete', { resource: 'users', id: user.id }), /confirm/);
    await assert.rejects(s.call('get', { resource: 'activity', id: 1 }));
});
