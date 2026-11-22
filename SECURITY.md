# Security

## Reporting a problem

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/Lydia-ivee/tennis-court-notifier/security/advisories/new)
rather than opening a public issue. I will reply as soon as I can.

## How the app protects subscribers

- **Double opt-in.** Signing up sends a confirmation link. Nothing is stored and no alerts go out until the owner of the inbox clicks it, so nobody can sign a stranger up.
- **Signed links, not emails, as credentials.** Reading, changing, pausing or deleting a subscription needs an HMAC-signed token from an email the subscriber received. Knowing someone's address is not enough.
- **Tokens stay out of logs.** Links carry tokens in the URL fragment, which browsers never send to the server.
- **Purpose-bound tokens.** A confirmation token cannot be used as a manage token, and confirmation tokens expire after 24 hours.
- **Rate limits.** Sign-ups are limited per IP address, and each inbox gets at most one confirmation email every 10 minutes.
- **Strict input handling.** Days and times are checked against fixed allowlists, bodies are size-capped, and everything placed in an email is HTML-escaped, including data from the booking site.
- **No action on page load.** Turn-off and snooze links from emails ask for one tap before acting, so mail scanners that open links change nothing.
- **No silent failures.** Someone who turns email off still gets an email if no push notification gets through. The mail app's one-click Unsubscribe stops email only, and leaves phone alerts running.
- **Push alerts.** Notifications are end-to-end encrypted to each device (RFC 8291) and signed with VAPID (RFC 8292). The Worker only sends to an allowlist of real push services, so a forged subscription cannot aim it at other URLs. Push endpoints never leave the server; the settings page sees only a hashed id and a coarse label like "iPhone". The service worker only opens the booking site.
- **Linking an installed app.** Eight-digit codes are stored hashed and expire after ten minutes. Each inbox gets at most one code per ten minutes, and guesses are rate limited per email address, so spreading them across IP addresses does not help. The request answers the same, in the same time, whether or not an address is subscribed.
- **Locked-down pages.** Static pages ship with a strict Content Security Policy and no inline scripts.
- **Privacy in logs.** Email addresses are masked in log output.

Rotating `TOKEN_SECRET` invalidates every outstanding confirm and manage link at once. Rotating the VAPID keys means every device must turn push alerts on again.
