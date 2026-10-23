const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      position INTEGER NOT NULL UNIQUE,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      reasoning TEXT,
      reasoning_details TEXT
    );
  `);
  const lockDown = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.chmodSync(file + suffix, 0o600);
      } catch {
        /* the database still lives in the user data directory */
      }
    }
  };
  lockDown();

  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const listMessages = db.prepare('SELECT * FROM messages ORDER BY position ASC');
  const insertMessage = db.prepare(`
    INSERT INTO messages (position, role, content, tool_calls, tool_call_id, reasoning, reasoning_details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    getApiKey() {
      return getSetting.get('api_key')?.value || '';
    },
    setApiKey(value) {
      putSetting.run('api_key', value);
      lockDown();
    },
    loadMessages() {
      return listMessages.all().map((row) => ({
        role: row.role,
        content: row.content,
        ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) } : {}),
        ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
        ...(row.reasoning ? { reasoning: row.reasoning } : {}),
        ...(row.reasoning_details ? { reasoning_details: JSON.parse(row.reasoning_details) } : {}),
      }));
    },
    saveMessages(messages) {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM messages');
        messages.forEach((message, position) => {
          insertMessage.run(
            position,
            message.role,
            message.content ?? null,
            message.tool_calls ? JSON.stringify(message.tool_calls) : null,
            message.tool_call_id ?? null,
            message.reasoning ?? null,
            message.reasoning_details ? JSON.stringify(message.reasoning_details) : null,
          );
        });
        db.exec('COMMIT');
        lockDown();
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openStore };
