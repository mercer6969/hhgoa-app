# HH Goa 2026 — Frame Generator with real X login + posting

**🔗 Live app: [https://hhgoa-app.onrender.com](https://hhgoa-app.onrender.com)**

A small Express app that:

- Generates the HH Goa 2026 boarding-pass frame from an uploaded photo (client-side Canvas, no upload needed just to preview).
- Lets people **log in with X** (real OAuth 2.0 Authorization Code + PKCE) and **post the framed image directly to X** on their own account.
- Optionally lets people **set the framed image as their X profile picture** — this uses a legacy endpoint with real constraints, explained below.

Everything here is real, working code against X's current API. Nothing is mocked. But it does need your own X Developer app and credentials — there is no way around that; X does not allow posting on someone's behalf without their own OAuth consent to an app you control.

---

## 1. Create an X Developer App

1. Go to [developer.x.com](https://developer.x.com) and create a Project + App (any tier — the free/pay-per-use tier is enough for login + posting).
2. In the App's **User authentication settings**, click **Set up** (or **Edit** if already configured).
   - **Turn the OAuth 2.0 toggle ON.** This is a separate switch at the top of the form — it's easy to fill in every field below it and still have this left off, which causes X's consent screen to fail with a vague *"Something went wrong / You weren't able to give access to the App"* error and no useful detail.
   - App type: **Web App, Automated App or Bot**
   - App permissions: **Read and write** (required for posting; Read-only will silently break `tweet.write`/`media.write`)
   - Callback URI: `https://YOUR_DOMAIN/auth/callback` (see step 3 / the deployment section for what `YOUR_DOMAIN` is on Render vs local dev)
   - Website URL: your app's bare domain, e.g. `https://YOUR_DOMAIN` (leaving this blank or malformed can also break the consent flow)
   - Click **Save** at the bottom of the form — X sometimes needs an explicit save after toggling OAuth 2.0 for it to actually take effect.
3. Under **Keys and tokens**, copy the **OAuth 2.0 Client ID and Client Secret** — these go in `.env` as `X_CLIENT_ID` / `X_CLIENT_SECRET`.

That's all you need for login + posting.

### Optional: profile picture updates

`POST account/update_profile_image` is a **legacy v1.1 endpoint**. Two things about it that are outside this code's control:

- It only accepts **OAuth 1.0a**, not the OAuth 2.0 tokens used for posting — hence the separate "Connect legacy X access" step in the UI.
- As of X's current pricing, v1.1 endpoints are generally **not included in the free / pay-per-use tier** — they require at least the paid **Basic** tier (~$200/mo) or higher on your Developer App. If your app is on the free tier, this call will fail with a 403 even after a successful OAuth 1.0a connection. That's an X pricing restriction, not a bug in this code.

If you want to try it anyway: same App → **Keys and tokens** → **Consumer Keys** (API Key / API Key Secret — different from the OAuth 2.0 client id/secret) → put them in `.env` as `X_API_KEY` / `X_API_SECRET`. Also add a callback URI `https://YOUR_DOMAIN/auth/x1/callback` under the app's OAuth 1.0a settings. Leaving these blank simply hides the profile-picture feature — posting still works fully without them.

---

## 2. Configure and run locally

```bash
cd server
cp .env.example .env
# fill in X_CLIENT_ID, X_CLIENT_SECRET, SESSION_SECRET (and optionally X_API_KEY/X_API_SECRET)
npm install
npm start
```

By default this runs at `http://127.0.0.1:3000` — that address is a **local-only default** hardcoded as the fallback for `APP_BASE_URL`. It only works on your own machine; it is not reachable from the internet and must never be used as the value once you deploy (see below).

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

## 3. Deploying (e.g. to Render)

This is a plain Node/Express app — deploy it anywhere that runs Node 18+ (Render, Railway, Fly.io, a VPS, etc.). Using Render as an example:

1. **Find your Render URL.** After creating the web service, Render shows a live URL at the top of the service page, e.g. `https://hhgoa-app.onrender.com`. This is served over HTTPS on the standard port — there is no port number in the URL, and you don't choose or add one.
2. **Set `APP_BASE_URL` in Render's Environment tab** to that bare URL, exactly, with **no trailing slash and no path appended** — just `https://hhgoa-app.onrender.com`. The server builds the actual callback path itself (`${APP_BASE_URL}/auth/callback`); do not put `/auth/callback` into `APP_BASE_URL`.
3. **Set the callback URIs in the X Developer Portal** to match:
   - Callback URI: `https://hhgoa-app.onrender.com/auth/callback`
   - Website URL: `https://hhgoa-app.onrender.com`
   - (and `https://hhgoa-app.onrender.com/auth/x1/callback` too, if using the profile-picture feature)
4. **Set a strong random `SESSION_SECRET`**, and `X_CLIENT_ID` / `X_CLIENT_SECRET` (and optionally `X_API_KEY` / `X_API_SECRET`), all in Render's Environment tab.
5. **Redeploy** after changing any environment variable — Render usually does this automatically, but you can force it with Manual Deploy. Wait for the status to show **Live** before retesting.
6. **Confirm the env var actually took effect** by checking Render's Logs tab on startup — it should print:
   ```
   OAuth2 callback: https://hhgoa-app.onrender.com/auth/callback
   ```
   If it still prints `127.0.0.1:3000` here, `APP_BASE_URL` did not get picked up — double-check the Environment tab and trigger a fresh deploy.
7. The session store here is Express's default in-memory store — fine for one instance / low traffic. For anything beyond that, swap in a real store (Redis via `connect-redis`, etc.) — sessions currently won't survive a server restart or work across multiple instances.

### Troubleshooting: "Something went wrong — You weren't able to give access to the App"

This error appears on **X's own consent screen**, before X ever redirects back to your server — so it will **not** show up in your Render logs, and it's not something wrong with `server.js`. Check, in this order:

1. **OAuth 2.0 toggle is ON** in User authentication settings (see step 2 above) — the single most common cause.
2. **Type of App** is `Web App, Automated App or Bot`, not `Native App` or `Single Page App` — a public-client app type conflicts with this server's confidential-client (client secret) token exchange.
3. **App permissions** is `Read and write`, not `Read` only.
4. **Callback URI matches `APP_BASE_URL` + `/auth/callback` exactly** — same scheme, same host, no trailing slash mismatches.
5. **Website URL is filled in and valid.**
6. The App/Project isn't suspended or pending re-acceptance of the developer agreement (check for banners on the dashboard).
7. Retry in an incognito/private window in case a previous failed attempt is cached.

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
