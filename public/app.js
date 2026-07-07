const searchForm = document.getElementById('search-form');
const searchMeta = document.getElementById('search-meta');
const jobResults = document.getElementById('job-results');

const singleEmailInput = document.getElementById('single-email');
const addSingleBtn = document.getElementById('add-single');
const bulkEmailsInput = document.getElementById('bulk-emails');
const addBulkBtn = document.getElementById('add-bulk');
const fileUpload = document.getElementById('file-upload');
const recipientsMeta = document.getElementById('recipients-meta');
const recipientsList = document.getElementById('recipients-list');

const sendForm = document.getElementById('send-form');
const sendStatus = document.getElementById('send-status');
const sendBtn = document.getElementById('send-btn');

let selectedJobIds = new Set();

// ---------- Step 1 & 2: search + select ----------

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(searchForm);
  const keywords = fd.get('keywords') || '';
  const location = fd.get('location') || '';

  searchMeta.textContent = 'Searching Adzuna, Reed and Jooble…';
  jobResults.innerHTML = '';

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords, location }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed.');

    searchMeta.textContent = `${data.count} result(s). Check the ones you want to send.`;
    renderJobResults(data.jobs);
  } catch (err) {
    searchMeta.textContent = err.message;
  }
});

function renderJobResults(jobs) {
  jobResults.innerHTML = '';
  if (jobs.length === 0) {
    jobResults.innerHTML = '<li class="empty">No results. Try different keywords or location.</li>';
    return;
  }
  for (const job of jobs) {
    const li = document.createElement('li');
    li.className = 'job selectable-job';
    li.innerHTML = `
      <label class="job-select">
        <input type="checkbox" data-id="${job.id}" ${selectedJobIds.has(job.id) ? 'checked' : ''} />
        <span>
          <span class="job-title">${job.title}</span><br/>
          <span class="job-meta"><span class="job-source">${job.source}</span>${job.company} — ${job.location || 'n/a'}</span>
        </span>
      </label>
    `;
    jobResults.appendChild(li);
  }
  jobResults.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) selectedJobIds.add(box.dataset.id);
      else selectedJobIds.delete(box.dataset.id);
    });
  });
}

// ---------- Step 3: recipients ----------

async function loadRecipients() {
  const res = await fetch('/api/recipients');
  const list = await res.json();
  renderRecipients(list);
}

function renderRecipients(list) {
  recipientsMeta.textContent = list.length === 0
    ? 'No recipients yet.'
    : `${list.length} recipient(s) on the list.`;
  recipientsList.innerHTML = '';
  for (const r of list) {
    const li = document.createElement('li');
    li.className = 'recipient';
    li.innerHTML = `<span>${r.email}</span><button class="remove-recipient" data-email="${r.email}">&times;</button>`;
    recipientsList.appendChild(li);
  }
  recipientsList.querySelectorAll('.remove-recipient').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/recipients/${encodeURIComponent(btn.dataset.email)}`, { method: 'DELETE' });
      loadRecipients();
    });
  });
}

addSingleBtn.addEventListener('click', async () => {
  const email = singleEmailInput.value.trim();
  if (!email) return;
  const res = await fetch('/api/recipients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (res.ok) {
    singleEmailInput.value = '';
    loadRecipients();
  } else {
    recipientsMeta.textContent = data.error;
  }
});

function parseEmailList(text) {
  return text
    .split(/[\n,]/)
    .map((e) => e.trim())
    .filter(Boolean);
}

async function bulkAdd(emails) {
  if (emails.length === 0) return;
  const res = await fetch('/api/recipients/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails }),
  });
  const data = await res.json();
  if (res.ok) {
    recipientsMeta.textContent = `Added ${data.added.length}. Skipped ${data.skipped.length} invalid.`;
    loadRecipients();
  } else {
    recipientsMeta.textContent = data.error;
  }
}

addBulkBtn.addEventListener('click', () => {
  const emails = parseEmailList(bulkEmailsInput.value);
  bulkAdd(emails);
  bulkEmailsInput.value = '';
});

fileUpload.addEventListener('change', () => {
  const file = fileUpload.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const emails = parseEmailList(String(reader.result));
    bulkAdd(emails);
    fileUpload.value = '';
  };
  reader.readAsText(file);
});

// ---------- Step 4: send ----------

sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(sendForm);
  const jobIds = [...selectedJobIds];

  if (jobIds.length === 0) {
    sendStatus.textContent = 'Select at least one job first.';
    sendStatus.className = 'form-status err';
    return;
  }

  sendBtn.disabled = true;
  sendStatus.textContent = 'Sending…';
  sendStatus.className = 'form-status';

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobIds,
        subject: fd.get('subject') || '',
        message: fd.get('message') || '',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed.');

    sendStatus.textContent = `Sent to ${data.sent}/${data.recipientsTotal} recipients` +
      (data.failed.length ? ` — ${data.failed.length} failed (see server logs).` : '.');
    sendStatus.className = data.failed.length ? 'form-status err' : 'form-status ok';
  } catch (err) {
    sendStatus.textContent = err.message;
    sendStatus.className = 'form-status err';
  } finally {
    sendBtn.disabled = false;
  }
});

// ---------- init ----------
loadRecipients();
