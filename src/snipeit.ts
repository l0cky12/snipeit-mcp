/** Minimal Snipe-IT REST client over global fetch, plus response trimming. */

const DROP = new Set(['available_actions', 'user_can_checkout', 'image', 'avatar']);
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
/** Hardware keys Snipe-IT itself understands; never remapped to a custom field with a colliding display name. */
const HARDWARE_FIELDS = new Set([
    'id', 'asset_tag', 'model_id', 'status_id', 'name', 'serial', 'company_id', 'supplier_id', 'location_id', 'rtd_location_id',
    'purchase_date', 'purchase_cost', 'order_number', 'warranty_months', 'notes', 'requestable', 'archived', 'byod',
    'last_audit_date', 'next_audit_date', 'expected_checkin', 'asset_eol_date', 'image', 'checkout_to_type',
    'assigned_to', 'assigned_user', 'assigned_asset', 'assigned_location'
]);

export type Row = Record<string, unknown>;
/** Loose shape of Snipe-IT responses: list envelopes, write results, or a bare record. */
export interface Envelope {
    total?: unknown;
    rows?: unknown[];
    status?: string;
    payload?: unknown;
    messages?: unknown;
    message?: unknown;
}

/** Parse and validate a Snipe-IT base URL before any credentials are sent to it. */
export function baseUrl(url: string): URL {
    const error = new Error('Snipe-IT URL must be an absolute HTTP(S) URL without credentials, a query or a fragment');
    let base: URL;
    try {
        base = new URL(url);
    } catch {
        throw error;
    }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw error;
    return base;
}

async function readText(res: Response): Promise<string> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error(`Snipe-IT response exceeded ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** Strip Snipe-IT's verbose wrappers so results cost fewer tokens. */
export function trim(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(trim);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 2 && 'formatted' in o && ('datetime' in o || 'date' in o)) return o.datetime ?? o.date ?? o.formatted;
    const out: [string, unknown][] = [];
    for (const [k, val] of Object.entries(o)) {
        if (DROP.has(k) || val === null || val === '') continue;
        if (k === 'custom_fields' && val && typeof val === 'object' && !Array.isArray(val)) {
            const cf: [string, unknown][] = [];
            for (const [name, f] of Object.entries(val as Record<string, { value?: unknown }>)) {
                if (f?.value !== null && f?.value !== undefined && f?.value !== '') cf.push([name, f.value]);
            }
            if (cf.length) out.push(['custom_fields', Object.fromEntries(cf)]);
            continue;
        }
        const t = trim(val);
        if (t === undefined) continue;
        if (Array.isArray(t) && t.length === 0) continue;
        if (t && typeof t === 'object' && !Array.isArray(t) && Object.keys(t).length === 0) continue;
        out.push([k, t]);
    }
    return Object.fromEntries(out);
}

export class SnipeIT {
    private fields?: Promise<Map<string, string>>;

    constructor(
        private readonly url: string,
        private readonly token: string
    ) {
        this.url = baseUrl(url).href.replace(/\/+$/, '');
        if (!token.trim()) throw new Error('Snipe-IT API token must not be empty');
    }

    async request(method: string, path: string, query?: Record<string, unknown>, body?: unknown): Promise<Envelope> {
        const u = new URL(`${this.url}/api/v1/${path.replace(/^\/+/, '')}`);
        for (const [k, v] of Object.entries(query ?? {})) {
            if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
        const res = await fetch(u, {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
            headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await readText(res);
        let data: unknown = text;
        try {
            data = JSON.parse(text);
        } catch {
            if (res.ok) throw new Error(`Snipe-IT returned non-JSON data on ${method} ${u.pathname}`);
        }
        const env: Envelope = data && typeof data === 'object' ? data : {};
        if (!res.ok) {
            // Upstream text reaches the model verbatim, so keep unstructured bodies short.
            const detail = env.messages ?? env.message;
            const msg = detail !== undefined ? JSON.stringify(detail) : (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 120);
            throw new Error(`Snipe-IT HTTP ${res.status} on ${method} ${u.pathname}: ${msg}`);
        }
        // Snipe-IT reports validation failures as HTTP 200 with status: "error".
        if (env.status === 'error') {
            throw new Error(`Snipe-IT rejected ${method} ${u.pathname}: ${JSON.stringify(env.messages ?? env.message)}`);
        }
        return data as Envelope;
    }

    get(path: string, query?: Record<string, unknown>) {
        return this.request('GET', path, query);
    }
    post(path: string, body?: unknown, query?: Record<string, unknown>) {
        return this.request('POST', path, query, body);
    }
    patch(path: string, body: unknown) {
        return this.request('PATCH', path, undefined, body);
    }
    put(path: string, body: unknown) {
        return this.request('PUT', path, undefined, body);
    }
    delete(path: string) {
        return this.request('DELETE', path);
    }

    /** Follow the server's total, since its page cap can be lower than our requested limit. */
    async *rows(path: string): AsyncGenerator<Row> {
        let offset = 0;
        while (true) {
            const data = await this.get(path, { limit: 500, offset });
            if (!Array.isArray(data?.rows)) throw new Error(`Snipe-IT returned no rows for ${path}`);
            const total = Number(data.total ?? offset + data.rows.length);
            if (!Number.isSafeInteger(total) || total < 0) throw new Error(`Snipe-IT returned an invalid total for ${path}`);
            yield* data.rows as Row[];
            offset += data.rows.length;
            if (!data.rows.length || offset >= total) return;
        }
    }

    async findRow(path: string, matches: (row: Row) => boolean): Promise<Row | undefined> {
        for await (const row of this.rows(path)) if (matches(row)) return row;
    }

    /** Lower-cased custom field name -> db column (e.g. "mac address" -> "_snipeit_mac_address_5"). Cached per process. */
    customFields(): Promise<Map<string, string>> {
        this.fields ??= (async () => {
            const m = new Map<string, string>();
            for await (const f of this.rows('fields')) m.set(String(f.name).toLowerCase(), f.db_column_name as string);
            return m;
        })().catch(error => {
            this.fields = undefined;
            throw error;
        });
        return this.fields;
    }

    /** Rename friendly custom-field keys to their db column names; standard and raw _snipeit_ keys pass through. */
    async mapCustomFields(data: Row): Promise<Row> {
        const custom = Object.keys(data).filter(k => !HARDWARE_FIELDS.has(k) && !k.startsWith('_snipeit_'));
        if (!custom.length) return data;
        const map = await this.customFields().catch(error => {
            throw new Error(`Cannot map custom fields (${custom.join(', ')}): ${error instanceof Error ? error.message : error}`);
        });
        return Object.fromEntries(Object.entries(data).map(([k, v]) => [custom.includes(k) ? map.get(k.toLowerCase()) ?? k : k, v]));
    }
}

export const RESOURCES = {
    hardware: 'hardware',
    users: 'users',
    licenses: 'licenses',
    accessories: 'accessories',
    consumables: 'consumables',
    components: 'components',
    locations: 'locations',
    companies: 'companies',
    categories: 'categories',
    manufacturers: 'manufacturers',
    models: 'models',
    status_labels: 'statuslabels',
    suppliers: 'suppliers',
    departments: 'departments',
    groups: 'groups',
    fields: 'fields',
    fieldsets: 'fieldsets',
    maintenances: 'maintenances',
    activity: 'reports/activity'
} as const;
export type Resource = keyof typeof RESOURCES;
