# Avatars

Free, in-browser, real-time characters are stylized 3D. They are not photoreal. Photoreal talking video is a paid stream, billed per minute. This page uses the free path only. No API keys.

## What this site runs

Coach Amara is a full-body CC0 GLB (MakeHuman / MPFB) drawn by [TalkingHead 1.7](https://github.com/met4citizen/TalkingHead) (MIT, Mika Suominen) and three.js r180, both from a CDN. The rig uses the same bone names TalkingHead expects (`Hips`, `LeftArm`, …), 52 ARKit blendshapes, and Oculus visemes (`viseme_PP` through `viseme_U`). Silence is the rest pose (`viseme_sil` is not a shape on this file). The mesh is a young light-skinned woman in a casual suit, with a ponytail. It does not match the painted portrait. That portrait stays underneath as the fallback.

License for `avatar/models/amara.glb`: [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Upstream file and statement: [mpfb.glb](https://github.com/met4citizen/TalkingHead/blob/main/avatars/mpfb.glb), noted in the [TalkingHead readme](https://github.com/met4citizen/TalkingHead/blob/main/README.md). The copy here is Draco-compressed with WebP textures (about 6 MB) and is lazy-loaded. Morph normals were removed. It may be redistributed.

Speech tries ElevenLabs first, then Gemini TTS, then `speechSynthesis`. ElevenLabs character timings drive the mouth. Gemini audio uses word timings. The browser voice stays text-timed, because `speechSynthesis` does not hand back audio. Blinks, saccades, breathing, and small head motion come from TalkingHead. The Draco decoder is the three.js r180 build in `avatar/draco/`. The Google hosted decoder crashed on Android (`_free is not a function`), which left the still portrait up. Reaching 100% only means the GLB bytes arrived. Draco decode, the skeleton, and morph setup run after that. If that step hangs or throws, the label leaves "Loading 3D Amara… 100%" and shows the error, including the last step. A successful load adds `is-3d` and hides the portrait before the first kick. Hand and nod gestures are randomized from each character's profile in `data/characters.json` (`gestureRate`, `expressiveness`, `mannerisms`, `voice`).

## Character API

`avatar/character.js` is the shared surface. `app.js` reaches it through `setAvatarState`.

- `load(model)` loads a GLB URL. Only Amara has one today.
- `speak(text | { audio, words, audible }, { emotion, rate })` plays the mouth. When `audible` is true the buffer is heard and the visemes follow its words. A text-only call keeps the mixer silent so the browser voice is the only sound.
- `setState('idle' | 'listening' | 'speaking' | 'thinking')`
- `interrupt()` stops the mouth. A mic tap does this and then sets listening.
- `react('laugh' | 'concern' | 'smile' | 'surprise')` on laughter and a few emotion words in what the user said.
- `lookAt('camera' | 'ahead' | 'user' | { x, y })`

Full-body later: `slots.rig` is `mixamo-talkinghead`, `slots.cameraView` is `upper` (also accepts `full`, `mid`, `head`), `slots.environment` is empty, and `slots.clips` (`idle`, `listen`, `speak`, `think`) are empty URLs. TalkingHead can `playAnimation` a Mixamo FBX into those slots. No Mixamo files are shipped. Mixamo's own terms allow embedding clips inside a finished product and do not allow redistributing the raw FBX or character files as standalone assets ([Adobe Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)).

3D stays on unless Settings chooses the still portrait, or WebGL itself fails. The page paints the portrait first and imports the module on the next frame. A slow phone is not treated as too small to try.

## Other free rigs

| Option | Fit | Terms |
| --- | --- | --- |
| [Ready Player Me](https://readyplayer.me/) | GLB + ARKit + visemes used to work | Public creator, PlayerZero, and APIs stopped on 31 Jan 2026 after the Netflix deal. Old exported GLBs can still be loaded. `models.readyplayer.me` URLs are dead. [Avatar SDK's shutdown note](https://avatarsdk.com/blog/2026/01/15/switch-from-ready-player-me-to-avatar-sdk-fast-familiar-production-ready/). TalkingHead's `brunette.glb` is RPM and [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), so it is not shipped here. |
| Avaturn / Avatar SDK sample heads | TalkingHead-style GLB | Samples checked for this project are non-commercial. Not used. |
| [VRoid Studio](https://vroid.com/en/studio) + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) (MIT) | Anime VRM, not this ARKit pipeline | VRoid's license is permissive and not CC0. A VRM needs a Blender convert to TalkingHead's rig ([their VRoid notes](https://github.com/met4citizen/TalkingHead/blob/main/blender/VRoid/VROID.md)). |
| [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) | MIT, ARKit + Oculus | Must be re-rigged (Mixamo or the [rename script](https://github.com/met4citizen/TalkingHead/blob/main/blender/rename-rocketbox-shapekeys.py)) before TalkingHead will drive it. |
| MPFB | Used for Amara | [CC0](https://creativecommons.org/publicdomain/zero/1.0/), [MPFB](https://static.makehumancommunity.org/mpfb.html). |

## Lip sync without a paid voice

[HeadAudio](https://github.com/met4citizen/HeadAudio) (MIT) turns real audio into Oculus visemes. It cannot hear `speechSynthesis`. [wawa-lipsync](https://github.com/wass08/wawa-lipsync) is the same class of tool: audio or text in, visemes out. This app already has the text, so it uses TalkingHead's English rules instead of adding another library. A future local TTS that returns a buffer can call `speak({ audio, words })` and drop the estimate.

## Paid photoreal video

These are not integrated. Prices checked 15 Oct 2026. They stream a rendered face. They do not run inside the page's WebGL scene.

- [HeyGen LiveAvatar](https://www.liveavatar.com/) ([credit docs](https://docs.liveavatar.com/docs/faq/credits)): Free $0 for 10 credits/month, 1 session, 2 minutes, watermark. Essential $99/month for 1,100 credits. Business $475/month for 6,000 credits. Full mode is 2 credits/minute (about $0.19 then $0.18 on those plans). Avatar-only / Lite is 1 credit/minute (about $0.095 then $0.09). Enterprise is quoted down to $0.01/minute. Overage about $0.095 or $0.09 per credit.
- [Tavus conversational video](https://www.tavus.io/pricing): Free includes 20 minutes. Starter $22/month (60 minutes, no overage). Builder $59, Growth $397, Business $975. Extra minutes on the paid overage plans are listed at $0.35, $0.31, and $0.26. Conversations have a 30-second minimum.
- [D-ID Agents](https://www.d-id.com/pricing/): the public comparison pages in Oct 2026 put self-serve streaming around $0.35–$0.56/minute (Build about $18 for up to ~32 minutes; commercial plans higher, on the order of $50–$198 for ~90–400 minutes). Confirm on their pricing page before buying. The vendor page is plan-gated.
- [Simli](https://www.simli.com/): a face renderer. You bring STT, the model, and TTS. Simli does not publish a simple per-minute rate without an account. Secondary writeups (Oct 2026) mention about $10 of credit and ~50 minutes/month, or a few cents a minute. Treat that as second-hand, not a quote from Simli.
- Same comparison set also lists Anam around $0.11–$0.16/minute and Azure TTS Avatar around $0.50–$0.80/minute plus the voice. Sources: [talking-avatar.dev pricing compare](https://talking-avatar.dev/compare/avatar-api-pricing), [realtimeavatar.ai Oct 2026 compare](https://realtimeavatar.ai/blog/realtime-ai-avatar-apis-compared-2026).

## What the free route cannot do

It will not look like a filmed person. It will not match a photo of a specific face without a new rig. It will not lip-sync from the microphone waveform while the coach uses `speechSynthesis`. It will not drive a second or third body until those GLBs exist under a license this public site can keep. Cloth, hair physics, and a virtual room are slots, not shipped scenes.
