# SCS.2 phone

The phone side of the payphone quest: a Cloudflare Worker that Twilio
calls when somebody rings the event's number. It checks the request is
Twilio's, asks the tab worker what the call does next, and answers in
TwiML. It has no database; the tab keeps everything.

Nothing here has been run against a real phone line yet. Do the field
test below before relying on it.

## What you need

- A Twilio account with an Australian local number. Australian numbers
  need a regulatory bundle (identity and proof of an Australian
  address); allow a few days for review.
- The tab worker deployed with its migrations run (`npm run db:migrate`
  in `tab/`), and `PHONE_SYNC_KEY` set on it.

## Setting up

1. `cd phone && npm install`
2. Copy `secrets.example.json` to `secrets.json` and fill in:
   - `TWILIO_AUTH_TOKEN`: the account's auth token, from the Twilio
     console. Twilio signs every request with it and this worker
     refuses anything not signed.
   - `PHONE_SYNC_KEY`: a long random string. Put the same value in
     `tab/secrets.json` and run `npm run secrets` in both folders.
3. `npm run secrets`, then `npm run deploy`.
4. Give the worker a hostname (Cloudflare dashboard, the worker's
   Settings, Domains and Routes), for example `phone.scs.andyrew.space`.
5. In the Twilio console, open the number and under Voice set
   **A call comes in** to Webhook, `https://<hostname>/voice`, HTTP
   POST. The address has to be exactly the one Twilio calls: the
   signature covers it.
6. On the dashboard's Quests tab, open **Payphones**: pick the code
   each capture credits (a per-unit or counted code), type the number
   teams call, make an organiser PIN and tick **Count captures**.

## The field test

Before the day, from three payphones (a street, a station, a shopping
centre):

1. Call the number and key in the organiser PIN.
2. On the Payphones card, check the number that appears under Numbers
   that have called is the one printed on the payphone.
3. If the call log says Number withheld for a phone, that phone hides
   its number and cannot be captured by calling.

If no payphone's number arrives, the quest cannot work as a call and
should run as a photo quest instead.

## What a call does

The tab decides. Its phone tree is edited on the Payphones card and a
saved change is heard by the next call. With no tree saved, a call asks
for a team's PIN and records the payphone.

| Twilio posts | When | This worker |
|---|---|---|
| `/voice` | a call starts | asks the tab for the first step |
| `/voice/step?node=&s=` | keys or a recording come back | hands them to the tab, with the step and what the call had said so far |
| `/voice/recorded?node=&s=` | a recording's audio is ready | fetches the MP3 from Twilio, hands it to the tab, deletes it at Twilio |

A recording that cannot be handed over answers 500, so Twilio sends the
notice again and the audio stays there until it is kept.

## Tests

`npm test` signs requests the way Twilio does and stands in for the tab
and for Twilio's API. The tab's half is `tab/tests/verify-phone.mjs`,
and the dashboard card's `tab/tests/verify-phone.cjs`.
