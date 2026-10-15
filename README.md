# BRIMMESA AI prototype
Run: `python3 -m http.server 8792 --bind 127.0.0.1` in this folder, then open http://127.0.0.1:8792 in Chrome or Edge (needed for speech recognition). Click **Start session**.
Say "call me <name>", then pick "social", "communication", or "security plus". Other spoken commands: "change subject", "my progress", "I'm driving" / "I'm parked", "repeat".
Test: `node test.js`. Content lives in `data/`. Add worlds and curricula by editing the JSON.

## How to use on your phone (Android + Chrome)
1. Open the HTTPS link you were sent in **Chrome**. It must start with `https://` or the microphone won't work.
2. Tap **▶ Start session**. That first tap turns on the sound. Turn the volume up or use headphones.
3. When Chrome asks for the **microphone**, tap **Allow**. If you blocked it by mistake, tap the lock icon by the address, then Permissions, then Microphone, then Allow.
4. Just talk. With **Hands-free** on, it listens again after each reply. Tap the big 🎤 button anytime to interrupt or to start talking.
5. Say things like "security plus", "social", "communication", "change subject", "my progress", "I'm driving", "repeat".
6. To install it like an app: Chrome menu ⋮ → **Add to Home screen**.
7. Driving: say "I'm driving" for short audio-only questions. Do the social scenarios only when parked.
Privacy: no audio is saved. Progress stays on your phone. Tap "Progress & history" → "Clear" to erase it.
