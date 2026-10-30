# Live Class (test version for Yuni)

One link is the whole classroom:

- **Teacher** opens the page, taps "I am the teacher", and gets a class link + 5-letter code.
- **Students** tap the link, write their name once, and they are in. No account, no code typing, no settings.
- Teacher taps **Share my screen** (one click, she picks the window) — students see it big.
- Teacher taps **Microphone on** — voice runs inside the page, both ways. Students have one big mic button.
- Teacher types a question in **"Say or ask"** — students see it big.
- Teacher writes on the **Class board** — everyone sees it live.
- Each student has **one big answer box**. As they type, the teacher sees every answer live, in cards with names.
- Nothing is recorded. Nothing is stored. When the class ends, the room is gone.

## Run it locally

```
npm install
npm start          # http://localhost:3000
```

## Put it on the internet (Render, free)

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Open the Render URL. That is the only link anyone needs.

## Known limits of this test version

- Voice/screen use direct browser-to-browser connections (WebRTC mesh) with a public STUN server and no TURN relay. On most home networks it works; on some strict networks a student's voice or the screen may not connect. Fine for a first class test; a TURN server is the fix if it bites.
- Best for small classes (about up to 8–10 students) in this version.
- The teacher should use Chrome or Edge on a computer for screen sharing. Students can use any modern phone browser.
