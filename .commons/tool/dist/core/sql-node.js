// Node implementation of SqlAdapter over node:sqlite (unflagged since Node 22.13).
// This is the only file under src/core that may import node:* modules.
import { DatabaseSync } from "node:sqlite";
export function openNodeSql(path) {
    const db = new DatabaseSync(path);
    if (path !== ":memory:") {
        // The timeout first: switching to WAL takes a lock, and without a timeout a connection that opens while another
        // process (a detached pre-verification, an integrator) holds one fails at once with "database is locked".
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("PRAGMA journal_mode = WAL");
    }
    const statements = new Map();
    const prepare = (sql) => {
        let stmt = statements.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            statements.set(sql, stmt);
        }
        return stmt;
    };
    let depth = 0;
    return {
        exec(sql, ...params) {
            return prepare(sql).all(...params);
        },
        transaction(fn) {
            // Outermost call opens BEGIN IMMEDIATE; nested calls use savepoints so an inner
            // failure that the outer code catches does not leave half-applied inner writes.
            const level = depth;
            if (level === 0)
                db.exec("BEGIN IMMEDIATE");
            else
                db.exec(`SAVEPOINT sp${level}`);
            depth++;
            try {
                const result = fn();
                depth--;
                if (level === 0)
                    db.exec("COMMIT");
                else
                    db.exec(`RELEASE sp${level}`);
                return result;
            }
            catch (err) {
                depth--;
                if (level === 0)
                    db.exec("ROLLBACK");
                else {
                    db.exec(`ROLLBACK TO sp${level}`);
                    db.exec(`RELEASE sp${level}`);
                }
                throw err;
            }
        },
        close() {
            statements.clear();
            db.close();
        },
    };
}
//# sourceMappingURL=sql-node.js.map