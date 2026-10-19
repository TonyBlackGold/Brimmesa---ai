# Communication gym assessment

Baseline: commit `fa179e4` (service worker `brimmesa-v27`), the painted map, the four coaches, and the scripted engine on GitHub Pages. This note is written from that code. The same change that adds this file also ships the $0 slice in section (f), phase 0. Prices below were read from the vendors' public pages on 19 October 2026. Where two pages disagree, both figures are quoted. Nothing here was filled in from memory.

The app stays one static site. No new app, no world redesign, no replacement of Aria, Amara, Jasmine, Renee, or Marcus.

## (a) Four layers, and where they are stuck together

### Voice

Speech in is `webkitSpeechRecognition` in `app.js` (`listen`, the `#mic` button, the `#auto` checkbox). It runs only in a secure context, with `continuous: false` and `interimResults: false`. One result calls `send()`. A miss restarts up to six times if hands-free is on. A `not-allowed` error tells the learner to use the address-bar lock. Tapping the mic while audio is playing runs `interrupt()`: it bumps `speechGen`, cancels `speechSynthesis`, stops the buffered player, and calls `face.interrupt()`. That is press-to-interrupt, not a voice-activity barge-in. The mic never hears the learner while the coach is still the one holding the recognizer, because `listen()` returns immediately when `busy` is true, and `play()` sets `busy` for the whole utterance.

Speech out is `speech.js`. Order, when a key exists: ElevenLabs `eleven_flash_v2_5` with timestamps, then Gemini `gemini-3.8-flash-lite-tts`, then `speechSynthesis`. Clips cache in IndexedDB (`brimmesa-tts`). Gemini spoken lines stop at 40 a day. Browser speech cannot feed Web Audio, so it cannot drive a measured mouth.

Turn-taking is the `play()` then `listen()` loop. Hands-free is the checked `#auto` box: after `play()`, if the tab is visible and no lesson loop holds the lock, `listen()` starts 250ms later.

Reusable pieces: `BrimSpeech.createSpeaker`, `BrimSpeech.createEleven`, `interrupt()`, `spokenText()` (the brand is spoken "Brimmesa").

### Conversation

Personas live in `data/characters.json` and are rendered by `createLLMProvider.persona()` in `engine.js`. Guest turns for Amara, Jasmine, and Renee are `guestTurn()` in `app.js`: one Gemini `generateContent` call if `brimmesa.gemini.key` is in localStorage and the 50-turn daily cap is not hit, otherwise `library.js` `methodReply()`. Marcus has his own path (`marcusTurn`, the first-meet assessment).

Context is three different stores:

- `brimmesa.gemini.turns` keeps the last 10 provider turns (`readMemory` / `writeMemory`). The scripted engine does not read this.
- `spokenRecent` in `app.js` is the last 8 spoken lines, in memory only, until this change.
- `hostSession.ariaSummary` is those recent lines joined, copied once at handoff.

`engine.chat()` used to prompt as Amara whenever `activeCoach` was empty, while `present()` relabeled that line as Aria on the map. The menu brain and the map voice were different people. Phase 0 points that menu call at Aria.

Live facts (clock, weather, holidays, news) are `context.js`. They are tagged LIVE or UNKNOWN and are not a memory of the learner.

Reusable pieces: `methodLine` / `methodReply`, `BrimContext.prompt()`, `persona()`, `remember()`.

### Coaching

The shared method is `library.js` `METHOD`: welcome, explain, demonstrate, invite, coach, encourage. It is a paragraph, not a state machine. `hostSession.teachStep` flips between `invite` and `coach`. Marcus has a real loop (`learn → explain → practice → communicate → improve → advance`) and a first-meet assessment under `brimmesa.learner.marcus`. The other coaches store only `{ level: 'experienced' }` at `brimmesa.learner.{id}` after "skip ahead."

Quizzes are graded in the engine. Feedback is `library.rubric()` (keyword overlap) plus, when a key exists, one Gemini sentence that is not allowed to change the verdict (`engine.quiz()`). XP and streak live on `brimmesa.profile.v1` via `awardXP` and `touchStreak`. There is a Clear history control. There was no learner profile with objectives, strengths, weaknesses, or a delete that leaves the engine history alone.

Reusable pieces: `rubric`, `feedbackText`, `awardXP`, Marcus `PROBES`, the CIA and phishing challenges.

### World and game

The map is one flat image plus a CSS camera (`walk.js`, `data/walks.json`). Handoff is `beginHandoff` / `activateCoach`: `releaseWork()`, select the destination, walk, two-line `INTRO` unless the walk was skipped, front-facing `showTalk`, then `marcusGreet` or `guestOpen` (`methodLine`). XP is awarded inside activities, not by walking. Aria parks beside the coach. Amara's corner sprite is separate and does not lip-sync.

Reusable pieces: `BrimWalk.play`, `BrimMap`, `INTRO`, `releaseWork`, `lessons[coachId + ':' + activityId]`.

### Where the layers are coupled

- `send()` is the voice router, the handoff router, the quiz grader, and the coach turn. A mic result cannot be reused without that function.
- `play()` both speaks and decides whether to open the mic. Coaching cannot hold the floor without also owning turn-taking.
- `present()` rewrites `speaker: 'coach'` from the view (`aria` on the map, `amara` on an area). The engine's persona and the mouth on screen can disagree. Phase 0 fixes the empty-coach menu case only.
- `guestTurn()` mixes persona, library search, the Gemini prompt, and `teachStep`. There is no coaching object a different voice stack could call.
- Quiz state is per coach (`e10e0af`). Coaching *style* was not. Amara and Jasmine shared the same one-shot reply function.
- `engine.chat()` and `engine.reflect()` still name Amara for area reflection. That is deliberate for the area screen, and it is a second brain next to `guestTurn()`.

## (b) Known bugs against `fa179e4`

| Bug | Mark | What the code does |
| --- | --- | --- |
| Unreliable handoffs | still present | `beginHandoff` and `activateCoach` do walk, then intro, then the coach. A thrown walk is caught and the map jumps to the building. A skipped walk drops the two-line intro and still opens the lesson. A `hostSession` change during the walk aborts the opening (`if (!hostSession \|\| hostSession.coachId !== coach.id) return`). Card taps no longer speak Aria's old "Absolutely" line before the walk. The path exists. It is not proven reliable. |
| Shared or wrong quiz state | fixed | `engine.lessons` is keyed `coach:activity`. Grading uses `askedId`. `releaseWork()` runs on coach switch and on the way back to Aria. `test.js` still asserts that "mfa" is not graded as ransomware and that a parked quiz does not leak into Mindset. |
| Inaccurate feedback | still present | The scripted rubric counts keywords. Gemini may add a sentence and must not change the verdict. Scene scores can still be coarse. No second grader was added. |
| Navigation reset | fixed | Any destination updates the mission card and Start. Wealth stays selected only if it was the last tap. Map, Start, and the area screen share `selectedDestId`. The Life Roadmap panel is still on the area screen, not the map tab. |
| Missing intros | still present | The two-line `INTRO` plays at the building unless Skip was used. `data/scenarios/goal-talk.json`, `health-gym.json`, `travel-order.json`, and `wealth-pitch.json` still cast Aria as the person in the room. |
| Inconsistent mic on Android | untested | The code gates on a secure context, sets `continuous: false`, and restarts a limited number of times. This run has no Android device. Headless Chrome stubs `speechSynthesis` and does not grant a microphone. |
| Lip-sync mismatch | still present | Amara's conversation face can warp from a text viseme clock, and from word timings when a saved key produced an audio buffer. Marcus, Jasmine, Renee, and Aria's talk face are a jaw pulse of about 3.5%. Map sprites do not move their mouths. `speechSynthesis` has no buffer to measure. |
| Poor mobile interaction | fixed | The audit dock, 44px targets, and the Start button clearing the nav are still in `audit-ui.js`. Headless checks at 390×844 and 360×800 passed on the cinematic build. A real notch, gesture bar, or keyboard is untested and is listed with the Android items. |
| Disconnected coaching | still present on the baseline | Amara, Jasmine, and Renee answered in one shot. No mode, no lesson record the learner could open. Phase 0 adds Amara's machine, four modes, isolated coach state, and a profile. Jasmine and Renee are still one-shot. Marcus already had an assessment and a challenge loop; he did not have the four modes. |

## (c) Smallest path to a 5-minute Aria conversation

Aria already greets, takes a name, hands off, and returns. What she does not do is keep a topic for five minutes. The menu model call was Amara's persona. Memory was the last few lines, dropped on reload. Barge-in is a tap. Hands-free exists (`#auto`, on by default) and still waits until she finishes, because `listen()` will not start while `busy` is set.

Smallest change that stays on this site:

1. Keep Web Speech for STT and the existing TTS order. Do not add a vendor.
2. Press-to-talk stays the mic button. Hands-free stays the checkbox. Do not set `continuous: true`. That flag is a known source of the Android mic bug, and this run cannot retest a phone.
3. Barge-in stays tap-to-interrupt. A true barge-in needs either a second capture graph while audio plays, or a duplex model. Both are a different architecture.
4. Keep a rolling summary plus the last eight turns, on device, and put that string into `ariaSummary()`, the handoff, the return-to-Aria line, and the guest prompt. Phase 0 does this without a model call. Asking Gemini to summarize would spend the daily cap on bookkeeping.
5. "Where were we" reads the stored topic and does not replace it.
6. Prompt the menu model as Aria when no coach is active. Phase 0 does this in `engine.chat()`.

That gets a coherent Aria with personality and a topic she can pick back up. It does not make her duplex, and it does not make five minutes feel unscripted unless the learner has already saved a Gemini key. With no key, she stays on `methodReply` and the scripted engine. The daily cap is 50 text turns and 40 Gemini spoken lines.

### Where the model calls go, and where the keys live

Text: `createLLMProvider.generate()` in `engine.js` POSTs to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. The model defaults to `gemini-3.5-flash-lite` (`brimmesa.gemini.model`). The key is `localStorage['brimmesa.gemini.key']`. It is not in the repo. `guestTurn()` and `detectIntent()` call the same helper. Usage is `brimmesa.gemini.usage`, capped at 50 turns a day.

Speech: ElevenLabs key `brimmesa.eleven.key`, then the same Gemini key for `gemini-3.8-flash-lite-tts`, then the browser. No Brimmesa server sees the key or the audio. The microphone is not recorded.

### Voice options

Latency is the gap from the end of the learner's phrase to the start of a reply, on a normal phone, described rather than measured. This run did not time a device.

| Path | Latency | Quality | Controllability | Setup | Recurring | Per minute | GitHub Pages, no server |
| --- | --- | --- | --- | --- | --- | --- | --- |
| What the app uses now | End of utterance, then a text call, then TTS. Often one to three seconds when a key is saved. Scripted replies are faster and flatter. | Capped by the browser recognizer and, with no key, by the script. ElevenLabs Flash is the best voice already wired. | High. Personas, the method, the state machine, and the daily cap are ours. | $0. A key is pasted on the phone if the learner wants a model. | $0 to Brimmesa. | $0 with no key. Gemini 3.5 Flash-Lite paid standard is $0.30 / 1M input tokens and $2.50 / 1M output tokens, with a free tier ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)). ElevenLabs Flash / Turbo list price is $0.04 per 1,000 characters ([ElevenLabs API pricing](https://elevenlabs.io/pricing/api)); the app requests `eleven_flash_v2_5`. Their page treats about 1,000 characters as a minute of the more expensive multilingual voice, so Flash is about $0.04 of speech per minute, and silence is free. A 7 May 2026 ElevenLabs post, updated 19 Oct 2026, gives a Creator-plan Flash example of $0.05 per 1,000 tokens, down from $0.11 ([blog](https://elevenlabs.io/blog/weve-lowered-api-agents-pricing-and-introduced-pay-as-you-go)). The bill follows the plan on the key. Google's pricing page did not list `gemini-3.8-flash-lite-tts`. LiveKit's table lists "Google Gemini 3.8 Flash-Lite TTS" at $0.0096/min ([LiveKit pricing](https://livekit.com/pricing)). That figure is LiveKit's, not Google's. | Yes. |
| Browser Web Speech STT and TTS only | Device-dependent. Recognition ends after a pause. TTS starts when the utterance is queued. No network hop if the recognizer is on-device. Chrome on Android often still uses a network recognizer. | Uneven. Voices are the phone's. No word timings. Android has dropped results and ignored `cancel()` in the field; this repo has not remeasured that. | Low. No persona voice. The script still controls the words. | $0 | $0 | $0. The browser vendor pays for its own recognizer. | Yes. |
| Modular STT, then LLM, then TTS | Sum of three hops. Commonly one to three seconds. Not duplex. | Better if STT is a paid model. The words stay ours, so coaching can still interrupt the script. | High, same as today. | $0 of Brimmesa infrastructure if the phone calls the vendor with a user key, which is the pattern already used. A Brimmesa-held key needs a server. | $0 to Brimmesa. The learner's API account is the bill. | One published STT marker: OpenAI `gpt-realtime-whisper` at $0.017 per minute ([OpenAI pricing](https://openai.com/api/pricing/)). LLM as the Gemini row above. TTS as the ElevenLabs or Gemini row above. A 5-minute talk with the coach speaking about half the time is on the order of a few cents on these list prices, plus the text tokens. | Yes, only with a user-supplied key in localStorage. No, if the key would have to live in the repo or on a Brimmesa server. |
| OpenAI Realtime | Duplex. The published design target is a spoken reply without a full STT-then-LLM-then-TTS round trip. Later turns resend the conversation, so a long session gets slower and more expensive, not just longer ([Realtime cost guide](https://developers.openai.com/api/docs/guides/voice-latency-cost)). | Best speech-to-speech of the options here. Less of our sentence-level script. | Medium. Session instructions and tools. Harder to force "score this, then give one improved example, then wait." | An OpenAI account with billing. No monthly minimum is printed on the token table. The safe integration mints a short-lived token on a server. Putting the long-lived key in the page is the same shape as today's Gemini key, and OpenAI's own client path expects the secret to stay off the page. | $0 until audio moves. | `gpt-realtime-2.1` audio is $32 / 1M input tokens and $64 / 1M output tokens ([pricing](https://developers.openai.com/api/docs/pricing), [model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)). Their cost guide counts user audio at 1 token per 100ms (600 tokens a minute → $0.0192) and assistant audio at 1 token per 50ms (1,200 tokens a minute → $0.0768). A minute of each side is about $0.096 before text tokens and before the conversation is resent. `gpt-realtime-2.1-mini` audio is $10 / $20 per 1M, about $0.006 and $0.024 for those same full minutes. `gpt-live-1` is $0.05 per minute of session time, including silence, plus the backend model ([pricing](https://developers.openai.com/api/docs/pricing)). A 5-minute `gpt-live-1` session is about $0.25 before the brain. | No, if the key stays off the page. The browser can open the socket. Nothing in this repo can mint the token. |
| LiveKit Agents | Low, and it depends which STT, LLM, and TTS the worker calls. Barge-in and turn detection are the product. | Depends on the models plugged in. LiveKit is the room and the worker, not the voice. | High if we own the agent code. That code is a process, not a file on Pages. | Build plan is $0/mo, no card required, and it is still a LiveKit Cloud project: 1,000 agent-session minutes, $2.50 of inference credit (their page calls that about 50 minutes), 5 concurrent sessions, 1 deployment ([LiveKit pricing](https://livekit.com/pricing)). Ship starts at $50/mo (5,000 agent minutes, then $0.01/min, $5 inference credit). Scale starts at $500/mo. Self-hosting the open-source server is $0 in license and needs a machine. | The plan above. Agent time past the allowance is $0.01 per minute, metered per second with a 10-second minimum ([billing](https://docs.livekit.io/deploy/admin/billing/)). | Their calculator example totals $0.0479/min: agent $0.01, a cheap LLM $0.0014, STT $0.0075, TTS $0.009, observability $0.01 ([pricing](https://livekit.com/pricing)). Gemini 3.5 Flash-Lite on that table is $0.0013/min. Those are LiveKit Inference prices, not a second copy of Google's token table. | No. An agent worker has to run somewhere. Pages can only load the page that joins a room. |

### Recommendation

Stay on the current stack. Cost to Brimmesa is $0. A learner who already pasted a Gemini key gets unscripted lines inside the daily cap, with the rolling summary from phase 0. A learner with no key gets the script, which will not feel like a five-minute conversation. Do not add Realtime or LiveKit in this change.

**Forge.** The strongest argument against staying here is that tap-to-interrupt and end-of-utterance recognition cannot hold a natural five-minute talk. People talk over each other. Android will keep dropping the mic. A walkie-talkie with a better memory is still a walkie-talkie.

**Alternative.** `gpt-realtime-2.1-mini` behind a token server, after a spend decision. Use it for Aria's free talk only, and keep the scripted coaching machine as the source of the lesson steps so a duplex model cannot skip the score.

## (d) Minimum for an adaptive Amara

Amara needs a coaching object that is not `guestTurn()`'s one reply.

States, in order: explain, demo, scenario, learner response, adapt or push back, evaluate, feedback, improved example, retry, record, next.

Phase 0 puts that machine in `gym.js` `amaraBeat()`. It runs only when her mode is Coaching. The opening line is still `methodLine()`, so she still starts from the morning-walk example and still does not open by demanding a first claim. Evaluate, feedback, and the improved example are spoken in one turn. A voice coach should not make the learner tap through three silent states. Pushback happens once when the rubric is under 55 or the line has no reason. Record writes a lesson onto the profile. Next waits for another reply.

Per-coach state is `brimmesa.coachstate.v1`, an object keyed by coach id. Updating Amara does not write Marcus's quiz, his `brimmesa.learner.marcus` assessment, or Jasmine's step.

Modes, stored on that same per-coach object, chosen from the talk face:

- Conversation. Today's `guestTurn`.
- Coaching. The machine, Amara only. Other coaches keep Conversation behavior if this mode is selected for them, except Marcus.
- Challenge. Amara pushes back without recording a lesson. Marcus, once his assessment is done, waits for the learner to say "challenge" or "quiz" and does not start the CIA set on his own.
- Free Talk. The existing reply, with the prompt told not to assign the next step. `teachStep` stays `invite`.

**Forge.** The strongest argument against a scripted machine is that it is a second script. A learner who wanted an adaptive coach will hear the same demo shape every time, and collapsing evaluate, feedback, and the example hides the steps in one paragraph.

**Alternative.** Keep the steps as data, and let a saved Gemini key phrase only the feedback sentence. The step transition stays in `amaraBeat()`, so the model cannot skip the score. That spends the user's free tier. It is not in phase 0.

## (e) Learner profile

Key: `brimmesa.learner.profile.v1`. It is not `brimmesa.profile.v1` (engine XP, streak, history) and not `brimmesa.learner.marcus`.

Fields: `lessons`, `skills`, `strengths`, `weaknesses`, `xp`, `streak`, `objectives`, `preferredStyle`, plus `topic`, `summary`, and `recent` for Aria. Style is direct, warm, or brief. XP and streak on the profile are a copy taken when the learner saves or when Amara records a step. They are not a second wallet.

Review is the Progress tab. Edit is the form (style, one objective, one strength, one thing to work on). Delete is two taps: "Delete learner profile", then "Confirm delete". It removes only that key. "Clear coaching steps" removes only `brimmesa.coachstate.v1`, also in two taps. Coach libraries, Marcus's assessment, and Clear history are untouched.

**Forge.** The strongest argument against a second profile is drift. The engine already stores XP, streak, and mastery. A copy will lie after Clear history, or the other way around.

**Alternative.** One profile. Fold objectives and style into `brimmesa.profile.v1` and teach Clear history to remove them. That risks the tests that snapshot the engine profile, which is why phase 0 uses a separate key.

## (f) Plan

### Phase 0 — this change. $0. No new dependency.

Isolated coach state, the profile with delete, Amara's machine, the mode selector, Aria's rolling summary, and Aria's menu persona. Depends on the current `library.methodLine` and `rubric`. Reversible by deleting `gym.js` and the localStorage keys.

### Phase 1 — Aria for five minutes. $0, or the learner's existing Gemini free tier.

Hands-free and tap-to-interrupt are already shipped. Phase 0 is the memory. Acceptance A still needs a person and a microphone. No new vendor.

**Forge.** A local summary is a compressed last turn, not a memory of a real conversation. After eight lines the earlier reason is gone.

**Alternative.** A saved key writes one summary sentence every few turns, capped so it cannot eat the 50-turn budget. Not in phase 0.

### Phase 2 — Amara pushes back. $0 for the script. A key only if phase 1's alternative is reused for the feedback sentence.

Phase 0 is the scripted half of acceptance B.

**Forge.** One pushback is easy to game. A learner can add the word "because" and pass.

**Alternative.** Require a reason that is not a copy of the morning-walk line, using the rubric keywords plus a check that the content words are theirs. Still $0.

### Phase 3 — Marcus teaches one Security+ idea out loud. $0.

He already assesses, quizzes, and runs the CIA challenge. The missing piece is a verbal check: he asks, they answer, `rubric()` scores, he says the gap, they retry. Do not add a second Security+ model. Depends on phase 0 only for the mode flag. His assessment key stays.

**Forge.** Another Marcus path will compete with the first-meet probes and the quiz, which is how the shared-state bug happened last time.

**Alternative.** Do not add a path. Make "teach the CIA triad" call the existing challenge, and speak the probe he already has.

### Phase 4 — Aria hands Amara the topic. $0.

Phase 0 puts the summary on `hostSession.ariaSummary` and on the return line. Acceptance D can be checked without a microphone: the stored summary contains the topic, and Amara's prompt already includes `Aria context:`.

**Forge.** The summary is whatever the learner said last, including "ok". A handoff can carry a useless topic.

**Alternative.** Only replace the topic when the line has at least six words. Short backchannels stay off the topic.

### Phase 5 — Android, then call the voice decision done.

No code in this phase until a phone has run acceptance E. If the mic cannot be recovered, the recommendation in (c) is wrong and the Realtime alternative goes back to Tony for a spend decision.

**Forge.** Waiting on a device blocks the gym on a test this environment cannot run.

**Alternative.** Ship a visible "mic failed, type instead" state, which already exists for `not-allowed`, and treat Android as a known limit rather than a gate.

### Acceptance tests

- **A.** Aria holds a five-minute unscripted voice conversation that still knows the topic from the first minute. Needs a saved Gemini key and a person. Phase 0 supplies the memory and the persona. It does not supply the five minutes.
- **B.** Amara teaches, pushes back, and gives feedback. Phase 0: Coaching mode, a weak line ("ok") produces a pushback, a line with a reason produces Evaluate / Feedback / Improved example. Checked in `node test.js` and in the headless audit.
- **C.** Marcus teaches one Security+ concept with a verbal check. Not in phase 0. His existing quiz and CIA challenge remain the way to practice. Phase 3.
- **D.** Aria hands off to Amara with the topic kept. Phase 0 stores the summary and copies it into `ariaSummary()` at handoff. The unit test checks the summary string. A full walk-and-speak check is acceptance D on a device.
- **E.** Mobile mic permission, interruption, latency, and recovery. Untested. Android section below.
- **F.** A lesson's progress persists. Phase 0 writes `amara-live` and a recorded lesson into the profile key. Delete removes the profile and leaves Marcus's assessment. Checked in `node test.js` and the headless audit.

### What only a real Android device can tell us

- The permission prompt, a denial, and whether the "allow the microphone" note is enough to recover.
- Whether `speechSynthesis.cancel()` actually stops the coach, or the utterance keeps playing under the next line.
- Whether `onend` fires after an empty result, and whether the six-miss restart loops or dies.
- The real gap from end of speech to first audio. Headless stubs call `onend` immediately.
- Overlap of the talk face, the mode selector, the dock, and the gesture bar, including a notch. The headless boxes at 390 and 360 do not include a system gesture region.
- Lip-sync against a real ElevenLabs or Gemini buffer, and against browser speech, which has no buffer.
- Whether hands-free (`#auto`) reopens the mic after each reply without the learner tapping, for five minutes, with the screen dimming.

## What needs a spend approval

Not in this change, and not free of infrastructure:

- OpenAI Realtime (`gpt-realtime-2.1` or mini, or `gpt-live-1` at $0.05 per session minute plus the backend). Needs a token server or a key in the page, and a billed OpenAI account. See (c) for the token math and the links.
- LiveKit Cloud, including the $0 Build plan, because it is a new hosted worker. Ship is $50 a month. The example stack on their pricing page is about $0.05 a minute once the included minutes and inference credit are gone.
- Any hosted STT or TTS beyond the keys the learner already pastes in Settings.

Phase 0 does not call those services and does not add a key.
