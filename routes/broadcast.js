const express = require('express');
const { fetchAdzunaJobs } = require('../services/fetchers/adzuna');
const { fetchReedJobs } = require('../services/fetchers/reed');
const { fetchJoobleJobs } = require('../services/fetchers/jooble');
const { storeJobs, getJobsByIds } = require('../services/jobCache');
const recipients = require('../services/recipients');
const sentJobs = require('../services/sentJobs');
const { sendPersonalizedBroadcast } = require('../services/broadcastMailer');

/**
 * Strict PHRASE match — used for the Job Title/Role field. Requires the
 * words to appear together, in order, not just scattered independently
 * anywhere in the text. This is what avoids false positives like a college
 * lecturer posting matching "IT support" just because it separately
 * mentions "basic IT skills" in one sentence and "learning support" in
 * another — the role name should mean exactly what it says.
 */
function jobMatchesPhrase(job, phrase) {
  const clean = (phrase || '').trim();
  if (!clean) return true;

  const haystack = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  const escapedWords = clean
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // Words must appear in order, immediately adjacent — but allow flexible
  // whitespace between them (a line break or double space in a job
  // description shouldn't break an otherwise-exact phrase match).
  const pattern = escapedWords.join('\\s+');
  return new RegExp(`\\b${pattern}\\b`, 'i').test(haystack);
}

/**
 * Looser AND match — used for the general Keywords field. Each
 * comma-or-space-separated term just needs to appear somewhere in the job
 * (as a whole word), independently — good for extra qualifiers like
 * "remote, urgent" where the terms aren't meant to form one phrase and
 * don't need to relate to the job title itself.
 */
function jobMatchesKeywords(job, keywords) {
  const terms = (keywords || '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  return terms.every((term) => {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
  });
}

/**
 * Experience-level synonym map — since most job postings don't literally
 * write "0-1 years," they use phrases like "entry-level," "graduate," or
 * "senior." Each bracket lists alternate phrasings that count as a match.
 * Deliberately approximate: "senior" appears under both 5-8 and 8+ since
 * postings rarely commit to an exact year range for senior roles — treat
 * this as "roughly this level," not a precise cutoff.
 */
const EXPERIENCE_SYNONYMS = {
  '0-1 years': ['0-1 year', '0-1 years', 'entry level', 'entry-level', 'graduate', 'no experience required', 'no experience necessary', 'fresher', 'trainee', 'apprentice'],
  '1-2 years': ['1-2 year', '1-2 years', 'junior', 'early career'],
  '2-3 years': ['2-3 year', '2-3 years', 'mid level', 'mid-level', 'intermediate'],
  '3-5 years': ['3-5 year', '3-5 years', 'mid-senior', 'experienced'],
  '5-8 years': ['5-8 year', '5-8 years', 'senior', 'experienced'],
  '8+ years': ['8+ years', 'senior', 'lead', 'principal', 'director', 'head of', 'extensive experience'],
};

/**
 * Phrases that mean a job explicitly states SOME experience level, across
 * all brackets combined — used to detect "this posting doesn't mention
 * experience at all" vs. "this posting specifies a level."
 */
const ALL_EXPERIENCE_PHRASES = Object.values(EXPERIENCE_SYNONYMS).flat();

function textMentionsPhrase(haystack, phrase) {
  const escapedWords = phrase
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escapedWords.join('\\s+');
  return new RegExp(`\\b${pattern}\\b`, 'i').test(haystack);
}

/**
 * Experience filter: a job passes if EITHER (a) it matches the selected
 * bracket's recognized phrasings, OR (b) it doesn't mention any
 * experience-level language at all (across every bracket) — since an
 * unspecified posting might genuinely fit, and hiding it entirely would
 * be a false negative rather than a real mismatch. A job only gets
 * excluded when it explicitly states a level that ISN'T the selected one.
 * No experience bracket selected ("any") always passes everything.
 */
function jobMatchesExperience(job, experienceBracket) {
  const clean = (experienceBracket || '').trim();
  if (!clean) return true;

  const synonyms = EXPERIENCE_SYNONYMS[clean];
  if (!synonyms) return true; // unknown bracket value — don't filter on it

  const haystack = `${job.title || ''} ${job.description || ''}`.toLowerCase();

  const matchesSelectedBracket = synonyms.some((phrase) => textMentionsPhrase(haystack, phrase));
  if (matchesSelectedBracket) return true;

  const mentionsAnyExperience = ALL_EXPERIENCE_PHRASES.some((phrase) => textMentionsPhrase(haystack, phrase));
  return !mentionsAnyExperience;
}

const router = express.Router();

/** Step 1: find jobs — search Adzuna + Reed + Jooble, return normalized/deduped results. */
router.post('/search', async (req, res) => {
  const { role = '', keywords = '', location = '', experience = '', includeSent = false } = req.body || {};

  // Deliberately NOT including `experience` in the query sent to the APIs.
  // Adzuna's AND-mode search (what_and) requires every word to appear
  // literally — appending "0-1 years" would require those exact tokens in
  // a posting's own text, which would wipe out almost all real results at
  // the source. Instead, experience is matched entirely on our side, via
  // jobMatchesExperience below, against the synonym list — this catches
  // "entry-level," "graduate," etc. that a literal search never would.
  const searchKeywords = [role, keywords].filter(Boolean).join(' ').trim();

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

    // Apply our own relevance checks on top of whatever each API matched
    // internally: Job Title/Role must appear as an exact phrase; Keywords
    // just need to each appear somewhere, independently; Experience must
    // match one of the recognized phrasings for that bracket.
    jobs = jobs.filter(
      (job) =>
        jobMatchesPhrase(job, role) &&
        jobMatchesKeywords(job, keywords) &&
        jobMatchesExperience(job, experience)
    );

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
  const { email, name = '' } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  const record = recipients.addRecipient(email, name);
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
