const axios = require('axios');

/** Send one identical email to a single recipient via Resend's HTTP API. */
async function sendBroadcastEmail({ to, subject, message, jobs }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not set — cannot send email.');
  }

  const jobListHtml = jobs
    .map(
      (j) =>
        `<li style="margin-bottom:10px;"><a href="${j.url}">${j.title}</a> — ${j.company} (${j.location || 'n/a'})<br/><span style="color:#666;font-size:12px;">via ${j.source}</span></li>`
    )
    .join('');

  const jobListText = jobs
    .map((j) => `• ${j.title} — ${j.company} (${j.location || 'n/a'}) [${j.source}]\n  ${j.url}`)
    .join('\n\n');

  const html = `
    ${message ? `<p>${message.replace(/\n/g, '<br/>')}</p>` : ''}
    <ul style="padding-left:18px;">${jobListHtml}</ul>
  `;
  const text = `${message ? message + '\n\n' : ''}${jobListText}`;

  await axios.post(
    'https://api.resend.com/emails',
    {
      from: process.env.RESEND_FROM || 'Job Broadcaster <onboarding@resend.dev>',
      to,
      subject: subject || `${jobs.length} job opening${jobs.length === 1 ? '' : 's'} for you`,
      text,
      html,
    },
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
}

/**
 * Send the same email to every recipient, in small batches (so a large
 * list doesn't fire all requests at once and trip rate limits). Failures
 * for individual recipients don't stop the rest of the batch.
 */
async function sendBroadcastToAll({ recipients, subject, message, jobs }) {
  const results = { sent: [], failed: [] };
  const BATCH_SIZE = 5;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (recipient) => {
        try {
          await sendBroadcastEmail({ to: recipient.email, subject, message, jobs });
          results.sent.push(recipient.email);
        } catch (err) {
          const detail = err.response?.data || err.message;
          console.error(`[broadcast] failed for ${recipient.email}:`, detail);
          results.failed.push({ email: recipient.email, error: detail });
        }
      })
    );
  }

  return results;
}

module.exports = { sendBroadcastEmail, sendBroadcastToAll };
