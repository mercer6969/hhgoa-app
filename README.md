# HH Goa 2026 — Frame Generator with real X login + posting

A small Express app that:

- Generates the HH Goa 2026 boarding-pass frame from an uploaded photo (client-side Canvas, no upload needed just to preview).
- Lets people **log in with X** (real OAuth 2.0 Authorization Code + PKCE) and **post the framed image directly to X** on their own account.
- Optionally lets people **set the framed image as their X profile picture** — this uses a legacy endpoint with real constraints, explained below.

Everything here is real, working code against X's current API. Nothing is mocked. But it does need your own X Developer app and credentials — there is no way around that; X does not allow posting on someone's behalf without their own OAuth consent to an app you control.

---

## 1. Create an X Developer App

1. Go to [developer.x.com](https://developer.x.com) and create a Project + App (any tier — the free/pay-per-use tier is enough for login + posting).
2. In the App's **User authentication settings**, turn on OAuth 2.0.
   - App type: **Web App, Automated App or Bot**
   - Callback URI: `https://YOUR_DOMAIN/auth/callback` (see step 3 for local dev)
   - Website URL: anything, e.g. your homepage
3. Under **Keys and tokens**, copy the **OAuth 2.0 Client ID and Client Secret** — these go in `.env` as `X_CLIENT_ID` / `X_CLIENT_SECRET`.

That's all you need for login + posting.

### Optional: profile picture updates

`POST account/update_profile_image` is a **legacy v1.1 endpoint**. Two things about it that are outside this code's control:

- It only accepts **OAuth 1.0a**, not the OAuth 2.0 tokens used for posting — hence the separate "Connect legacy X access" step in the UI.
- As of X's current pricing, v1.1 endpoints are generally **not included in the free / pay-per-use tier** — they require at least the paid **Basic** tier (~$200/mo) or higher on your Developer App. If your app is on the free tier, this call will fail with a 403 even after a successful OAuth 1.0a connection. That's an X pricing restriction, not a bug in this code.

If you want to try it anyway: same App → **Keys and tokens** → **Consumer Keys** (API Key / API Key Secret — different from the OAuth 2.0 client id/secret) → put them in `.env` as `X_API_KEY` / `X_API_SECRET`. Also add a callback URI `https://YOUR_DOMAIN/auth/x1/callback` under the app's OAuth 1.0a settings. Leaving these blank simply hides the profile-picture feature — posting still works fully without them.

---

## 2. Configure and run

```bash
cd server
cp .env.example .env
# fill in X_CLIENT_ID, X_CLIENT_SECRET, SESSION_SECRET (and optionally X_API_KEY/X_API_SECRET)
npm install
npm start
```

By default this runs at `http://127.0.0.1:3000`.

### Local development and OAuth callbacks

X will only redirect to a callback URL that's registered on the app, and `localhost` origins are treated inconsistently by X's login screen on some setups — the easiest path is a tunnel:

```bash
npx ngrok http 3000
```

Take the `https://xxxx.ngrok-free.app` URL it gives you, and:
1. Set `APP_BASE_URL=https://xxxx.ngrok-free.app` in `.env`.
2. Add `https://xxxx.ngrok-free.app/auth/callback` (and `/auth/x1/callback` if using the profile-picture feature) as callback URIs in the X Developer Portal.
3. Restart the server, then open the ngrok URL in your browser.

---

## 3. Deploying

This is a plain Node/Express app — deploy it anywhere that runs Node 18+ (Render, Railway, Fly.io, a VPS, etc.):

- Set `APP_BASE_URL` to your real HTTPS domain.
- Set the callback URIs in the X Developer Portal to match.
- Set a strong random `SESSION_SECRET`.
- The session store here is Express's default in-memory store — fine for one instance / low traffic. For anything beyond that, swap in a real store (Redis via `connect-redis`, etc.) — sessions currently won't survive a server restart or work across multiple instances.

---

## What each piece does

| Feature | Endpoint(s) used | Auth |
|---|---|---|
| Frame generation | none — all client-side Canvas | — |
| Login with X | `GET /2/oauth2/token` (via `/auth/login`, `/auth/callback`) | OAuth 2.0 + PKCE |
| Post to X | `/2/media/upload/{initialize,append,finalize}`, `POST /2/tweets` | OAuth 2.0 user token |
| Set profile picture | `POST /1.1/account/update_profile_image.json` | OAuth 1.0a user token (paid tier) |
| Download PNG | none — `canvas.toBlob()` | — |

Download always works with zero configuration — it's the honest fallback if you don't want to set up X credentials at all, or for people who decline to log in.

## Costs / rate limits to know about

X's pricing changed in Feb 2026: new developers default to **pay-per-use** (roughly $0.01 per post, $0.005 per read) unless they're on a grandfathered legacy plan. Posting through this app calls `POST /2/tweets` once and the media-upload endpoints a few times per post — budget accordingly if you expect real traffic. The profile-picture feature additionally needs the paid Basic tier or higher, independent of pay-per-use pricing.
