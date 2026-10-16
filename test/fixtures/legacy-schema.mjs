export function downgradeSchema15(db) {
  db.exec('DROP TABLE IF EXISTS auto_memory_job_retirements;');
}

export function downgradeSchema14(db) {
  downgradeSchema15(db);
  db.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TRIGGER IF EXISTS context_inbound_insert;
    DROP TRIGGER IF EXISTS context_delivery_sent;
    DROP TABLE IF EXISTS auto_memory_context_job_messages;
    DROP TABLE IF EXISTS auto_memory_context_jobs;
    DROP TABLE IF EXISTS conversation_context_state;
    DROP TABLE IF EXISTS conversation_context_messages;
  `);
}

export function downgradeSchema11(db) {
  downgradeSchema14(db);
  db.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS person_profile_pending_results;
    DROP TABLE IF EXISTS person_profile_revision_sources;
    DROP TABLE IF EXISTS auto_memory_job_deferrals;
    DROP TABLE IF EXISTS self_profile_reclassifications;
    DROP TRIGGER IF EXISTS index_topic_insert;
    DROP TRIGGER IF EXISTS index_topic_update;
    DROP TRIGGER IF EXISTS index_topic_delete;
    DROP TABLE IF EXISTS memory_topic_fts;
    DROP TABLE IF EXISTS turn_preparations;
    DROP TABLE IF EXISTS room_rule_revisions;
    DROP TABLE IF EXISTS topic_embedding_attempts;
    DROP INDEX IF EXISTS person_fragment_identity_content;
    ALTER TABLE person_profile_pending DROP COLUMN purpose;
  `);
}

// Remove schema 10 additions when a migration test needs to model an older database.
export function downgradeSchema10(db) {
  downgradeSchema11(db);
  db.exec(`
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
