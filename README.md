# Job Broadcaster

A focused, single-purpose tool: search **Adzuna**, **Reed**, and **Jooble**,
pick the specific jobs you want to share, maintain a recipient list, and
send the exact same email — same jobs, same message — to everyone on it.

This is deliberately simpler than a "smart matching" system: there's no
per-user preference matching, no automatic scheduling. You decide what goes
out, and to whom, every time.

## The workflow

1. **Find jobs** — search by keyword and location across all three job APIs at once.
2. **Select jobs** — check the ones worth sharing.
3. **Recipients** — build a fixed list: add one at a time, paste a list, or upload a `.csv`/`.txt` file.
4. **Send** — write a subject and message, click send. Every recipient gets an identical email.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | [developer.adzuna.com](https://developer.adzuna.com) — free signup |
| `REED_API_KEY` | [reed.co.uk/developers](https://www.reed.co.uk/developers) — free signup |
| `JOOBLE_API_KEY` | [jooble.org/api/about](https://jooble.org/api/about) — free signup |
| `RESEND_API_KEY` | [resend.com](https://resend.com) — free signup, needed to send email |

You don't need all three job sources configured — any without keys set is
skipped automatically (logged as a warning, not an error).

## Run

```bash
npm start
```

Open `http://localhost:3000`.

## Important: emailing real recipients requires a verified domain

Resend's default sender (`onboarding@resend.dev`) can only send to **your
own** Resend account email — this is their anti-abuse sandbox restriction,
not a bug. To actually email people on your recipient list:

1. Go to [resend.com/domains](https://resend.com/domains) and add a domain you own
2. Add the DNS records (SPF/DKIM) they give you, at your domain registrar
3. Once verified, update `.env`:
   ```
   RESEND_FROM="Job Broadcaster <notifications@yourdomain.com>"
   ```

## Deploying

This is a standard Node/Express app — deploys the same way on Render,
Railway, Fly.io, or similar:

1. Push this folder to its own GitHub repo
2. Create a new **Web Service** pointed at that repo
3. Build command: `npm install` — Start command: `npm start`
4. Add all the same variables from `.env` in the platform's **Environment**
   settings (the platform never reads your local `.env` file — only its own
   dashboard's environment variables)

**Free-tier note:** platforms like Render's free tier spin down after
inactivity, delaying the first request after idle time by 30–50+ seconds.
This is expected free-tier behavior, not a bug in the app.

## How it works internally

```
public/ (single page)  →  routes/broadcast.js
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
     fetchers/adzuna.js  fetchers/reed.js  fetchers/jooble.js
              │                 │                 │
              └───────► normalized, deduped jobs ◄┘
                                │
                    services/jobCache.js (in-memory, so
                    selected job IDs can be resolved when sending)
                                │
                    services/recipients.js (persisted list, data/db.json)
                                │
                    services/broadcastMailer.js (sends via Resend HTTP API,
                    one email per recipient, in small batches)
```

- **Search results are not persisted** — they live in memory only until the
  next search replaces them. This is intentional; searches are disposable,
  recipients and sends are what matter.
- **Recipients persist** in `data/db.json` across restarts.
- **Sends are one-to-one, not one email with everyone in the "to" field** —
  each recipient gets their own individual email, so no one sees anyone
  else's address, and one bad address doesn't affect the rest.
