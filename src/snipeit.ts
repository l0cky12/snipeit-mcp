/** Minimal Snipe-IT REST client over global fetch, plus response trimming. */

const DROP = new Set(['available_actions', 'user_can_checkout', 'image', 'avatar']);

/** Strip Snipe-IT's verbose wrappers so results cost fewer tokens. */
export function trim(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(trim);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 2 && 'formatted' in o) return o.datetime ?? o.date ?? o.formatted;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
        if (DROP.has(k) || val === null || val === '') continue;
        if (k === 'custom_fields' && val && typeof val === 'object' && !Array.isArray(val)) {
            const cf: Record<string, unknown> = {};
            for (const [name, f] of Object.entries(val as Record<string, { value?: unknown }>)) {
                if (f?.value !== null && f?.value !== undefined && f?.value !== '') cf[name] = f.value;
            }
            if (Object.keys(cf).length) out.custom_fields = cf;
            continue;
        }
        const t = trim(val);
        if (t === undefined) continue;
        if (Array.isArray(t) && t.length === 0) continue;
        if (t && typeof t === 'object' && !Array.isArray(t) && Object.keys(t).length === 0) continue;
        out[k] = t;
    }
    return out;
}

export class SnipeIT {
    private fields?: Promise<Map<string, string>>;

    constructor(
        private readonly url: string,
        private readonly token: string
    ) {}

    async request(method: string, path: string, query?: Record<string, unknown>, body?: unknown): Promise<any> {
        const u = new URL(`${this.url}/api/v1/${path.replace(/^\/+/, '')}`);
        for (const [k, v] of Object.entries(query ?? {})) {
            if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
        const res = await fetch(u, {
            method,
            headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let data: any = text;
        try {
            data = JSON.parse(text);
        } catch {
            /* non-JSON body */
        }
        if (!res.ok) {
            const msg = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data.messages ?? data.message ?? data);
            throw new Error(`Snipe-IT HTTP ${res.status} on ${method} ${u.pathname}: ${msg}`);
        }
        // Snipe-IT reports validation failures as HTTP 200 with status: "error".
        if (data && typeof data === 'object' && data.status === 'error') {
            throw new Error(`Snipe-IT rejected ${method} ${u.pathname}: ${JSON.stringify(data.messages ?? data.message)}`);
        }
        return data;
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

    /** Lower-cased custom field name -> db column (e.g. "mac address" -> "_snipeit_mac_address_5"). Cached per process. */
    customFields(): Promise<Map<string, string>> {
        this.fields ??= this.get('fields', { limit: 500 }).then((r: any) => {
            const m = new Map<string, string>();
            for (const f of r.rows ?? []) m.set(String(f.name).toLowerCase(), f.db_column_name);
            return m;
        });
        return this.fields;
    }

    /** Rename friendly custom-field keys to their db column names; raw _snipeit_ keys pass through. */
    async mapCustomFields(data: Record<string, unknown>): Promise<Record<string, unknown>> {
        const map = await this.customFields();
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) out[map.get(k.toLowerCase()) ?? k] = v;
        return out;
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
