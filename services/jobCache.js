// Holds the most recent search results in memory, keyed by job id, so that
// when the frontend sends back a list of selected IDs, the server can
// resolve them to full job details without re-fetching from the APIs.
const cache = new Map();

function storeJobs(jobs) {
  for (const job of jobs) {
    if (job.id) cache.set(job.id, job);
  }
}

function getJobsByIds(ids) {
  return ids.map((id) => cache.get(id)).filter(Boolean);
}

module.exports = { storeJobs, getJobsByIds };
