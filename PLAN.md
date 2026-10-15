# BRIMMESA AI: Voice-First Learning Game. Plan v0.1 (2026-10-15)

## 1. Architecture (simplest stack that works)
- **One static web app / PWA** (HTML + vanilla JS, no build step). It works on a phone with headphones and can be installed to the home screen later. No native app until the core experience is proven.
- **Speech, prototype tier (free):** the browser Web Speech API. `SpeechRecognition` handles speech-to-text and `speechSynthesis` handles text-to-speech. Audio stays in the browser and is never stored by us.
- **Conversation brain:** `engine.js` is a pure state machine covering menu, scenario, drill, and quiz, with pluggable providers:
  - `ScriptedProvider`: the built-in rule-based engine. It costs $0 and powers the current demo.
  - `makeHttpProvider`: one LLM call per user turn to an OpenAI-compatible endpoint, sent through a tiny server proxy so API keys never reach the browser. If the call fails, it falls back to the scripted engine.
- **Content is data-driven:** `data/worlds.json` lists worlds and activities. Each activity points to a JSON file with a scenario, drill, or curriculum. Network+, CySA+, A+, and Linux+ can be added by copying `data/curricula/secplus-sy0-701.json`, which holds domains, weights, items (teach, question, accepted answers, explanation), and a disclaimer.
- **Upgrade path:** (1) Add an LLM for free-form character replies and coach feedback. (2) Use cloud TTS for richer voices. (3) Move to a realtime speech-to-speech API for low latency and natural barge-in, reserved for paid tiers.

## 2. Multi-character voices
- Each character in the JSON carries a `voice` setting (`pitch`, `rate`, voice `index`/`prefer`). The app gives each character its own browser voice, pitch, rate, and avatar color: Coach Amara, Jasmine (bright and quick), Renee (lower and dry), and Marcus (low and fast).
- With an LLM, the model returns `[{speaker, text}]` lines and the client voices each line. In the later cloud tier, each character maps to a provider voice ID.
- Tapping the mic interrupts whoever is speaking (barge-in).

## 3. Memory and progress data model (localStorage now, then a server DB per account)
```
profile = { name, xp, streak, lastDay, driving,
  mastery: { "<skill>": {attempts, best, last, mastered},
             "secplus.items": {q1:true, q4:false},          // drives personalized review
             "secplus.domains": {"2.0": {seen, correct}} }, // readiness by exam domain
  history: [{t, activity, score, xp, summary}] (last 50), lastFeedback, lastActivity }
```
- **XP rewards improvement:** `xp = 0.2*score + 0.6*(score - previous best)`, plus 5 XP the first time. Repeating at the same level earns little. Level = floor(sqrt(xp/50)) + 1. Mastery is a best score of 85 or higher. Streaks count by day.
- **Privacy:** no raw audio is stored, only text summaries. The "Progress & history" panel lets the user view everything saved and wipe it in one click. When accounts arrive: store transcripts only if the user opts in, set a retention window, and offer export and delete.

## 4. Costs (based on public prices fetched 2026-10-15; the per-user math is an ESTIMATE)
Sources: OpenAI API pricing https://developers.openai.com/api/docs/pricing ; xAI models & voice pricing https://docs.x.ai/docs/models

Assumptions (estimates): one active user practices **60 min/month**, with about 4 user turns per minute (240 turns), about 2,000 prompt tokens and 150 output tokens per turn, and the AI speaking about 50% of the time (about 27k characters).

| Tier | Stack | Est. cost / active user / month |
|---|---|---|
| 0 (today's prototype) | Browser speech + scripted engine | **$0** |
| 1 (recommended next) | Browser speech + small LLM: gpt-6-luna ($0.10 in / $0.50 out per 1M) or grok-4.3 ($1.25 / $2.50) | **~$0.07 (luna) to ~$0.70 (grok-4.3)** |
| 2 | Tier 1 + cloud voices: xAI TTS $15/1M chars (~$0.41) + STT $0.20/hr streaming (~$0.20), or gpt-4o-mini-transcribe $0.003/min | **~$0.70 to $1.30** |
| 3 (premium realtime) | Speech-to-speech: grok-voice-3.0 $0.08/min, or gpt-live-1 $0.05/min plus backend model usage | **~$3 to $5 per hour of practice.** A 10 h/month power user costs $30–48, so usage caps are required |

- **Hosting:** the static app plus a tiny proxy runs on a free or low-cost static host or serverless tier (estimate $0–$10/month at small scale; pick one when we deploy). No billing is active.
- **Pricing check:** at $14.99–$24.99/month, Tiers 1–2 leave very large margins. Tier 3 only works with a capped minute allowance (for example, 3 h/month on the top plan, about $15 of cost), or as a paid add-on.
- **Development:** the MVP so far was built by agents at near-zero cash cost. Tiers 1–2 add about 1–2 weeks of agent/dev effort plus about $5–20 in API testing credits (estimate).

## 5. Phased schedule
- **Phase 0 (done today):** playable local prototype with all six requirements, scripted engine, headless tests.
- **Phase 1 (1–2 wks):** server proxy + small LLM for free-form character replies and coach feedback. Expand Security+ to about 100 original items across all 5 SY0-701 domains. Add 3 more social and communication scenarios. Tony uses it daily (dogfooding).
- **Phase 2 (2–4 wks):** accounts and a server-side profile, cloud TTS voices, a hardened driving mode (shorter prompts, no visuals needed), PWA install, a private beta with 10–20 users, and cost-per-user telemetry.
- **Phase 3:** realtime voice for premium, a freemium paywall (a free intro plus limited minutes), Stripe billing activated only with Tony's approval, and additional certs from the curriculum template.

## 6. Brimmesa brand integration (the store is not touched)
- Host BRIMMESA AI separately at **`ai.brimmesa.com`** (a subdomain with its own deploy), with a link or menu item from the main site. This avoids any change to the storefront code, theme, or checkout. Adding the subdomain is one DNS record and needs Tony's approval and access.
- Shared brand: palette (green and gold), wordmark, and a cross-promotion slot (for example, a "BRIMMESA Botanicals" card in the app). Ecosystem navigation: AI / Academy / Social / Botanicals.
- The Security+ content always carries the disclaimer: "Original practice content. Not affiliated with or endorsed by CompTIA."

## 7. Decisions needed from Tony
1. When we move past the prototype: **which LLM provider and monthly API budget cap** (suggestion: start with a $20/month cap on a small model), and later which realtime voice provider.
2. **Hosting:** approve the `ai.brimmesa.com` subdomain and a host. This needs domain/DNS access.
