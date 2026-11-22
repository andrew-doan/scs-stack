# The phone worker

Twilio's webhook for the payphone quest. The quest itself, its tables,
the phone tree and the messages are the tab's and are written up in
`tab/CLAUDE.md` (**The payphone quest**); `README.md` here is the setup.

- **It keeps nothing and decides nothing.** `src/index.js` checks the
  signature, posts the step to the tab (`TAB_API/api/phone/step`,
  Bearer `PHONE_SYNC_KEY`) and writes the tab's actions as TwiML
  (`render` in `src/say.js`). The only words it owns are the line said
  when the tab cannot be reached.
- **Every request is checked first** (`src/signature.js`): Twilio's
  `X-Twilio-Signature` is the base64 HMAC-SHA1, keyed by the account's
  auth token, of the full address and then each form field's name and
  value in name order. The address includes the query, which is where a
  step's name and the call's state travel, so neither can be changed on
  the way back. Without `TWILIO_AUTH_TOKEN` and `PHONE_SYNC_KEY` set,
  everything is a 403.
- **State is the tab's and rides Twilio's addresses.** An action that
  waits for keys or a recording carries `to: {node, state}`; `render`
  puts both in the `action` address, and Twilio posts them back signed.
- **A recording** is announced by Twilio at `recordingStatusCallback`
  once its file exists, not at the `<Record>` action (where the file
  may not be ready). `recorded` fetches `RecordingUrl + '.mp3'` with
  Basic auth (the `AccountSid` from the request and the auth token),
  only from `api.twilio.com`, posts the bytes to
  `TAB_API/api/phone/message`, and then deletes the recording at
  Twilio. A failure answers 500 so Twilio tries again.
- **No database, so none of the copied deploy scripts**: `npm run
  deploy` is `wrangler deploy`. Give it a hostname in the Cloudflare
  dashboard, and point the Twilio number's voice webhook at
  `https://<hostname>/voice`.
- **None of the Twilio behaviour has been checked against a live
  number**: the signature scheme, `<Gather>`, `<Record>`, the recording
  callback's fields and the delete are from Twilio's documentation as
  it stood. The first live call is the test.
- `tests/verify-phone.mjs` signs with node:crypto, not this worker's
  signer.
