import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Config } from './config.js';
import { RESOURCES, SnipeIT, trim, type Resource, type Row } from './snipeit.js';

const ALL = Object.keys(RESOURCES) as [Resource, ...Resource[]];
const WRITABLE = ALL.filter(r => r !== 'activity') as [Resource, ...Resource[]];
const CHECKOUTABLE = ['hardware', 'accessories', 'consumables', 'components', 'licenses'] as const;
/** Privilege and bookkeeping keys the agent may not write: permissions/groups would let it mint admins. */
const RESERVED = /^(permissions|groups|id|created_at|updated_at|deleted_at)(\[|\.|$)/i;
const MAX_STRING_BYTES = 64 * 1024;
/** Options each checkout/checkin handler actually sends; anything else is rejected instead of silently ignored. */
const OPTIONS: Record<'checkout' | 'checkin', Record<(typeof CHECKOUTABLE)[number], string[]>> = {
    checkout: { hardware: ['expected_checkin', 'status_id', 'name'], accessories: ['quantity'], consumables: ['quantity'], components: ['quantity'], licenses: [] },
    checkin: { hardware: ['status_id', 'location_id'], accessories: ['from_user_id'], components: ['from_asset_id', 'quantity'], licenses: ['from_user_id', 'from_asset_id'], consumables: [] }
};

/** Field docs served by `describe`, kept out of tool descriptions so they only cost tokens when asked for. */
const FIELDS: Record<Resource, string> = {
    hardware:
        'create/update: asset_tag* (omit if auto-increment is on), model_id*, status_id*, name, serial, company_id, supplier_id, location_id, rtd_location_id (default location), purchase_date YYYY-MM-DD, purchase_cost, order_number, warranty_months, notes, requestable, archived, byod, last_audit_date, next_audit_date, assigned_user|assigned_asset|assigned_location (checkout on create). Custom fields may be passed by their display name.\n' +
        'list filters: status (RTD|Deployed|Undeployable|Deleted|Archived|Requestable), status_id, model_id, category_id, manufacturer_id, company_id, location_id, supplier_id, order_number, assigned_to + assigned_type (user|asset|location).',
    users:
        'create: first_name*, username*, password*, password_confirmation*. create/update: last_name, email, employee_num, jobtitle, phone, manager_id, department_id, location_id, company_id, activated, remote, vip, notes, start_date, end_date. Groups and permissions cannot be set through this server.\n' +
        'list filters: username, email, employee_num, first_name, last_name, department_id, company_id, location_id, group_id, deleted (true = only deleted), all (true = deleted + active).',
    licenses:
        'create/update: name*, seats*, category_id*, company_id, manufacturer_id, supplier_id, serial (product key), license_name, license_email, order_number, purchase_order, purchase_cost, purchase_date, expiration_date, termination_date, maintained, reassignable, depreciation_id, notes.\n' +
        'list filters: company_id, manufacturer_id, supplier_id, category_id, product_key, license_name, license_email, expiring, maintained, deleted.',
    accessories:
        'create/update: name*, qty*, category_id*, company_id, manufacturer_id, supplier_id, location_id, model_number, order_number, purchase_date, purchase_cost, min_amt, notes.\nlist filters: company_id, category_id, manufacturer_id, supplier_id, location_id.',
    consumables:
        'create/update: name*, qty*, category_id*, company_id, manufacturer_id, supplier_id, location_id, model_number, item_no, order_number, purchase_date, purchase_cost, min_amt, notes.\nlist filters: company_id, category_id, manufacturer_id, location_id.',
    components:
        'create/update: name*, qty*, category_id*, company_id, manufacturer_id, supplier_id, location_id, model_number, serial, order_number, purchase_date, purchase_cost, min_amt, notes.\nlist filters: company_id, category_id, location_id.',
    locations: 'create/update: name*, parent_id, address, address2, city, state, country, zip, phone, fax, currency, ldap_ou, manager_id, company_id, notes.',
    companies: 'create/update: name*, phone, fax, email, notes.',
    categories:
        'create/update: name*, category_type* (asset|accessory|consumable|component|license), eula_text, use_default_eula, require_acceptance, checkin_email, notes.\nlist filters: category_type.',
    manufacturers: 'create/update: name*, url, support_url, support_phone, support_email, warranty_lookup_url, notes.',
    models:
        'create/update: name*, category_id*, manufacturer_id, model_number, fieldset_id, eol (months), depreciation_id, min_amt, requestable, notes.\nlist filters: category_id, manufacturer_id, fieldset_id.',
    status_labels: 'create/update: name*, type* (deployable|pending|undeployable|archived), color (#hex), show_in_nav, default_label, notes.',
    suppliers: 'create/update: name*, address, address2, city, state, country, zip, phone, fax, email, contact, url, notes.',
    departments: 'create/update: name*, company_id, manager_id, location_id, phone, fax, notes.',
    groups: 'create/update: name*. Permissions cannot be set through this server.',
    fields:
        'create/update: name*, element* (text|textarea|listbox|checkbox|radio|email|url|numeric|date), format (ANY|ALPHA|NUMERIC|EMAIL|URL|IP|MAC|DATE|BOOLEAN|regex:...), field_values (newline-separated options), help_text, show_in_email, show_in_listview, is_unique, display_in_user_view, auto_add_to_fieldsets.',
    fieldsets: 'create/update: name*. Attach fields with update on the field (fieldset_id) or via the web UI.',
    maintenances:
        'create/update: asset_id*, title*, asset_maintenance_type* (Maintenance|Repair|Upgrade|PAT test|Calibration|Software Support|Hardware Support|Configuration Change), supplier_id*, start_date*, completion_date, cost, is_warranty, notes.\nlist filters: asset_id.',
    activity:
        'read-only audit log. list filters: item_type (asset|accessory|consumable|component|license|user), item_id, action_type ("create new"|update|checkout|"checkin from"|audit|delete|restore|uploaded|accepted|declined|requested), target_type (user|asset|location), target_id.'
};

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (d: unknown) => text(JSON.stringify(d));
const run =
    <A>(fn: (a: A) => Promise<unknown>) =>
    async (a: A) => {
        try {
            const r = await fn(a);
            return typeof r === 'string' ? text(r) : json(r);
        } catch (e) {
            // fetch() reports only "fetch failed"; the cause says ECONNREFUSED, ENOTFOUND, certificate errors etc.
            const cause = (e as { cause?: { message?: string; code?: string } })?.cause;
            const detail = cause?.message || cause?.code;
            return { ...text((e instanceof Error ? e.message : String(e)) + (detail ? ` (${detail})` : '')), isError: true };
        }
    };

function checkData(data: Row): void {
    const reserved = Object.keys(data).filter(k => RESERVED.test(k));
    if (reserved.length) throw new Error(`These fields cannot be written through this server: ${reserved.join(', ')}`);
    const oversized = (v: unknown): boolean =>
        typeof v === 'string' ? Buffer.byteLength(v) > MAX_STRING_BYTES : !!v && typeof v === 'object' && Object.values(v).some(oversized);
    const big = Object.keys(data).filter(k => oversized(data[k]));
    if (big.length) throw new Error(`Values longer than ${MAX_STRING_BYTES / 1024} KB are not accepted: ${big.join(', ')}`);
}

function checkOptions(tool: 'checkout' | 'checkin', args: { resource: (typeof CHECKOUTABLE)[number] }): void {
    const allowed = ['resource', 'id', 'to', 'target_id', 'note', ...OPTIONS[tool][args.resource]];
    const bad = Object.entries(args).filter(([k, v]) => v !== undefined && !allowed.includes(k)).map(([k]) => k);
    if (bad.length) throw new Error(`${tool} ${args.resource} does not use: ${bad.join(', ')}`);
}

const id = z.number().int().positive();
const ro = { readOnlyHint: true, destructiveHint: false };
const rw = { readOnlyHint: false, destructiveHint: false };

export function buildServer(cfg: Config): McpServer {
    const api = new SnipeIT(cfg.url, cfg.token);
    const server = new McpServer(
        { name: 'snipeit', version: '0.1.0', title: 'Snipe-IT' },
        {
            instructions:
                'Snipe-IT asset management. Resources: hardware (assets), users, licenses, accessories, consumables, components, locations, companies, categories, manufacturers, models, status_labels, suppliers, departments, groups, fields, fieldsets, maintenances, activity (audit log). All ids are numeric Snipe-IT ids: use lookup to resolve asset tags, serials, usernames or emails. Call describe before create/update to learn accepted fields.' +
                (cfg.readOnly ? ' READ-ONLY MODE: write tools are disabled.' : '')
        }
    );

    server.registerTool(
        'list',
        {
            title: 'List records',
            description:
                'List or search Snipe-IT records of one resource type. Returns {total, offset, rows}. Pass user_id to get hardware, accessories or licenses checked out to a user. filters = resource-specific query params (see describe).',
            inputSchema: z.object({
                resource: z.enum(ALL),
                search: z.string().optional().describe('Free-text search'),
                user_id: id.optional().describe('Only items checked out to this user (hardware, accessories, licenses)'),
                filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
                    .refine(filters => !['search', 'sort', 'order', 'limit', 'offset'].some(key => key in filters),
                        'Use top-level search, sort, order, limit and offset instead of filters').optional(),
                sort: z.string().optional(),
                order: z.enum(['asc', 'desc']).optional(),
                limit: z.number().int().min(1).max(500).default(25),
                offset: z.number().int().min(0).default(0),
                raw: z.boolean().default(false).describe('Return the untrimmed API payload')
            }),
            annotations: ro
        },
        run(async ({ resource, search, user_id, filters, sort, order, limit, offset, raw }) => {
            let path: string = RESOURCES[resource];
            if (user_id !== undefined) {
                const sub = { hardware: 'assets', accessories: 'accessories', licenses: 'licenses' }[resource as string];
                if (!sub) throw new Error('user_id is only supported for hardware, accessories and licenses');
                path = `users/${user_id}/${sub}`;
            }
            const data = await api.get(path, { search, sort, order, limit, offset, ...filters });
            if (raw) return data;
            const env = data as Row;
            const rows = [env.rows, env.assets, env.accessories, env.licenses].find(Array.isArray);
            if (!rows) throw new Error(`Snipe-IT returned no rows for ${path}`);
            return { total: data.total ?? offset + rows.length, offset, rows: trim(rows) };
        })
    );

    server.registerTool(
        'get',
        {
            title: 'Get one record',
            description: 'Fetch one Snipe-IT record by numeric id.',
            inputSchema: z.object({ resource: z.enum(WRITABLE), id, raw: z.boolean().default(false) }),
            annotations: ro
        },
        run(async ({ resource, id, raw }) => {
            const d = await api.get(`${RESOURCES[resource]}/${id}`);
            return raw ? d : trim(d);
        })
    );

    server.registerTool(
        'lookup',
        {
            title: 'Lookup by tag, serial or username',
            description: 'Resolve a hardware asset by asset_tag or serial, or a user by username, email or employee_num, to full records with numeric ids.',
            inputSchema: z.object({
                asset_tag: z.string().optional(),
                serial: z.string().optional(),
                username: z.string().optional(),
                email: z.string().optional(),
                employee_num: z.string().optional()
            }),
            annotations: ro
        },
        run(async ({ asset_tag, serial, username, email, employee_num }) => {
            if (asset_tag) return trim(await api.get(`hardware/bytag/${encodeURIComponent(asset_tag)}`));
            if (serial) return trim((await api.get(`hardware/byserial/${encodeURIComponent(serial)}`)).rows ?? []);
            const q = username ? { username } : email ? { email } : employee_num ? { employee_num } : null;
            if (!q) throw new Error('Pass one of asset_tag, serial, username, email, employee_num');
            return trim((await api.get('users', q)).rows ?? []);
        })
    );

    server.registerTool(
        'describe',
        {
            title: 'Describe fields',
            description: 'Fields accepted by create/update and the list filters for a resource. For hardware also lists the instance\'s custom fields.',
            inputSchema: z.object({ resource: z.enum(ALL) }),
            annotations: ro
        },
        run(async ({ resource }) => {
            let s = FIELDS[resource];
            if (resource === 'hardware') {
                const names = [...(await api.customFields()).keys()];
                if (names.length) s += `\ncustom fields on this instance: ${names.join(', ')}`;
            }
            return s;
        })
    );

    if (cfg.readOnly) return server;

    const data = z.record(z.string(), z.unknown()).describe('Field values; see describe');
    /** Single funnel for create/update payloads. */
    const body = async (resource: Resource, data: Row) => {
        checkData(data);
        return resource === 'hardware' ? await api.mapCustomFields(data) : data;
    };

    server.registerTool(
        'create',
        {
            title: 'Create record',
            description: 'Create a Snipe-IT record. Call describe first for required fields.',
            inputSchema: z.object({ resource: z.enum(WRITABLE), data }),
            annotations: rw
        },
        run(async ({ resource, data }) =>
            trim(await api.post(RESOURCES[resource], await body(resource, data)))
        )
    );

    server.registerTool(
        'update',
        {
            title: 'Update record',
            description: 'Partially update a Snipe-IT record (only the given fields change).',
            inputSchema: z.object({ resource: z.enum(WRITABLE), id, data }),
            annotations: { ...rw, idempotentHint: true }
        },
        run(async ({ resource, id, data }) =>
            trim(await api.patch(`${RESOURCES[resource]}/${id}`, await body(resource, data)))
        )
    );

    server.registerTool(
        'delete',
        {
            title: 'Delete record',
            description: 'Delete a Snipe-IT record (soft delete where Snipe-IT supports it; see restore). Requires confirm: true.',
            inputSchema: z.object({ resource: z.enum(WRITABLE), id, confirm: z.literal(true) }),
            annotations: { readOnlyHint: false, destructiveHint: true }
        },
        run(async ({ resource, id }) => trim(await api.delete(`${RESOURCES[resource]}/${id}`)))
    );

    server.registerTool(
        'restore',
        {
            title: 'Restore deleted record',
            description: 'Restore a soft-deleted record. Snipe-IT supports this for hardware, users, models and manufacturers.',
            inputSchema: z.object({ resource: z.enum(WRITABLE), id }),
            annotations: { ...rw, idempotentHint: true }
        },
        run(async ({ resource, id }) => trim(await api.post(`${RESOURCES[resource]}/${id}/restore`)))
    );

    server.registerTool(
        'checkout',
        {
            title: 'Check out',
            description:
                'Check an item out. hardware -> user|asset|location; accessories, consumables -> user; components -> asset; licenses -> user|asset (first free seat is used).',
            inputSchema: z.object({
                resource: z.enum(CHECKOUTABLE),
                id: id.describe('Item id'),
                to: z.enum(['user', 'asset', 'location']).default('user'),
                target_id: id.describe('Id of the user, asset or location receiving the item'),
                quantity: z.number().int().min(1).optional().describe('accessories, consumables, components'),
                note: z.string().optional(),
                expected_checkin: z.string().optional().describe('YYYY-MM-DD (hardware)'),
                status_id: id.optional().describe('hardware: status label to set'),
                name: z.string().optional().describe('hardware: rename on checkout')
            }),
            annotations: rw
        },
        run(async args => {
            checkOptions('checkout', args);
            const { resource, id, to, target_id, quantity, note, expected_checkin, status_id, name } = args;
            switch (resource) {
                case 'hardware':
                    return trim(
                        await api.post(`hardware/${id}/checkout`, {
                            checkout_to_type: to,
                            [`assigned_${to}`]: target_id,
                            expected_checkin,
                            status_id,
                            name,
                            note
                        })
                    );
                case 'accessories':
                    if (to !== 'user') throw new Error('accessories can only be checked out to a user');
                    return trim(await api.post(`accessories/${id}/checkout`, { assigned_user: target_id, checkout_qty: quantity ?? 1, note }));
                case 'consumables':
                    if (to !== 'user') throw new Error('consumables can only be checked out to a user');
                    return trim(await api.post(`consumables/${id}/checkout`, { assigned_to: target_id, checkout_qty: quantity ?? 1, note }));
                case 'components':
                    if (to !== 'asset') throw new Error('components can only be checked out to an asset (to: "asset")');
                    return trim(await api.post(`components/${id}/checkout`, { assigned_to: target_id, assigned_qty: quantity ?? 1, note }));
                case 'licenses': {
                    if (to === 'location') throw new Error('licenses can only be checked out to a user or asset');
                    // disabled = seat already used on a non-reassignable license, or the license is inactive
                    const free = await api.findRow(`licenses/${id}/seats`, s => !s.assigned_user && !s.assigned_asset && !s.disabled);
                    if (!free) throw new Error(`License ${id} has no free seats available for checkout`);
                    const body = to === 'asset' ? { asset_id: target_id, note } : { assigned_to: target_id, note };
                    return trim(await api.put(`licenses/${id}/seats/${free.id}`, body));
                }
            }
        })
    );

    server.registerTool(
        'checkin',
        {
            title: 'Check in',
            description:
                'Check an item back in. hardware: just the id. accessories/licenses: pass from_user_id (or from_asset_id for licenses). components: pass from_asset_id.',
            inputSchema: z.object({
                resource: z.enum(CHECKOUTABLE),
                id: id.describe('Item id'),
                from_user_id: id.optional(),
                from_asset_id: id.optional(),
                quantity: z.number().int().min(1).optional().describe('components: how many to check in'),
                note: z.string().optional(),
                status_id: id.optional().describe('hardware: status label to set'),
                location_id: id.optional().describe('hardware: location to set')
            }),
            annotations: rw
        },
        run(async args => {
            checkOptions('checkin', args);
            const { resource, id, from_user_id, from_asset_id, quantity, note, status_id, location_id } = args;
            switch (resource) {
                case 'hardware':
                    return trim(await api.post(`hardware/${id}/checkin`, { note, status_id, location_id }));
                case 'accessories': {
                    if (!from_user_id) throw new Error('accessories checkin needs from_user_id');
                    // rows: { id: <checkout record id>, assigned_to: {id, ...} }
                    const row = await api.findRow(`accessories/${id}/checkedout`,
                        r => {
                            const to = r.assigned_to as Row | undefined;
                            return to?.id === from_user_id && (!to.type || to.type === 'user');
                        });
                    if (!row) throw new Error(`Accessory ${id} is not checked out to user ${from_user_id}`);
                    return trim(await api.post(`accessories/${row.id}/checkin`, { note }));
                }
                case 'components': {
                    if (!from_asset_id) throw new Error('components checkin needs from_asset_id');
                    // rows: { assigned_pivot_id, name: <compact asset>, assigned_qty }
                    const row = await api.findRow(`components/${id}/assets`, r => ((r.name as Row | undefined)?.id ?? r.id) === from_asset_id);
                    if (!row) throw new Error(`Component ${id} is not checked out to asset ${from_asset_id}`);
                    return trim(
                        await api.post(`components/${row.assigned_pivot_id}/checkin`, {
                            checkin_qty: quantity ?? row.assigned_qty ?? 1,
                            note
                        })
                    );
                }
                case 'licenses': {
                    if (Boolean(from_user_id) === Boolean(from_asset_id)) throw new Error('licenses checkin needs exactly one of from_user_id or from_asset_id');
                    const seat = await api.findRow(`licenses/${id}/seats`,
                        s => (s[from_user_id !== undefined ? 'assigned_user' : 'assigned_asset'] as Row | undefined)?.id === (from_user_id ?? from_asset_id)
                    );
                    if (!seat) throw new Error(`License ${id} has no seat assigned to that user/asset`);
                    return trim(await api.put(`licenses/${id}/seats/${seat.id}`, { assigned_to: null, asset_id: null, note }));
                }
                case 'consumables':
                    throw new Error('Snipe-IT has no API endpoint to check consumables back in');
            }
        })
    );

    server.registerTool(
        'audit',
        {
            title: 'Audit asset',
            description: 'Record an audit for a hardware asset, optionally moving it and setting the next audit date.',
            inputSchema: z.object({
                id: id.describe('Hardware asset id'),
                location_id: id.optional(),
                update_location: z.boolean().default(true).describe('Also move the asset to location_id'),
                next_audit_date: z.string().optional().describe('YYYY-MM-DD'),
                note: z.string().optional()
            }),
            annotations: rw
        },
        run(async ({ id, update_location, ...body }) =>
            trim(await api.post(`hardware/${id}/audit`, { ...body, update_location: update_location ? 1 : 0 }))
        )
    );

    return server;
}
