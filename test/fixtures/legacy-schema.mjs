// Remove schema 10 additions when a migration test needs to model an older database.
export function downgradeSchema10(db) {
  db.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TABLE channel_tasks;
    DROP INDEX message_conversation_identity;
    DROP INDEX one_running_run_per_session;
    DROP INDEX one_running_run_per_conversation;
    CREATE UNIQUE INDEX one_running_run_per_conversation ON agent_runs(conversation_id) WHERE status = 'running';
    ALTER TABLE agent_runs DROP COLUMN pi_session_file;
    ALTER TABLE run_progress DROP COLUMN delivery_mode;
    ALTER TABLE run_progress DROP COLUMN reply_slot;
    ALTER TABLE delivery_parts DROP COLUMN delivery_mode;
    ALTER TABLE delivery_parts DROP COLUMN reply_slot;
  `);
}
