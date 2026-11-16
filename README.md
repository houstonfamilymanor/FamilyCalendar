# Family Calendar

A shared family calendar at a hosted URL. You and your spouse open it, sign in with Google, and see or edit the family calendar.

**Architecture.** One shared family Google account owns everything:

```
web/index.html  (hosted page, Google sign-in)
      │  ID token on every request
      ▼
apps-script/    (Apps Script web app, runs as the family account)
      │  verifies token + email allowlist
      ▼
Family Google Calendar  (also shared to personal accounts → shows on phones)
```

Planned: school emails auto-forwarded from a personal inbox to the family account, then turned into calendar events by a timed Apps Script job.

## Layout

| Path | What |
|---|---|
| `web/index.html` | The whole frontend (single file, no build step) |
| `apps-script/Code.js` | Backend: `doGet` lists events, `doPost` handles create, update and delete |
| `apps-script/appsscript.json` | Manifest: scopes, timezone, web-app settings |

## Backend config (not in git)

Set these in the Apps Script editor under **Project Settings → Script Properties**:

- `ALLOWED_EMAILS`: comma-separated Google accounts allowed to use the app
- `CALENDAR_ID`: optional. If it's not set, the family account's primary calendar is used.

## Deploying the backend

```bash
npm install -g @google/clasp
clasp login            # sign in as the FAMILY account
cd apps-script
clasp push
```

Then in the Apps Script editor go to **Deploy → Manage deployments → (existing deployment) → Edit → Version: New version**. Editing the existing deployment keeps the `/exec` URL the same.

## Running the page locally

```bash
npx serve web -l 5000
```

`http://localhost:5000` must be listed under **Authorized JavaScript origins** for the OAuth client in Google Cloud Console. If it isn't, Google sign-in won't render.
