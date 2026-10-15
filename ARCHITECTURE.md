# Architecture

BRIMMESA AI is one static site. `engine.js` holds the coaching logic and never touches the DOM. `app.js` is the browser shell: speech in and out, the dashboard, and `localStorage`. Worlds, lessons, areas, and characters are JSON. There is no build step and no account server.

## ConversationProvider

A provider is `{ name, enabled, respond(ctx, engine) }`. `respond` returns `[{ speaker, text }]`. `ctx.scripted()` runs the current engine turn (scenario, drill, quiz, or reflection), so any provider can fall back to the script.

`ScriptedProvider` is enabled. It is the provider the page uses. It calls `ctx.scripted()` and nothing else.

`LLMProvider` is the Phase 2 seam. `enabled` is `false`. It has no model key and it does not call the network. Its `respond` returns `ctx.scripted()` so turning the flag on by mistake cannot go silent or leak a request. The shell never selects it.

`makeHttpProvider` is the earlier optional adapter. It can post to an OpenAI-compatible proxy if some other code constructs it. This page does not construct it, and no key is shipped.

## Areas, characters, and progress

`data/areas.json` is the life roadmap: eight destinations, keywords for voice, activity ids, and scripted reflections. `data/characters.json` is the cast. Portraits, and later `voiceId`, `memory`, and `avatarModel`, are swapped there. The pictures in use are still images.

Progress stays on the device under `brimmesa.profile.v1`: name, XP, level, streak, mastery, and short summaries. Audio is not stored. Roadmap percentages are mastery scores, or zero when nothing has been scored.

`setAvatarState('idle' | 'listening' | 'speaking' | 'thinking', { speaker, viseme })` drives the portraits and, when 3D is on, Coach Amara. See `AVATARS.md`. The 3D module is `avatar/` and loads only after first paint. Lip sync is timed from the spoken text, because `speechSynthesis` does not expose audio. The still portrait remains when 3D is off or WebGL fails.

## Next phase

A server-side proxy can enable `LLMProvider` without putting a key in the browser. Other characters can reuse `Character.load` once each has a redistributable rig. The empty areas need real activities. Accounts, cloud voices, and payments stay off until they are explicitly chosen.
