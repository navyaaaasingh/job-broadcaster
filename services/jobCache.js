const db = require('./db');

function storeJobs(jobs) {
  const current = db.get('jobCache').value() || {};
  for (const job of jobs) {
    if (job.id) current[job.id] = job;
  }
  db.set('jobCache', current).write();
}

function getJobsByIds(ids) {
  const current = db.get('jobCache').value() || {};
  return ids.map((id) => current[id]).filter(Boolean);
}

module.exports = { storeJobs, getJobsByIds };
