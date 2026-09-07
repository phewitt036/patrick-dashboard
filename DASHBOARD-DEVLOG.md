# Patrick's Command Center — DEVLOG

**URL:** https://patrick-dashboard.vercel.app
**Repo:** https://github.com/phewitt036/patrick-dashboard
**Stack:** Node.js / Express / Vercel
**Local:** http://localhost:3000

---

## 2026-04-17 — Initial Build & Full Deploy

### What was built
- Personal dashboard at `patrick-dashboard.vercel.app`
- Live Salesforce income integration (weekly, monthly, 6-month trend chart)
- Agent status section (Scout, Pam, Claw) with live dot indicators
- Project cards for all 6 active projects with status badges and links
- Quick links bar (Pixit, GitHub, Salesforce, Trailhead, ASU, Canvas, LinkedIn)
- Overview stats row (projects, repos, certs, graduation, school)
- Quick notes scratch pad (auto-saved to localStorage)
- Custom "Pat" favicon with purple-to-teal gradient matching dashboard theme

### Project structure
```
patrick-dashboard/
├── public/
│   ├── index.html         ← full dashboard UI
│   └── favicon.svg        ← custom Pat favicon
├── routes/
│   ├── salesforce.js      ← income API endpoints
│   └── agents.js          ← agent status endpoints
├── server.js              ← Express app
├── .env                   ← secrets (never committed)
├── .gitignore
├── package.json
└── package-lock.json
```

### Salesforce integration
- Uses `jsforce` with username + password auth
- Connected App: `Patrick_Dashboard` in dev org (`pat@patsdelivery.com`)
- Three endpoints:
  - `GET /api/income/weekly` — SUM of `Total_Earnings__c` for THIS_WEEK
  - `GET /api/income/monthly` — SUM of `Total_Earnings__c` for THIS_MONTH
  - `GET /api/income/trend` — grouped monthly totals for LAST_N_MONTHS:6
- Income data pulls live on page load, no manual entry needed

### Agent endpoints
- `GET /api/agent/status` — returns current status of all three agents
- `POST /api/agent/update` — agents write status updates here
  - Requires `x-api-key` header matching `AGENT_API_KEY` env var
  - Body: `{ "agent": "scout", "status": "done", "message": "..." }`
  - Valid statuses: `idle`, `running`, `done`, `error`
  - Dashboard polls every 30 seconds and updates dot colors automatically

### Pi connection script
Located at `/home/pi/scripts/dashboard-update.sh` on pimax:
```bash
#!/bin/bash
curl -s -X POST https://patrick-dashboard.vercel.app/api/agent/update \
  -H "Content-Type: application/json" \
  -H "x-api-key: AGENT_API_KEY" \
  -d "{\"agent\": \"$1\", \"status\": \"$2\", \"message\": \"$3\"}"
```

Usage:
```bash
bash /home/pi/scripts/dashboard-update.sh scout done "Daily intel gathered"
bash /home/pi/scripts/dashboard-update.sh pam running "Writing morning briefing"
bash /home/pi/scripts/dashboard-update.sh claw idle ""
```

### Environment variables (Vercel production)
| Variable | Purpose |
|----------|---------|
| `SF_USERNAME` | Salesforce login email |
| `SF_PASSWORD` | Salesforce password + security token combined |
| `SF_CLIENT_ID` | Connected App consumer key |
| `SF_CLIENT_SECRET` | Connected App consumer secret |
| `SF_REDIRECT_URI` | OAuth callback URL |
| `AGENT_API_KEY` | Secret key for agent POST requests |

### Deployment
- Hosted on Vercel (free hobby plan)
- GitHub repo connected — deploy via `npx vercel --prod`
- Every deploy picks up latest env vars from Vercel dashboard

---

## 2026-09-07 — Rack Chimney Fans

Two 120mm ARCTIC P12 Pro A-RGB fans mounted in the MOJO rack frame itself — one
through the vented bottom plate, one bolted to the underside of the acrylic top.
Both blow upward, so the rack becomes a chimney: filtered air in at the bottom,
past the Pis and mini PCs, out the top. The lights double as a fleet-status
indicator using the same `tempWarn` / `tempCrit` thresholds as the node gauges.

These fans are **not** on a Pi. They hang off an ESP32 (GLEDOPTO GL-C-017WL-D)
running ESPHome, because the job needs two independent 25 kHz PWM channels plus
addressable LED output, and the Pironman HAT already owns the Pi's usable pins.

### Chain
`dashboard → agent-hub (pimax) → Home Assistant (bee) → ESP32 → fans`

One hop longer than the pimax fan widget, same shape otherwise: agent-hub owns
the curve and the status colour, the dashboard only asks and shows.

### Added this session
- `routes/pimax.js` — `/rack`, `/rack/override` (POST + DELETE), `/rack/lights`
- `public/index.html` — "Rack Chimney" tile under the pimax Fan block: mode,
  intake %, exhaust %, intake RPM, hottest node, a swatch mirroring the ring
  colour, four speed presets and four light presets
- `esphome/rack-chimney.yaml` — firmware config (lives in HA's ESPHome add-on;
  kept here so it is versioned alongside the dashboard that drives it)
- `esphome/README.md` — wiring, power, and build order

### Still to do
- Order a **5V 3A supply, 5.5×2.1mm barrel**. This is the only missing part. The
  controller passes its input voltage straight through to the LED terminals, so
  feeding it the 12V brick would put 12V on 5V LED rings and destroy them.
- Tie the 12V and 5V grounds together (lever nut) — without a shared ground the
  PWM signal is meaningless and the fans run flat out.
- agent-hub endpoints on pimax. Until they exist the tile sits greyed rather than
  throwing a red error — the same quiet state it falls back to later if the ESP32
  is unplugged or off the wifi.

### Pin notes
`GPIO16` LED data · `GPIO4` bottom fan PWM · `GPIO13` top fan PWM · `GPIO2` bottom
fan tach. `GPIO12` is left empty on purpose: it is an ESP32 strapping pin, and a
PC fan holds its PWM wire high internally, which is exactly the state that stops
the board booting. Flash over USB before wiring the tach to `GPIO2`.

---

## On the Horizon

### Agent wiring (next session)
- Add `dashboard-update.sh` calls into Scout's cron job (before and after `DAILY-INTEL.md` write)
- Add calls into Pam's morning briefing cron (start, done, error states)
- Add calls into Pam's newsletter cron
- Consider adding Claw webhook for notable Telegram interactions

### Salesforce enhancements
- Add miles driven this week/month (`Total_Miles__c`)
- Add earnings per mile (`Earnings_Per_Mile__c`)
- Add platform breakdown (Uber vs DoorDash via `Source__c`)

### Future features
- School deadline reminders via agent
- OU football playoff odds updater
- Income goal tracker (weekly target vs actual)
- Maddie's dashboard hosted on GitHub Pages or Vercel

---

## Maddie's Dashboard

Separate dashboard built for Maddie — clean light-mode design.

**File:** `maddie-dashboard.html` (standalone, no server needed)
**Features:**
- Monthly calendar with color-coded events per job
  - Green = Marketing Operations
  - Purple = Demand Gen
- To-do list with checkoff and delete
- Quick links (Gmail, Drive, Slack, Notion, LinkedIn, Google Calendar)
- Notes scratch pad
- All data saved to browser localStorage — fully private

**Sharing:** Send the HTML file directly — her data lives in her browser only, no server, no visibility from anyone else. Can host on GitHub Pages for a permanent URL if desired.

---

## Key Learnings

- Vercel `env pull` returns empty values by design — secrets are encrypted server-side and never exposed in plain text via CLI
- `jsforce` username/password auth requires password + security token concatenated with no space or separator
- Agent status is in-memory only on Vercel — resets on redeploy. SQLite or KV store needed for persistence later
- OpenClaw cron jobs require `--model` flag to override agent default model at runtime
- Gemma 4 (9.6GB) causes timeout issues on pimax when running alongside other processes — gemma2:9b (5.4GB) or llama3.2:3b recommended for cron jobs
