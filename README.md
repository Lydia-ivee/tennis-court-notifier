# Tennis Court Notifier

A small Cloudflare Worker that watches court availability at Highbury tennis centre and emails you when a slot opens that matches what you asked for.

**Built in July 2026.** This repo was published to GitHub on 22 November 2026. The commit dates (7 and 8 July 2026) are the files' last-modified times from when I built it, not the date it was uploaded. The commit messages say the same.

## How it works

- A cron trigger runs the Worker every 30 minutes.
- It calls the booking site's JSON availability endpoint for the next few days. The booking page is a single-page app, so the slots are not in the HTML and there is nothing to scrape.
- People sign up on a small static page with their email, the weekdays they want and the times they want.
- Preferences are stored in Cloudflare KV. Each person can change or delete theirs.
- Matching slots are emailed with SendGrid, with a link to book.

## Run it

1. `npm install`
2. Copy `wrangler.example.toml` to `wrangler.toml` and fill in your Cloudflare account ID and a KV namespace ID.
3. Set the secrets: `wrangler secret put SENDGRID_API_KEY` and `wrangler secret put FROM_EMAIL`.
4. `npx wrangler dev` to try it locally, `npx wrangler deploy` to deploy it.

## Limits

- No tests yet.
- It depends on an undocumented booking endpoint that can change without notice.
- It checks every 30 minutes, so a slot can be gone before the email lands.
- Be kind to the booking site: keep the polling gentle.

## Next

Tests, a proper retry and backoff on the booking call, and a one-command setup.
