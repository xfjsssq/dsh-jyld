// Host-side session-cookie state: the web session secret never leaves this
// process; the browser half only ever sees masked hints.
//
// Derived from the dsh-tokenrhythm-bill community plugin's security boundary
// (state file on host, 0600). See NOTICE.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskCookie } from "./balance.js";
/** File-backed store under the harness home; mode 0600 where the platform honors it. */
export class FileBillingStateStore {
    filePath;
    cookie = '';
    token = '';
    csrf = '';
    loaded = false;
    constructor(filePath) {
        this.filePath = filePath;
    }
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            if (existsSync(this.filePath)) {
                const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
                if (typeof parsed.sessionCookie === 'string')
                    this.cookie = parsed.sessionCookie;
                if (typeof parsed.sessionToken === 'string')
                    this.token = parsed.sessionToken;
                if (typeof parsed.csrf === 'string')
                    this.csrf = parsed.csrf;
            }
        }
        catch {
            // Corrupt state is treated as absent; the next write replaces it.
            this.cookie = '';
            this.token = '';
            this.csrf = '';
        }
    }
    save() {
        mkdirSync(dirname(this.filePath), { recursive: true });
        writeFileSync(this.filePath, JSON.stringify({
            sessionCookie: this.cookie,
            sessionToken: this.token,
            csrf: this.csrf,
        }), {
            encoding: 'utf8',
            mode: 0o600,
        });
        try {
            chmodSync(this.filePath, 0o600);
        }
        catch {
            // Windows ignores POSIX modes; not an error.
        }
    }
    read() {
        this.load();
        return this.cookie;
    }
    readCsrf() {
        this.load();
        return this.csrf;
    }
    readToken() {
        this.load();
        return this.token;
    }
    write(cookie) {
        this.load();
        this.cookie = cookie;
        this.token = '';
        this.csrf = '';
        this.save();
    }
    writeSession(token, options) {
        this.load();
        this.token = token;
        this.cookie = options?.cookie ?? '';
        this.csrf = options?.csrf ?? '';
        this.save();
    }
    clear() {
        this.load();
        this.cookie = '';
        this.token = '';
        this.csrf = '';
        this.save();
    }
    configured() {
        return this.read().length > 0 || this.readToken().length > 0;
    }
}
/** Masked summary of the configured session, safe to send to the browser. */
export function sessionStatus(store) {
    const cookie = store.read();
    const token = store.readToken();
    return {
        configured: cookie.length > 0 || token.length > 0,
        maskedCookie: maskCookie(cookie),
        maskedToken: maskCookie(token),
    };
}
