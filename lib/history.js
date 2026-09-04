// Per-session routing history: the trail anti-downgrade, complaint upgrade,
// and the strategies' history features consume.
//
// Derived from OpenSquilla (https://github.com/opensquilla/opensquilla),
// Apache-2.0 © OpenSquilla contributors — behavioral port of the step's
// history store semantics (max 5 entries, 1800s monotonic window, monotonic
// per-session turn index). See NOTICE.md.
export const MAX_ROUTING_HISTORY = 5;
export const ROUTING_HISTORY_WINDOW_SECONDS = 1800;
/** Bound on tracked sessions so a long-lived host process cannot leak. */
export const MAX_TRACKED_SESSIONS = 500;
/**
 * Session-keyed history store. Monotonic-turn + window semantics match the
 * upstream step: entries beyond the newest five are dropped, and consumers
 * apply the 1800s window when reading (see previousFinalEntry).
 */
export class RoutingHistoryStore {
    sessions = new Map();
    clock;
    counter = 0;
    constructor(options = {}) {
        this.clock = options.now ?? (() => this.counter++);
    }
    history(sessionKey) {
        let history = this.sessions.get(sessionKey);
        if (history === undefined) {
            history = { entries: [], turnIndex: 0 };
            this.sessions.set(sessionKey, history);
            // Insertion-order eviction of the oldest idle sessions.
            if (this.sessions.size > MAX_TRACKED_SESSIONS) {
                const oldest = this.sessions.keys().next().value;
                if (oldest !== undefined && oldest !== sessionKey)
                    this.sessions.delete(oldest);
            }
        }
        return history;
    }
    /** Policy-engine view: plain entries newest-last. Read-only (creates nothing). */
    entries(sessionKey) {
        const history = this.sessions.get(sessionKey);
        if (history === undefined)
            return [];
        return history.entries.map(entry => ({
            ts: entry.ts,
            text: entry.text,
            finalTier: entry.finalTier,
            finalRouteClass: entry.finalRouteClass,
            routeClass: entry.routeClass,
        }));
    }
    /**
     * Record one finalized turn. The caller decides which surface text (if any)
     * is retained for classifier features; nothing is stored unless the caller
     * passes it.
     */
    append(sessionKey, record) {
        const history = this.history(sessionKey);
        const entry = {
            ts: this.clock(),
            turnIndex: history.turnIndex++,
            text: record.text,
            finalTier: record.finalTier,
            finalRouteClass: record.finalRouteClass,
            routeClass: record.routeClass,
            source: record.source,
        };
        history.entries.push(entry);
        if (history.entries.length > MAX_ROUTING_HISTORY) {
            history.entries.splice(0, history.entries.length - MAX_ROUTING_HISTORY);
        }
        return entry;
    }
    forget(sessionKey) {
        this.sessions.delete(sessionKey);
    }
}
