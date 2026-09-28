# TOP 5 ECOM STORES

A handpicked list of the 5 best e-commerce stores for sale right now. The top pick is free. The other four unlock for a one-time $15 payment through PayPal.

Live at **https://top5.prockstem.com**. Plain HTML/CSS/JS frontend, Netlify Functions for the server logic, Netlify Blobs for storage, and PayPal for payments. There is no build step and no external database.

---

## Contents

1. [How the paywall works](#how-the-paywall-works)
2. [Project structure](#project-structure)
3. [Environment variables](#environment-variables)
4. [Local setup](#local-setup)
5. [PayPal setup (app, sandbox accounts, webhook)](#paypal-setup)
6. [Switching from sandbox to live](#switching-from-sandbox-to-live)
7. [Deploying to Netlify](#deploying-to-netlify)
8. [Connecting top5.prockstem.com](#connecting-top5prockstemcom)
9. [Using the admin panel](#using-the-admin-panel)
10. [Access duration (editions)](#access-duration-editions)
11. [Testing](#testing)
12. [Colors and fonts](#colors-and-fonts)

---

## How the paywall works

- **The locked data never leaves the server before payment.** `stores-public` sends store #1 (the free pick) in full. For the other stores it sends only `{ position, category, locked: true }`. The blurred cards are drawn from placeholder text generated in the browser, so there is nothing real to find in the page source or the network tab.
- **The price is set on the server.** `paypal-create-order` creates a PayPal order for exactly `15.00 USD` (see `netlify/lib/config.mjs`). It ignores anything in the request body and records the order id it created.
- **Capture is verified on the server.** `paypal-capture-order` only accepts order ids that the site created. It captures the order through the PayPal Orders API v2, then checks PayPal's response: the order status is `COMPLETED`, there is exactly one capture, that capture is `COMPLETED`, and its amount is exactly `15.00 USD`. Only then does it:
  - store the purchase (order id, capture id, payer email and name, amount, date, edition) in Netlify Blobs;
  - set an access cookie (`t5_access`: `HttpOnly`, `Secure`, `SameSite=Lax`, host-only, so it is never sent to other `prockstem.com` subdomains);
  - return a personal magic link (`https://top5.prockstem.com/access?t=…`), which the success page shows so the buyer can bookmark it.
- **The token is signed and checked on every request.** The access token is HMAC-signed and names only the purchase. `stores-full` looks up the purchase each time, so a refund revokes access immediately.
- **The webhook is a backup.** `paypal-webhook` verifies every event with PayPal's `verify-webhook-signature` API:
  - `PAYMENT.CAPTURE.COMPLETED` records the purchase even if the buyer closed the tab before the capture call returned.
  - `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED` revoke access.
- **Pending payments don't unlock anything yet.** If PayPal reports a capture as `PENDING` (for example, an eCheck), the purchase is saved but does not unlock until the webhook reports it as completed.

## Project structure

```
top5/
├── netlify.toml               publish dir, functions, pretty URLs, security + noindex headers
├── package.json               one dependency: @netlify/blobs
├── .env.example               copy to .env for local dev
├── public/                    static site
│   ├── index.html             hero, free pick, locked cards, unlock box, footer
│   ├── success.html           after payment: shows the magic link
│   ├── admin.html             admin login + dashboard (noindex)
│   ├── terms.html, privacy.html   placeholder pages for you to edit
│   ├── styles/theme.css       ALL colors and fonts (light + dark)
│   ├── styles/main.css, admin.css
│   └── js/app.js, admin.js, theme.js
├── netlify/functions/         one file = one endpoint at /.netlify/functions/<name>
│   ├── stores-public.mjs      free store + locked placeholders
│   ├── stores-full.mjs        all stores, requires valid access cookie
│   ├── access-status.mjs      used by /success
│   ├── access-redeem.mjs      magic link target (/access?t=…)
│   ├── paypal-create-order.mjs
│   ├── paypal-capture-order.mjs
│   ├── paypal-webhook.mjs
│   ├── image.mjs              serves uploaded logos/screenshots
│   └── admin-*.mjs            session, stores, publish, upload, purchases
├── netlify/lib/               shared code (config, PayPal client, tokens, Blobs, seed data)
└── scripts/
    ├── mock-paypal.mjs        fake PayPal API for automated tests
    └── test-paywall.mjs       end-to-end paywall + admin tests
```

## Environment variables

| Variable | Required | Example / notes |
|---|---|---|
| `PAYPAL_CLIENT_ID` | yes | From your PayPal app. It is public (the browser needs it to load the PayPal buttons). |
| `PAYPAL_CLIENT_SECRET` | yes | From your PayPal app. **Secret.** |
| `PAYPAL_WEBHOOK_ID` | yes | The webhook's ID from the PayPal dashboard (e.g. `8PT597110X687430LKGECATA`). |
| `PAYPAL_ENV` | yes | `sandbox` or `live`. (`mock` is only for the automated tests.) |
| `ADMIN_PASSWORD` | yes | Your admin password. Use a long one. Changing it logs out every admin session. |
| `ADMIN_SESSION_SECRET` | yes | 32+ random characters, e.g. the output of `openssl rand -hex 32`. Signs admin sessions **and** buyers' access tokens. Changing it invalidates every buyer's magic link, so set it once. |
| `SITE_URL` | yes | `https://top5.prockstem.com` in production, `http://localhost:8888` locally. Used for magic links and PayPal return/cancel URLs. |
| `ACCESS_MODE` | no | `edition` (default) or `forever`. See [Access duration](#access-duration-editions). |
| `ACCESS_GRACE_DAYS` | no | Default `30`. |

## Local setup

Requirements: Node 20+ and the Netlify CLI.

```bash
npm install -g netlify-cli
cd top5
npm install
cp .env.example .env        # then fill in the values (sandbox credentials)
netlify dev                 # http://localhost:8888
```

- The first request seeds the local database with 5 realistic demo stores. The same happens on your first production deploy, so you can see the layout. Replace them from `/admin`.
- Local Blobs data lives in `.netlify/blobs-serve/`. Delete that folder to start fresh.
- The admin panel is at http://localhost:8888/admin.
- Buy with a **sandbox personal account** (see below), not your real PayPal login.
- PayPal cannot reach `localhost`, so webhooks won't arrive during local development. Everything else works. Test webhooks on a deploy (a Netlify deploy preview works), or expose your dev server with a tunnel (`ngrok http 8888`) and point a sandbox webhook at it.

## PayPal setup

All of this happens in the PayPal Developer Dashboard: https://developer.paypal.com/dashboard/

### 1. Create the app

1. Log in and switch the toggle at the top to **Sandbox**.
2. Go to **Apps & Credentials**, click **Create App**, name it `TOP 5 ECOM STORES`, and choose type **Merchant**. Pick the default sandbox business account.
3. Copy the **Client ID** into `PAYPAL_CLIENT_ID` and the **Secret** into `PAYPAL_CLIENT_SECRET`. Set `PAYPAL_ENV=sandbox`.

### 2. Sandbox accounts

Under **Testing Tools → Sandbox Accounts** PayPal already gives you two accounts:
- a **Business** account. This is the seller (you); payments land here.
- a **Personal** account. This is the buyer. Click it, then **View/Edit account**, to see its email and password.

Pay on your site with the Personal account's login. To see and refund the payment, log in to https://www.sandbox.paypal.com with the Business account.

### 3. Create the webhook

1. In **Apps & Credentials**, open your app and scroll to **Webhooks → Add Webhook**.
2. Webhook URL: `https://top5.prockstem.com/.netlify/functions/paypal-webhook`
3. Tick these events:
   - `Payment capture completed` (PAYMENT.CAPTURE.COMPLETED)
   - `Payment capture refunded` (PAYMENT.CAPTURE.REFUNDED)
   - `Payment capture reversed` (PAYMENT.CAPTURE.REVERSED), optional but recommended (chargebacks)
4. Save, then copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`.

The dashboard's "Webhooks simulator" sends mock events that generally don't pass signature verification, so the site rejects them. To test the webhook, make a real sandbox payment, then refund it from the sandbox business account. The purchase should show *Refunded: Yes* in `/admin`, and the buyer's link should stop working.

## Switching from sandbox to live

1. In the Developer Dashboard, switch the toggle to **Live** and create the same app under Live. This needs a PayPal Business account.
2. Create the live webhook with the same URL and events.
3. In Netlify (**Site configuration → Environment variables**), set the live `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID`, and set `PAYPAL_ENV=live`.
4. Redeploy (**Deploys → Trigger deploy**) so the functions pick up the new values.
5. Buy once with a real account, confirm it unlocks, then refund yourself from PayPal and confirm access is revoked.

Sandbox and live purchases are stored in the same list. If you want the live list clean, you can delete the site's `purchases` Blobs store (Netlify UI: **Blobs**) right before switching.

## Deploying to Netlify

```bash
cd top5
netlify login
netlify init            # create a new site (or `netlify link` to an existing one)
# Set the environment variables (or use the Netlify UI: Site configuration → Environment variables)
netlify env:set PAYPAL_ENV sandbox
netlify env:set PAYPAL_CLIENT_ID  "..."
netlify env:set PAYPAL_CLIENT_SECRET "..."
netlify env:set PAYPAL_WEBHOOK_ID "..."
netlify env:set ADMIN_PASSWORD "..."
netlify env:set ADMIN_SESSION_SECRET "$(openssl rand -hex 32)"
netlify env:set SITE_URL https://top5.prockstem.com
netlify deploy          # draft deploy to check
netlify deploy --prod   # go live
```

Netlify Blobs needs no setup; it is enabled automatically for every site.

If you connect the Git repository in the Netlify UI instead, set **Base directory** to `top5` (the site lives in that folder of the repo). Leave the build command empty and set the publish directory to `public`; `netlify.toml` already says so.

## Connecting top5.prockstem.com

1. In Netlify, open the site and go to **Domain management → Add a domain**. Enter `top5.prockstem.com` and confirm.
2. At your domain provider (wherever `prockstem.com`'s DNS is managed), add one record:

   | Type | Host / Name | Value / Target | TTL |
   |---|---|---|---|
   | `CNAME` | `top5` | `<your-site-name>.netlify.app` | Auto / 3600 |

   Use your site's actual Netlify address, shown in **Domain management** (e.g. `top5-ecom-stores.netlify.app`). Don't touch the existing records for `prockstem.com` or `starthere`.
3. Back in Netlify, wait for the domain to show as verified. DNS usually takes minutes, but can take up to 24 hours.
4. **HTTPS:** under **Domain management → HTTPS**, Netlify provisions a free Let's Encrypt certificate automatically once DNS resolves. If it says "Waiting on DNS propagation", click **Verify DNS configuration**, then **Provision certificate**. Netlify redirects HTTP to HTTPS automatically.
5. Check that `SITE_URL` is `https://top5.prockstem.com`, and that your PayPal webhook URL uses the same domain.

## Using the admin panel

Go to **https://top5.prockstem.com/admin** and sign in with `ADMIN_PASSWORD`. After 5 wrong attempts from one IP address, sign-in is blocked for 15 minutes. Sessions last 12 hours. The admin page is `noindex` and every admin endpoint rejects requests without a valid session.

**Stores tab (your draft):**
- **+ Add store** opens the form with every card field. The multiple is calculated for you as price ÷ (monthly profit × 12). You can attach an optional logo or screenshot (PNG/JPEG/WebP/GIF, up to 2 MB), stored in Netlify Blobs.
- **Order:** drag rows, or use ↑ ↓. Position 1 appears first.
- **Free pick:** choose which store everyone can see. It defaults to position 1.
- **Edit / Delete** change the draft only. Every change saves to the draft automatically.

**Publish:** copies the draft to the public page and sets "Last updated" to now.
- Leave **Start a new edition** ticked when you publish a new set of picks. New visitors then pay for the new edition, and earlier buyers keep access for 30 more days.
- Untick it for small fixes such as typos or a changed price. Nobody's access changes.

**Purchases tab:** payer email, date, amount, PayPal order ID, status and refunded yes/no, plus total paid revenue. **Copy link** generates a fresh magic link for a buyer who lost theirs; check their PayPal receipt email first.

## Access duration (editions)

Controlled by environment variables. No code changes are needed.

- `ACCESS_MODE=edition` (default): a purchase covers the edition that was live when the buyer paid. When you publish a new edition, previous buyers keep full access for `ACCESS_GRACE_DAYS` (default 30) and then see the lock again.
- `ACCESS_MODE=forever`: a purchase never expires.

A refund always revokes access, in either mode.

## Testing

### Automated paywall test (no PayPal account needed)

`scripts/mock-paypal.mjs` is a small fake of the PayPal API. The functions only talk to it when `PAYPAL_ENV=mock`, and it must never be set in production.

```bash
# terminal 1
EXPECT_WEBHOOK_ID=WH-MOCK-123 node scripts/mock-paypal.mjs
# terminal 2: .env with PAYPAL_ENV=mock, PAYPAL_WEBHOOK_ID=WH-MOCK-123, PAYPAL_CLIENT_ID/SECRET=anything
rm -rf .netlify/blobs-serve && netlify dev
# terminal 3
ADMIN_PASSWORD=<your .env password> node scripts/test-paywall.mjs
```

It runs 60 checks, including:
- no locked name, note or number appears in the HTML, JS or API responses before payment;
- made-up, malformed, unapproved, wrong-amount, wrong-currency, and "created outside the site" orders unlock nothing;
- a forged or edited token is refused;
- webhooks with missing or forged signatures are rejected, and refunds revoke access;
- admin endpoints refuse requests without a session, CSRF from other origins is blocked, and login is rate-limited;
- publish, reorder, free-pick, upload and the edition grace period work.

The rate-limit test locks your IP out of admin login for 15 minutes. Delete `.netlify/blobs-serve` to reset.

### Manual sandbox checklist

1. Open the site in a private window. **View source**: no locked store names. **DevTools → Network → stores-public**: locked entries contain only `position`, `category` and `locked`.
2. Click **Unlock all 4 stores – $15** and pay with the sandbox **Personal** account. You should land on `/success` with your magic link.
3. Open the magic link in another browser: the full list should show.
4. Refund the payment from the sandbox **Business** account. After the webhook arrives (seconds to a few minutes), reload: the stores should be locked again, and `/admin → Purchases` should show *Refunded: Yes*.

## Colors and fonts

Every color and font is a CSS variable in `public/styles/theme.css`, with light and dark values. Dark mode follows the visitor's system setting; the moon button overrides it and is remembered in the browser.

The palette is Substack-inspired and was approved when the site was built. Your own site (starthere.prockstem.com) couldn't be read from the build environment, so it wasn't matched. Edit the values in that one file to match it exactly.
