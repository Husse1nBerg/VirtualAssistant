# Virtual Assistant — AI Voice Missed-Call Handler

Production-grade missed-call AI voice assistant. When calls to your Rogers number go unanswered, they forward to Twilio where an AI assistant (powered by Claude) has a natural conversation with the caller, extracts structured information, and sends you a summary via SMS/WhatsApp.

## Architecture

```
Rogers Number → (conditional forwarding) → Twilio Number
                                              ↓
                                    POST /voice/inbound
                                              ↓
                                    TwiML → Media Stream (WebSocket)
                                              ↓
                                   ┌──────────────────────┐
                                   │   Call Orchestrator   │
                                   │                       │
                                   │  Audio ←→ Deepgram STT│
                                   │  Text  ←→ Claude AI   │
                                   │  Text  ←→ Deepgram TTS│
                                   │  Audio ←→ Twilio      │
                                   └──────────────────────┘
                                              ↓
                                    Call ends → Summary extracted
                                              ↓
                                    SMS + WhatsApp notification
                                              ↓
                                    SQLite DB (call log + transcript)
                                              ↑
                                    Call recording URL saved when ready
                                    (Twilio → POST /voice/recording-status)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20 + TypeScript |
| Voice | Twilio Media Streams (WebSocket) |
| STT | Deepgram Nova-2 (real-time) |
| TTS | Deepgram Aura / ElevenLabs |
| AI Brain | Claude (Sonnet 4.5) |
| Notifications | Twilio SMS + WhatsApp |
| Database | SQLite via Prisma |
| Deployment | Docker / Render |

## Quick Start

### Prerequisites

- Node.js >= 20
- npm
- Twilio account with a phone number
- Anthropic API key
- Deepgram API key
- ngrok (for local development)

### 1. Clone & Install

```bash
git clone <repo-url> && cd VirtualAssistant
cp .env.example .env
# Edit .env with your actual keys (never commit .env — it's in .gitignore)
npm install
```

### 2. Initialize Database

```bash
npx prisma generate
npx prisma db push
```

### 3. Run Locally

```bash
npm run dev
```

### 4. Expose via ngrok (for Twilio webhooks)

```bash
ngrok http 3000
```

Copy the ngrok HTTPS URL and update:
- `.env` → `BASE_URL=https://xxxx.ngrok-free.app`
- Twilio Console → Phone Number → Voice webhook: `https://xxxx.ngrok-free.app/voice/inbound`
- Twilio Console → Phone Number → Voice fallback: `https://xxxx.ngrok-free.app/voice/fallback`
- Twilio Console → Phone Number → Status callback: `https://xxxx.ngrok-free.app/voice/status`

**Call recording:** Each assistant call is recorded automatically. When the call ends, Twilio sends the recording URL to `/voice/recording-status` and it is stored on the call log (`recordingUrl`, `recordingSid`). No extra Twilio configuration needed.

### 5. Send unanswered Rogers calls to your assistant (not Rogers voicemail)

To have unanswered calls on your **Rogers** number go to your Twilio assistant instead of Rogers voicemail, do both steps below.

**Step A – Turn off Rogers voicemail**

If voicemail is on, Rogers will send unanswered calls to voicemail before (or instead of) forwarding. Turn voicemail off first.

- **From your Rogers phone:** Try dialling **`*93`** and listen for a confirmation (often 2 beeps). That may disable voicemail on some plans.
- **Or:** In **MyRogers** (app or website) go to your phone line → **Manage** → **Voicemail** (or **Call settings**) and turn voicemail **Off**.
- **Or:** Call Rogers and ask to **disable voicemail** for your line.

**Step B – Turn on no-answer call forwarding to your Twilio number**

After voicemail is off, set “forward when no answer” to your Twilio number.

- **From your Rogers phone:** Dial **`*61*4389051485#`** then press **Call**. (Replace with your Twilio number’s 10 digits if different.) Some plans use **`*92`** + number + `#` instead.
- **Or:** In **MyRogers** (app or website) look for **Call forwarding** / **Forward when no answer** and set it to your Twilio number (e.g. +1 438 905 1485).
- **Or:** Call Rogers and say you want **no-answer call forwarding** to a specific number (your Twilio number).

Result: when someone calls your Rogers number and you don’t answer, the call will forward to your Twilio number and your AI assistant will answer (no Rogers voicemail).

**To undo later**

- Turn no-answer forwarding off (e.g. `*93` or MyRogers).
- Turn voicemail back on in MyRogers or by calling Rogers.

### 6. Twilio trial: bypass “press any key” and get SMS/WhatsApp

On a **Twilio trial account** you must do the following or calls/SMS/WhatsApp won’t work as expected.

**6a) Bypass “press any key” and go straight to the assistant**

- In [Twilio Console](https://console.twilio.com) go to **Phone Numbers → Manage → Verified Caller IDs**.
- Add **every phone number that will call your Twilio number** (e.g. your Rogers number, your dad’s number).
- Twilio will send a code by call or SMS; enter it to verify.
- Once verified, when that number calls your Twilio number, Twilio can skip or shorten the trial message and connect the call to your app.

**6b) Receive SMS call summaries**

- Trial accounts can **only send SMS to verified numbers**.
- Add the number where you want summaries (e.g. your Rogers number `OWNER_PHONE_NUMBER`) as a **Verified Caller ID** (same as above).
- That number must match `OWNER_PHONE_NUMBER` in `.env`. After verifying it, post-call SMS will be delivered.

**6c) Receive WhatsApp summaries (optional)**

- Your Twilio number is not WhatsApp-enabled by default. Use the **WhatsApp Sandbox** for testing:
  1. In Twilio go to [Messaging → Try it out → Send a WhatsApp message](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn).
  2. Join the sandbox (send the suggested message to the sandbox number from your WhatsApp).
  3. In `.env` set **`TWILIO_WHATSAPP_FROM=+14155238886`** (sandbox number; may vary—check the console).
  4. Keep `OWNER_WHATSAPP_NUMBER=whatsapp:+15145491860` (your number in E.164).
- Only sandbox-joined numbers can receive WhatsApp messages. For production, use Twilio’s full WhatsApp Business API.

### 7. Test

```bash
# Health check
curl http://localhost:3000/health

# Run tests
npm test
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + active call count |
| POST | `/voice/inbound` | Twilio voice webhook (returns TwiML) |
| POST | `/voice/status` | Call status callback |
| POST | `/voice/fallback` | Fallback voicemail if AI fails |
| POST | `/voice/voicemail-complete` | Post-recording handler |
| POST | `/voice/voicemail-transcription` | Async transcription callback |
| WS | `/media-stream` | Twilio Media Streams WebSocket |

## Environment Variables

See `.env.example` for all required variables.

## Keep the assistant running 24/7 (no laptop needed)

When your laptop sleeps or closes, the app stops and calls fail. To keep it **permanently online**, deploy to a cloud host so it runs 24/7 without your computer.

### Deploy to Render (recommended)

1. **Push your code to GitHub** (if you haven’t already).
2. Go to [render.com](https://render.com) and sign up or log in.
3. **New → Blueprint** and connect your GitHub repo. Select the repo that contains this project.
4. Render will read `render.yaml` and create a **Web Service** with a persistent disk for the database.
5. In the Render dashboard, open your **virtual-assistant** service → **Environment** and set every **secret** env var (the ones marked “sync: false” in the blueprint):
   - `BASE_URL` → leave empty for now (you’ll set it after the first deploy).
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_WHATSAPP_FROM` (if used), `OWNER_PHONE_NUMBER`, `OWNER_WHATSAPP_NUMBER`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`.
6. **Deploy**. After the first deploy, Render gives you a URL like `https://virtual-assistant-xxxx.onrender.com`.
7. Set **`BASE_URL`** in the Render Environment to that URL (e.g. `https://virtual-assistant-xxxx.onrender.com`). Redeploy if needed.
8. In **Twilio Console → Phone Numbers → your number**, set the **Voice webhook** to:
   - `https://virtual-assistant-xxxx.onrender.com/voice/inbound`
   - and the **Fallback** to `https://virtual-assistant-xxxx.onrender.com/voice/fallback`.
9. You can close your laptop; the assistant runs on Render 24/7. No ngrok needed for production.

**Note:** On the free tier, Render may spin down the service after inactivity; the first request after a while can be slow. For always-instant response, use a paid plan or another host (e.g. Railway, Fly.io, a VPS).

## Docker

```bash
# Build and run
docker-compose up --build

# Or standalone
docker build -t virtual-assistant .
docker run -p 3000:3000 --env-file .env virtual-assistant
```

## GO-LIVE CHECKLIST

- [ ] All API keys set in `.env` / Render env vars
- [ ] `BASE_URL` points to your public HTTPS URL
- [ ] Twilio phone number webhook configured → `/voice/inbound`
- [ ] Twilio fallback URL configured → `/voice/fallback`
- [ ] Twilio status callback configured → `/voice/status`
- [ ] Rogers conditional forwarding activated (`*92`, `*90`, `*62`)
- [ ] Test call: dial your Rogers number, let it ring, verify AI answers
- [ ] Verify SMS notification received after test call
- [ ] Verify WhatsApp notification (if configured)
- [ ] Check database has call log entry: `npx prisma studio`
- [ ] Monitor logs for errors during first few real calls
- [ ] Set `NODE_ENV=production` for production deployment
- [ ] Verify webhook signature validation is active in production
