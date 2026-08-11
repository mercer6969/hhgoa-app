// HH Goa 2026 — server
//
// Serves the frame-generator frontend and implements:
//   1. "Continue with X" — real OAuth 2.0 Authorization Code + PKCE login
//   2. "Post to X"        — uploads the generated image + posts a tweet
//                            using the X API v2 media + tweets endpoints
//   3. "Set as profile picture" (optional) — legacy OAuth 1.0a three-legged
//      login + POST account/update_profile_image (v1.1). Gated behind
//      X_API_KEY / X_API_SECRET being set, because this endpoint requires
//      a paid X API tier. See README.md for details and caveats.
//
// Run `npm install` then `npm start` inside this folder. Configure .env
// first — see .env.example.

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const OAuth = require('oauth-1.0a');

const {
  PORT = 3000,
  APP_BASE_URL = `http://127.0.0.1:${PORT}`,
  SESSION_SECRET,
  X_CLIENT_ID,
  X_CLIENT_SECRET,
  X_API_KEY,
  X_API_SECRET,
} = process.env;

if (!SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET is not set — using an insecure default. Set it in .env before deploying.');
}

const OAUTH2_CALLBACK = `${APP_BASE_URL}/auth/callback`;
const OAUTH1_CALLBACK = `${APP_BASE_URL}/auth/x1/callback`;
const PROFILE_IMAGE_ENABLED = Boolean(X_API_KEY && X_API_SECRET);

const app = express();
app.set('trust proxy', 1); // needed if deployed behind a proxy/load balancer (Render, Heroku, etc.)

app.use(session({
  secret: SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: APP_BASE_URL.startsWith('https://'),
    maxAge: 1000 * 60 * 60 * 12, // 12h
  },
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — plenty for a 1080x1080 PNG
});

/* =========================================================================
   Small helpers
   ========================================================================= */

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeVerifier() {
  return base64url(crypto.randomBytes(32));
}
function makeChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}
function requireX2Env(res) {
  if (!X_CLIENT_ID || !X_CLIENT_SECRET) {
    res.status(500).send(
      'X login is not configured on this server. Set X_CLIENT_ID and X_CLIENT_SECRET in .env — see README.md.'
    );
    return false;
  }
  return true;
}

/* =========================================================================
   OAuth 2.0 (Authorization Code + PKCE) — login + posting
   ========================================================================= */

app.get('/auth/login', (req, res) => {
  if (!requireX2Env(res)) return;

  const verifier = makeVerifier();
  const challenge = makeChallenge(verifier);
  const state = base64url(crypto.randomBytes(16));

  req.session.codeVerifier = verifier;
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: X_CLIENT_ID,
    redirect_uri: OAUTH2_CALLBACK,
    scope: 'tweet.read tweet.write users.read media.write offline.access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  res.redirect(`https://x.com/i/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  if (!requireX2Env(res)) return;

  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?auth=denied`);
  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect('/?auth=failed');
  }

  try {
    const basic = Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: OAUTH2_CALLBACK,
      code_verifier: req.session.codeVerifier,
      client_id: X_CLIENT_ID,
    });

    const tokenResp = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body,
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');

    req.session.tokens = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + tokenData.expires_in * 1000,
    };

    const meResp = await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url,username,name', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const me = await meResp.json();
    if (!meResp.ok) throw new Error('Could not fetch profile');
    req.session.user = me.data;

    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[oauth2 callback]', err);
    res.redirect('/?auth=error');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

async function ensureFreshAccessToken(req) {
  const tokens = req.session.tokens;
  if (!tokens) throw new Error('Not logged in');
  if (Date.now() < tokens.expires_at - 60_000) return tokens.access_token;

  const basic = Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: X_CLIENT_ID,
  });
  const resp = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || 'Could not refresh session — please log in again.');

  req.session.tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return req.session.tokens.access_token;
}

/* ---- posting: chunked media upload (INITIALIZE/APPEND/FINALIZE) + tweet ---- */

async function uploadMediaV2(accessToken, file) {
  const initResp = await fetch('https://api.x.com/2/media/upload/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: file.mimetype,
      media_category: 'tweet_image',
      total_bytes: file.size,
    }),
  });
  const initData = await initResp.json();
  if (!initResp.ok) throw new Error(initData.detail || initData.title || 'Media initialize failed');
  const mediaId = initData.data.id;

  const appendForm = new FormData();
  appendForm.append('segment_index', '0');
  appendForm.append('media', new Blob([file.buffer], { type: file.mimetype }), 'frame.png');
  const appendResp = await fetch(`https://api.x.com/2/media/upload/${mediaId}/append`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: appendForm,
  });
  if (!appendResp.ok) {
    const errData = await appendResp.json().catch(() => ({}));
    throw new Error(errData.detail || errData.title || 'Media upload failed');
  }

  const finResp = await fetch(`https://api.x.com/2/media/upload/${mediaId}/finalize`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const finData = await finResp.json();
  if (!finResp.ok) throw new Error(finData.detail || finData.title || 'Media finalize failed');

  let info = finData.data.processing_info;
  while (info && info.state && info.state !== 'succeeded') {
    if (info.state === 'failed') throw new Error('X could not process the image.');
    await new Promise((r) => setTimeout(r, (info.check_after_secs || 1) * 1000));
    const statusResp = await fetch(`https://api.x.com/2/media/upload?media_id=${mediaId}&command=STATUS`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const statusData = await statusResp.json();
    info = statusData.data && statusData.data.processing_info;
  }

  return mediaId;
}

app.get('/api/session', (req, res) => {
  res.json({
    loggedIn: Boolean(req.session.user),
    user: req.session.user || null,
    profileImageFeatureEnabled: PROFILE_IMAGE_ENABLED,
    oauth1Connected: Boolean(req.session.oauth1),
  });
});

app.post('/api/post', upload.single('image'), async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
    if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });

    const accessToken = await ensureFreshAccessToken(req);
    const mediaId = await uploadMediaV2(accessToken, req.file);

    const text = (req.body.text || 'Just framed my profile for HH Goa 2026 \uD83C\uDF34 See you in Goa. #FrameInGoa').slice(0, 280);

    const tweetResp = await fetch('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, media: { media_ids: [mediaId] } }),
    });
    const tweetData = await tweetResp.json();
    if (!tweetResp.ok) throw new Error(tweetData.detail || tweetData.title || 'Could not create the post.');

    res.json({
      ok: true,
      id: tweetData.data.id,
      url: `https://x.com/${req.session.user.username}/status/${tweetData.data.id}`,
    });
  } catch (err) {
    console.error('[post]', err);
    res.status(500).json({ error: err.message || 'Something went wrong posting to X.' });
  }
});

/* =========================================================================
   OAuth 1.0a — legacy login used ONLY for account/update_profile_image.
   Only mounted/usable when X_API_KEY + X_API_SECRET are set.
   ========================================================================= */

let oauth1Client = null;
if (PROFILE_IMAGE_ENABLED) {
  oauth1Client = OAuth({
    consumer: { key: X_API_KEY, secret: X_API_SECRET },
    signature_method: 'HMAC-SHA1',
    hash_function(baseString, key) {
      return crypto.createHmac('sha1', key).update(baseString).digest('base64');
    },
  });
}

app.get('/auth/x1/login', async (req, res) => {
  if (!PROFILE_IMAGE_ENABLED) {
    return res.status(404).send('Profile-picture feature is not enabled on this server (X_API_KEY/X_API_SECRET not set).');
  }
  try {
    const requestData = {
      url: 'https://api.x.com/oauth/request_token',
      method: 'POST',
      data: { oauth_callback: OAUTH1_CALLBACK },
    };
    const authHeader = oauth1Client.toHeader(oauth1Client.authorize(requestData));
    const resp = await fetch(requestData.url, { method: 'POST', headers: authHeader });
    const text = await resp.text();
    if (!resp.ok) throw new Error(text || 'request_token failed');

    const params = new URLSearchParams(text);
    const oauthToken = params.get('oauth_token');
    const oauthTokenSecret = params.get('oauth_token_secret');
    if (!oauthToken) throw new Error('X did not return a request token.');

    req.session.oauth1Pending = { token: oauthToken, secret: oauthTokenSecret };
    res.redirect(`https://api.x.com/oauth/authorize?oauth_token=${encodeURIComponent(oauthToken)}`);
  } catch (err) {
    console.error('[oauth1 login]', err);
    res.redirect('/?x1=error');
  }
});

app.get('/auth/x1/callback', async (req, res) => {
  const { oauth_token: oauthToken, oauth_verifier: oauthVerifier } = req.query;
  const pending = req.session.oauth1Pending;
  if (!PROFILE_IMAGE_ENABLED || !pending || pending.token !== oauthToken) {
    return res.redirect('/?x1=failed');
  }
  try {
    const requestData = {
      url: 'https://api.x.com/oauth/access_token',
      method: 'POST',
      data: { oauth_verifier: oauthVerifier },
    };
    const token = { key: pending.token, secret: pending.secret };
    const authHeader = oauth1Client.toHeader(oauth1Client.authorize(requestData, token));

    const resp = await fetch(requestData.url, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ oauth_verifier: oauthVerifier }),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(text || 'access_token exchange failed');

    const params = new URLSearchParams(text);
    req.session.oauth1 = {
      token: params.get('oauth_token'),
      tokenSecret: params.get('oauth_token_secret'),
    };
    delete req.session.oauth1Pending;
    res.redirect('/?x1=connected');
  } catch (err) {
    console.error('[oauth1 callback]', err);
    res.redirect('/?x1=error');
  }
});

app.post('/api/set-profile-image', upload.single('image'), async (req, res) => {
  if (!PROFILE_IMAGE_ENABLED) {
    return res.status(404).json({ error: 'This feature is not enabled on this server.' });
  }
  if (!req.session.oauth1) {
    return res.status(401).json({ error: 'Legacy X access is not connected yet.' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });

  try {
    const url = 'https://api.x.com/1.1/account/update_profile_image.json';
    const token = { key: req.session.oauth1.token, secret: req.session.oauth1.tokenSecret };
    // Multipart bodies are not part of the OAuth1 signature base string —
    // only the URL + method are signed here, matching how twurl and other
    // reference clients sign media-upload style multipart requests.
    const authHeader = oauth1Client.toHeader(oauth1Client.authorize({ url, method: 'POST' }, token));

    const form = new FormData();
    form.append('image', new Blob([req.file.buffer], { type: req.file.mimetype }), 'pfp.png');

    const resp = await fetch(url, { method: 'POST', headers: authHeader, body: form });
    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].message) || 'X rejected the request.';
      throw new Error(
        `${msg} — this legacy endpoint requires a paid X API tier (Basic or higher) in addition to being connected.`
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[set-profile-image]', err);
    res.status(500).json({ error: err.message || 'Could not update profile picture.' });
  }
});

app.listen(PORT, () => {
  console.log(`HH Goa server running at ${APP_BASE_URL}`);
  console.log(`OAuth2 callback: ${OAUTH2_CALLBACK}`);
  if (PROFILE_IMAGE_ENABLED) console.log(`OAuth1 callback:  ${OAUTH1_CALLBACK}`);
  else console.log('Profile-picture feature disabled (set X_API_KEY / X_API_SECRET to enable).');
});
