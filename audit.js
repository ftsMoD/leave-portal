// Append-only activity log (feeds the admin "Recent activity" report).
async function audit(q, actor, action, summary) {
  await q('INSERT INTO audit_log (actor_id, actor_name, action, summary) VALUES ($1, $2, $3, $4)', [
    actor?.id ?? null,
    actor?.name ?? 'System',
    action,
    summary,
  ]);
}

module.exports = { audit };
