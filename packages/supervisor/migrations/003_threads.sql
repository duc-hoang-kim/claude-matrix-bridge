-- One Claude session per Matrix thread: several sessions may share a room.
-- Rebuild the table to drop UNIQUE(room_id) and add thread_root.
-- thread_root NULL = not yet bound to a thread (claimed by the room's first thread).
CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    name TEXT NOT NULL UNIQUE,
    working_directory TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'sonnet',
    permission_mode TEXT NOT NULL DEFAULT 'default',
    port INTEGER,
    pid INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message_at TEXT,
    local_pid INTEGER,
    last_matrix_activity TEXT,
    thread_root TEXT
);
INSERT INTO sessions_new (id, room_id, name, working_directory, model, permission_mode, port, pid, status, created_at, updated_at, last_message_at, local_pid, last_matrix_activity)
  SELECT id, room_id, name, working_directory, model, permission_mode, port, pid, status, created_at, updated_at, last_message_at, local_pid, last_matrix_activity FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sessions_room_thread ON sessions (room_id, thread_root);
