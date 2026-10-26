export function downgradeSchema30(db) {
  for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'session_integrity_%'").all()) {
    db.exec(`DROP TRIGGER "${row.name.replaceAll('"','""')}"`);
  }
  db.exec('DROP TABLE IF EXISTS session_integrity; DROP TABLE IF EXISTS session_integrity_sweeps; DROP TABLE IF EXISTS session_integrity_canonical_messages; DROP TABLE IF EXISTS maintenance_contracts; DROP INDEX IF EXISTS channel_tasks_ready; DROP INDEX IF EXISTS channel_unfinished_runs;');
  for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'session_integrity_%'").all()) {
    db.exec(`DROP INDEX "${row.name.replaceAll('"','""')}"`);
  }
}

export function downgradeSchema22(db) {
  downgradeSchema30(db);
  db.exec('DROP TABLE IF EXISTS auto_memory_component_results;');
  db.exec('DROP TABLE IF EXISTS auto_memory_recoveries;');
  db.exec('DROP TABLE IF EXISTS channel_task_failures;');
  if (db.prepare('PRAGMA table_info(conversation_context_state)').all().some(column => column.name === 'summary_correction_hash')) {
    db.exec('ALTER TABLE conversation_context_state DROP COLUMN summary_correction_hash;');
  }
  db.exec(`DROP TABLE IF EXISTS research_collection_cycles;
    DROP TABLE IF EXISTS research_task_archives;
    DROP TABLE IF EXISTS research_workflow_reviews;
    DROP TABLE IF EXISTS research_workflow_versions;
    DROP TABLE IF EXISTS research_workflow_sections;
    DROP TABLE IF EXISTS research_workflow_plans;
    DROP TABLE IF EXISTS research_workflow_cycles;`);
  db.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS research_deliveries;
    DROP TABLE IF EXISTS research_report_fts;
    DROP TABLE IF EXISTS research_reports;
    DROP TABLE IF EXISTS research_evidence;
    DROP TABLE IF EXISTS research_attempts;
    DROP TABLE IF EXISTS research_tasks;
    DROP TABLE IF EXISTS self_profile_update_sources;
    DROP TABLE IF EXISTS self_profile_updates;
    DROP TABLE IF EXISTS person_profile_subject_updates;
    DROP TABLE IF EXISTS message_profile_context;`);
  if (db.prepare('PRAGMA table_info(person_profile_pending)').all().some(column => column.name === 'subject_json')) {
    db.exec('ALTER TABLE person_profile_pending DROP COLUMN subject_json;');
  }
}

export function downgradeSchema21(db) {
  downgradeSchema22(db);
  db.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS material_backfill_pending_audit;
    DROP TABLE IF EXISTS material_backfill_jobs;
    DROP TABLE IF EXISTS material_backfill_runs;`);
}

export function downgradeSchema20(db) {
  downgradeSchema21(db);
  db.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS auto_memory_material_job_pending;
    DROP TABLE IF EXISTS auto_memory_material_observed_pending;
    DROP TABLE IF EXISTS auto_memory_material_legacy_messages;
    DROP TABLE IF EXISTS auto_memory_material_job_messages;
    DROP TABLE IF EXISTS auto_memory_material_jobs;
    DROP TABLE IF EXISTS auto_memory_material_state;
    DROP TABLE IF EXISTS auto_memory_legacy_isolations;`);
}

export function downgradeSchema16(db) {
  downgradeSchema20(db);
  db.exec('DROP TABLE IF EXISTS memory_topic_scopes;');
  db.exec('DROP TABLE IF EXISTS memory_fact_attributions;');
  db.exec('DROP TABLE IF EXISTS message_images;');
  db.exec('ALTER TABLE messages DROP COLUMN image_failure;');
  db.exec(`DROP TABLE IF EXISTS answer_page_views; DROP TABLE IF EXISTS answer_documents;
    ALTER TABLE delivery_parts DROP COLUMN reference_index;`);
}

export function downgradeSchema15(db) {
  downgradeSchema16(db);
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
