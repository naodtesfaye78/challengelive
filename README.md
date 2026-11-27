# ChallengeLive - Live Dares (Twitch Panel Extension)

Viewers send dares (paid menu dares with Bits, or free custom dares checked by AI), vote on the next dare,
fill a community Bits goal and ask questions. The streamer always decides: accept, decline, skip, complete.

## Try it on your computer with a fake Twitch (no Twitch needed)
    npm run dev          # then open http://localhost:3000/dev/
    npm test             # 22 automated checks
    python3 tests/ui_test.py   # real-browser click-through (needs Playwright)

## Folders
- backend/    the server (no packages to install)
- extension/  the screens Twitch shows (viewer.html, live_config.html, config.html)
- dev/        the fake Twitch used for testing only
- tests/      automated tests

## Real deployment
1. Put this folder in a GitHub repo, create a Railway project from it.
2. Set the variables listed in `.env.example`.
3. Open `https://YOUR-URL/extension.zip` - that file is what you upload to Twitch Hosted Test (it already points at your server).

## What is verified vs assumed
- Verified in Twitch docs: signed-token login (HS256, base64 secret), Bits only for Extension-defined products, banned Bits wording, no free-form-text Bits, voting with Bits allowed.
- Our decision: fixed paid menu; free custom dares; goal dare is one the streamer picks from the same fixed menu; "test mode" is off by default.
- Assumed, confirm in your first real Bits test: the exact layout of the Bits receipt (`data.transactionId`, `data.userId`, `data.product.sku`, `data.product.cost.amount`).
- Updates reach screens by checking the server every 3-6 seconds (not instant Twitch push).
