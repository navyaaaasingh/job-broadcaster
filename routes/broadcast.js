const express = require('express');
const { fetchAdzunaJobs } = require('../services/fetchers/adzuna');
const { fetchReedJobs } = require('../services/fetchers/reed');
const { fetchJoobleJobs } = require('../services/fetchers/jooble');
const { storeJobs, getJobsByIds } = require('../services/jobCache');
const recipients = require('../services/recipients');
const sentJobs = require('../services/sentJobs');
const { sendPersonalizedBroadcast } = require('../services/broadcastMailer');

/**
 * Safety net on top of whatever matching each API does internally: only
 * keep a job if every word from the keyword search actually appears
 * (as a whole word, case-insensitive) in its title or description. This
 * catches cases where an API's own search is loose — e.g. matching "IT
 * support" against a driving job that just happens to mention "support"
 * somewhere, without actually being IT-related.
 */
function jobMatchesAllKeywords(job, keywords) {
  const terms = (keywords || '').trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  return terms.every((term) => {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
  });
}

const router = express.Router();

/** Step 1: find jobs — search Adzuna + Reed + Jooble, return normalized/deduped results. */
router.post('/search', async (req, res) => {
  const { keywords = '', location = '', experience = '', includeSent = false } = req.body || {};

  // None of the three APIs expose a dedicated "years of experience" filter,
  // so the most useful thing we can do with it is fold it into the free-text
  // keyword search — e.g. "react developer" + "2-3 years" becomes
  // "react developer 2-3 years", which biases results toward postings that
  // mention that experience level in their title/description.
  const searchKeywords = [keywords, experience].filter(Boolean).join(' ').trim();

  try {
    const [adzuna, reed, jooble] = await Promise.all([
      fetchAdzunaJobs({ keywords: searchKeywords, location }),
      fetchReedJobs({ keywords: searchKeywords, location }),
      fetchJoobleJobs({ keywords: searchKeywords, location }),
    ]);

    const all = [...adzuna, ...reed, ...jooble];
    const byId = new Map();
    for (const job of all) {
      if (job.id && job.title) byId.set(job.id, job);
    }
    let jobs = [...byId.values()];

    // Apply our own relevance check on top of the APIs' own matching (see
    // jobMatchesAllKeywords above) — deliberately checked against the
    // original `keywords` only, not the experience-appended search string,
    // since experience phrasing won't always appear verbatim in a posting.
    jobs = jobs.filter((job) => jobMatchesAllKeywords(job, keywords));

    // Filter out jobs that have already been sent to EVERY current
    // recipient — if even one person on the list hasn't received it yet,
    // it still shows up, since sending is now tracked per (job, recipient)
    // pair rather than globally.
    const recipientEmails = recipients.listRecipients().map((r) => r.email);
    const totalBeforeFilter = jobs.length;
    if (!includeSent) {
      jobs = jobs.filter((job) => !sentJobs.isFullySentToAll(job.id, recipientEmails));
    } else {
      jobs = jobs.map((job) => ({
        ...job,
        alreadySent: sentJobs.isFullySentToAll(job.id, recipientEmails),
      }));
    }
    const skippedCount = totalBeforeFilter - jobs.length;

    storeJobs(jobs); // cache so /send can resolve selected IDs later
    res.json({ jobs, count: jobs.length, skippedAlreadySent: skippedCount });
  } catch (err) {
    console.error('[search] failed:', err.message);
    res.status(500).json({ error: 'Search failed.', detail: err.message });
  }
});

/** Step 3: recipients — list, add one, add many, remove. */
router.get('/recipients', (req, res) => {
  res.json(recipients.listRecipients());
});

router.post('/recipients', (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  const record = recipients.addRecipient(email);
  if (!record) return res.status(400).json({ error: 'Invalid email address.' });
  res.json({ ok: true, recipient: record });
});

router.post('/recipients/bulk', (req, res) => {
  const { emails } = req.body || {};
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty array of emails.' });
  }
  const result = recipients.addRecipients(emails);
  res.json({ ok: true, ...result, total: recipients.listRecipients().length });
});

router.delete('/recipients/:email', (req, res) => {
  recipients.removeRecipient(req.params.email);
  res.json({ ok: true });
});

/** Step 2 + 4: selected jobs get sent — each recipient gets whichever of
 * the selected jobs they haven't already received before, so no one is
 * ever emailed the same posting twice. */
router.post('/send', async (req, res) => {
  const { jobIds = [], experience = {}, subject = '', message = '' } = req.body || {};

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one job to send.' });
  }

  const allJobs = getJobsByIds(jobIds).map((job) => ({
    ...job,
    experience: experience[job.id] || null,
  }));
  if (allJobs.length === 0) {
    return res.status(400).json({
      error: 'None of the selected jobs were found in cache. Please re-run the search and re-select.',
    });
  }

  const list = recipients.listRecipients();
  if (list.length === 0) {
    return res.status(400).json({ error: 'No recipients added yet.' });
  }

  // Resolve each recipient's own job list, excluding anything they've
  // already received previously. A recipient who's already had every
  // selected job is skipped entirely rather than sent an empty email.
  const assignments = [];
  const alreadyCaughtUp = [];
  for (const recipient of list) {
    const jobsForRecipient = allJobs.filter((job) => !sentJobs.hasBeenSentTo(job.id, recipient.email));
    if (jobsForRecipient.length === 0) {
      alreadyCaughtUp.push(recipient.email);
    } else {
      assignments.push({ recipient, jobs: jobsForRecipient });
    }
  }

  if (assignments.length === 0) {
    return res.status(400).json({
      error: 'Every recipient has already received all of the selected jobs — nothing new to send.',
    });
  }

  try {
    const result = await sendPersonalizedBroadcast({ assignments, subject, message });

    // Record exactly which (job, recipient) pairs actually went out —
    // only for sends that succeeded, so a failed send can be retried later.
    for (const { email, jobs } of result.sent) {
      sentJobs.markSentToRecipient(jobs, email);
    }

    res.json({
      ok: true,
      recipientsTotal: list.length,
      sent: result.sent.length,
      alreadyCaughtUp: alreadyCaughtUp.length,
      failed: result.failed,
    });
  } catch (err) {
    console.error('[send] failed:', err.message);
    res.status(500).json({ error: 'Send failed.', detail: err.message });
  }
});

module.exports = router;
