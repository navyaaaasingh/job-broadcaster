const db = require('./db');

function listRecipients() {
  return db.get('recipients').value();
}

function addRecipient(email) {
  const clean = String(email).trim().toLowerCase();
  if (!clean || !clean.includes('@') || !clean.includes('.')) return null;
  const existing = db.get('recipients').find({ email: clean }).value();
  if (existing) return existing;
  const record = { email: clean, addedAt: new Date().toISOString() };
  db.get('recipients').push(record).write();
  return record;
}

/** Add many emails at once (pasted list or uploaded file content). */
function addRecipients(emails) {
  const added = [];
  const skipped = [];
  for (const raw of emails) {
    const clean = String(raw).trim().toLowerCase();
    if (!clean) continue;
    if (!clean.includes('@') || !clean.includes('.')) {
      skipped.push(raw);
      continue;
    }
    const existing = db.get('recipients').find({ email: clean }).value();
    if (existing) continue; // silently skip duplicates
    added.push({ email: clean, addedAt: new Date().toISOString() });
  }
  if (added.length > 0) {
    db.get('recipients').push(...added).write();
  }
  return { added, skipped };
}

function removeRecipient(email) {
  db.get('recipients').remove({ email: String(email).trim().toLowerCase() }).write();
}

module.exports = { listRecipients, addRecipient, addRecipients, removeRecipient };
