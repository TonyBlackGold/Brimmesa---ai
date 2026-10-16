# Architecture

BRIMMESA AI is one static site. `engine.js` holds the coaching logic and never touches the DOM. `app.js` is the browser shell: speech in and out, the dashboard, and `localStorage`. Worlds, lessons, areas, and characters are JSON. There is no build step and no account server.

## ConversationProvider

A provider is `{ name, enabled, respond(ctx, engine) }`. `respond` returns `[{ speaker, text }]`. `ctx.scripted()` runs the current engine turn (scenario, drill, quiz, or reflection), so any provider can fall back to the script.

`ScriptedProvider` is the fallback. It calls `ctx.scripted()` and nothing else. Menu, driving, and activity routing run before any provider.

`createLLMProvider` builds the Gemini brain. The shared `LLMProvider` object stays disabled and has no key. The shell enables an instance only when `localStorage` holds `brimmesa.gemini.key`. The key is sent as the `x-goog-api-key` header to `generativelanguage.googleapis.com` and is never written into the page, the profile, or a log. The default model id is `gemini-3.5-flash-lite`, and Settings can change it. A local counter stops at 50 successful requests per calendar day. HTTP 429, offline, a bad key, and any other error return the scripted lines. Scenario scores use a JSON score from the model when it is a number from 0 to 100; otherwise the rubric scores the turn. Quizzes still grade the original questions.

`makeHttpProvider` is the earlier optional adapter. It can post to an OpenAI-compatible proxy if some other code constructs it. This page does not construct it, and no key is shipped.

## Areas, characters, and progress

`data/areas.json` is the life roadmap: eight destinations, keywords for voice, activity ids, and scripted reflections. `data/characters.json` is the cast. Portraits, and later `voiceId`, `memory`, and `avatarModel`, are swapped there. The pictures in use are still images.

Progress stays on the device under `brimmesa.profile.v1`: name, XP, level, streak, mastery, and short summaries. Microphone audio is not stored. Repeated spoken lines may be cached in IndexedDB on this device. Roadmap percentages are mastery scores, or zero when nothing has been scored.

`setAvatarState('idle' | 'listening' | 'speaking' | 'thinking', { speaker, viseme })` drives the portraits and, when 3D is on, Coach Amara. See `AVATARS.md`. The 3D module is `avatar/` and loads only after first paint. The homepage face is the coach photo, warped in the browser. The main page does not show a loading badge. If the warp cannot start, the still photo stays, and the message is only on the Settings portrait line. Speech tries ElevenLabs first when `brimmesa.eleven.key` is saved, then Gemini TTS, then the browser voice. ElevenLabs character timings drive the mouth. The still portrait remains when 3D is off or the model fails to load.

## Next phase

Gemini runs in the browser after the user saves a key in Settings. The practice script still covers every turn when that key is missing or Gemini does not answer. Other characters can reuse `Character.load` once each has a redistributable rig. The empty areas need real activities. Accounts, cloud voices, and payments stay off until they are explicitly chosen.
