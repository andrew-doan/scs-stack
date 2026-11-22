// The shapes that cross a boundary: what the worker is handed by
// Cloudflare (Env), what the database holds (one interface per table in
// schema.sql), what the dashboard's requests carry, and what the public
// API sends the site. A module reading one of these imports the type
// from here, so a column or a field changed in one place is an error at
// every reader.
//
// Nothing in this file runs: it is all types, and Node strips it.

// ---------- what Cloudflare hands the worker ----------

// wrangler.toml's bindings and [vars], and the secrets in
// secrets.example.json. A secret that has not been set is undefined, and
// one still reading PASTE… counts as unset (configured() in shared.ts).
export interface Env {
  DB: D1Database;
  SUBMIT: R2Bucket;
  // the link page's backup, read only when the database fails (src/linkpage.ts); optional
  LINK_PAGE_KV?: KVNamespace;
  EMAIL?: SendEmail;
  // [vars]
  VAPID_SUBJECT?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  PUBLIC_API?: string;
  SHORT_HOST?: string;
  R2_BUCKET?: string;
  // secrets
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  CONSOLE_PASSWORD?: string;
  TAB_SYNC_KEY?: string;
  PHONE_SYNC_KEY?: string;
  CHECKIN_KEY?: string;
  CHECKIN_API?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  PUSH_PASSWORD?: string;
  ENCODER_KEY?: string;
  SHEETS_WEBHOOK_URL?: string;
  EMAIL_API_KEY?: string;
  GUILD_ID?: string;
  ORGANISER_ROLE_ID?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // read when set, and set by nothing in wrangler.toml: the site's own
  // address and the name an authenticator app shows for the dashboard
  SITE_URL?: string;
  ENROL_ISSUER?: string;
}

// The suites hand the worker a plain object with waitUntil and nothing
// else, and some callers have no context at all.
export type Ctx = Pick<ExecutionContext, 'waitUntil'> | null | undefined;

// ---------- the dashboard ----------

// A signed-in account (sessionByToken in console.ts).
export interface ConsoleSession {
  token: string;
  name: string;
  admin: boolean;
  perms: string[];
  // the quest keys it may score; empty is every quest
  quests: string[];
}

// A JSON request body, before anything in it has been checked. Every
// field is read through cleanText, Number, Array.isArray and the like.
export type JsonBody = Record<string, unknown>;

// One row of submission_log, written by console.ts and handed to the
// modules whose actions are logged.
export type LogAction = (db: D1Database, actor: string, action: string, teamName: string,
  questCode: string, delta: number, oldTotal: number | null, newTotal: number | null) => Promise<unknown>;

// What a helper answers instead of its result when the request cannot
// go ahead: the words and the status the route sends.
export interface Refusal {
  error: string;
  status: number;
}

// Drops the cached public reads after a write.
export type Purge = () => Promise<void>;

// ---------- Discord ----------
// What Discord sends the worker (an interaction) and the parts of its
// REST answers the worker reads.

export interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed?: boolean;
  color?: number;
}

export interface DiscordOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  position?: number;
  parent_id?: string | null;
  topic?: string | null;
  permission_overwrites?: DiscordOverwrite[];
}

export interface DiscordMember {
  user?: DiscordUser;
  roles?: string[];
}

export interface DiscordMessage {
  id: string;
  content: string;
  author?: DiscordUser;
}

// One option of a slash command as Discord sends it: its value, or with
// autocomplete the one being typed in.
export interface InteractionOption {
  name: string;
  type?: number;
  value?: unknown;
  focused?: boolean;
}

// A slash command, an autocomplete or a pick from a role menu, as
// Discord POSTs it (verified by its signature in index.ts).
export interface Interaction {
  type: number;
  application_id: string;
  token: string;
  guild_id?: string;
  data?: { name?: string; custom_id?: string; values?: string[]; options?: InteractionOption[] };
  member?: { user?: DiscordUser; roles?: string[] };
  user?: DiscordUser;
}

// One REST call's answer (discordApi): the parsed body when Discord said
// yes, else why not in words; `held` for a post the Discord tab's switch
// kept back.
export type DiscordResult<T> =
  | { ok: true; status: number; data: T; why: string; held?: undefined }
  | { ok: false; status: number; data: unknown; why: string; held?: boolean };

// ---------- what the public API sends the site ----------
// Built in index.ts (apiResponse, livePayload) and the modules it calls,
// cached at the edge, and read by the site's pages. A field renamed here
// is a field the site stops finding.

// GET /api/leaderboard: every visible team, best first. `rank` is the
// place among the teams that finished, null for one that did not.
export interface LeaderboardTeam {
  // the team's id, which a rename does not change: the live tab links a
  // team's page with it. A copy frozen before it was carried has none.
  id?: number;
  rank: number | null;
  dnf: boolean;
  name: string;
  points: number;
  quests_done: number;
  // the team's newest accepted submission, or null
  last_quest: { code: string; name: string; at: string } | null;
}
export interface LeaderboardPayload {
  teams: LeaderboardTeam[];
}

// GET /api/quests: the codes anyone may see, how many teams hold each,
// and how many teams hold any code of each quest. A mystery quest's
// points are null.
export interface QuestsPayload {
  total_teams: number;
  quests: { code: string; points: number | null; group: string | null; teams_done: number }[];
  groups: Record<string, number>;
}

// GET /api/stats
export interface StatsPayload {
  total_teams: number;
  total_completions: number;
  total_points: number;
  submissions_pending: number;
}

// The three standings payloads, by path: what the freeze keeps a copy
// of (src/freeze.ts) and what livePayload renders.
export interface StandingsPayloads {
  '/api/leaderboard': LeaderboardPayload;
  '/api/quests': QuestsPayload;
  '/api/stats': StatsPayload;
}
export type StandingsPayload = StandingsPayloads[keyof StandingsPayloads];

// A copy of the three as stored (tab_freeze.snapshot,
// tab_snapshots.snapshot); one that cannot be read is {}.
export type Snapshot = Partial<StandingsPayloads>;

// livePayload, handed to the modules that save copies so they never
// build a payload themselves.
export interface RenderPayload {
  (path: '/api/leaderboard'): Promise<LeaderboardPayload>;
  (path: string): Promise<StandingsPayload | null>;
}

// ---- the quest list (src/quests.ts) ----

// A quest's map pin.
export interface Pin {
  label: string;
  lat: number;
  lng: number;
}

// One question the submit form asks: a count, a line of text, places
// picked from a list, one of a few answers, or which codes were done.
export interface Question {
  kind: string;
  prompt: string;
  options: string[];
}

// The question a quest asks every team while it runs (askFromRow).
// What teams see of the answers rides the dashboard's list only.
export interface Ask {
  kind: string;
  prompt: string;
  options: unknown[];
  open: boolean;
  open_until: string;
  reveal?: string;
  reveal_live?: boolean;
}

// A file hung on a quest.
export interface QuestFileOut {
  key: string;
  name: string;
  type: string;
  bytes: number;
}

// A code of a quest as the dashboard lists it.
export interface DashCode {
  code: string;
  label: string;
  points: number;
  sort: number;
  hidden: number;
  scoring: Scoring;
  most: number | null;
  bands: Band[];
}

// A quest as the dashboard reads it (allGroups): every field, hidden
// quests and codes included, with its tags and team groups as ids.
export interface DashGroup {
  id: number;
  // tags teams search it by and see on its sheet
  keywords: string[];
  key: string;
  name: string;
  region: string;
  description: string;
  flavour: string;
  location: string;
  coords: Pin[];
  submit: string;
  prompt: string;
  options: unknown[];
  questions: Question[];
  sort: number;
  hidden: number;
  visibility: string;
  opens_at: string;
  ask: Ask;
  files: QuestFileOut[];
  codes: DashCode[];
  tags: number[];
  audiences: number[];
  mystery?: number;
  rules?: QuestRules;
}

// A code as the public list carries it: a mystery quest's points, and
// its bands' points, are null.
export interface PublicCode {
  code: string;
  label: string;
  points: number | null;
  scoring?: Scoring;
  most?: number;
  bands?: { from: number; points: number | null }[];
}

// GET /api/questlist and /api/questlist/team: a quest a reader may see,
// without who else may, its order or its id. Only an open question
// rides it, without what teams see of the answers; a mystery quest
// says so, and its challenge's points by place are null.
export interface PublicGroup {
  key: string;
  // the payphone quest, with the number teams call
  phone?: { number: string };
  keywords: string[];
  name: string;
  region: string;
  description: string;
  flavour: string;
  location: string;
  coords: Pin[];
  submit: string;
  prompt: string;
  options: unknown[];
  questions: Question[];
  ask: Omit<Ask, 'reveal' | 'reveal_live'> | null;
  files: QuestFileOut[];
  codes: PublicCode[];
  rules?: Omit<QuestRules, 'tally'> & { tally: Omit<QuestRules['tally'], 'awards'> & { awards: (number | null)[] } };
  mystery?: true;
}

export interface QuestListPayload {
  // the quests counter the list was built at
  version: number;
  regions: string[];
  groups: PublicGroup[];
  places: { stations: string[]; sushi: string[] };
  // whether a quest not hidden is kept from this reader
  more: boolean;
  region_colours: Record<string, string>;
  // the team's own list says whose it is
  team?: string;
}

// A day the site prints times on without their date (recap.ts).
export interface DateRule {
  kind: string;
  date: string;
}

// GET /api/pulse and /api/pulse/team: the version numbers the site
// polls, the reader's newest messages, the newest urgent message the
// reader can see (0 for none) and the after-the-event switches.
export interface PulsePayload {
  quests: number;
  messages: number;
  urgent: number;
  team_pages: boolean;
  recap: boolean;
  replay: boolean;
  date_rules: DateRule[];
  message_seqs?: number[];
}

// A message's attachment as the lists carry it; the dashboard's has the
// row id too.
export interface MessageFileOut {
  id?: number;
  key: string;
  name: string | null;
  type: string | null;
  bytes: number | null;
}

// GET /api/messages and /api/messages/team, in display order. `files` is
// on every message the list holds; `seq` is too, once the database has
// the column.
export interface MessagesPayload {
  messages: (Pick<MessageRow, 'id' | 'title' | 'body' | 'created_at' | 'urgency'> & Partial<Pick<MessageRow, 'seq'>> & { files?: MessageFileOut[] })[];
}

// GET /api/slides: the home page's pictures in display order, each with
// the point it is cropped around (percent across and down), and how long
// each stays up.
export interface SlidesPayload {
  ok: true;
  step_ms: number;
  slides: { key: string; name: string; alt: string; caption: string; x: number; y: number }[];
}

// A push notification as the site's service worker reads it.
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  renotify?: boolean;
}

// GET /api/countdown
export interface CountdownPayload {
  stops: { label: string; at: string }[];
  // the line the page shows once every stop has passed; '' for its own
  over: string;
}

// A submission's file as the submit page, Review and the ledger read it
// (attachMedia in src/submit.ts). `picked` is the type of the file it was
// picked as, `uploading` marks one whose slices are still coming, and a
// video carries the heights of its smaller copies, `encoding` while a
// machine has it and `skipped` once the encoder has given up on it.
export interface MediaOut {
  key: string;
  type: string;
  bytes: number;
  name: string | null;
  picked?: string;
  uploading?: number;
  renditions?: number[];
  encoding?: boolean;
  skipped?: boolean;
}

// ---------- JSON the database holds ----------

// How a code of a quest scores (quests.scoring, src/parts.ts): '' fixed,
// then per unit, judged, tiered and counted.
export type Scoring = '' | 'unit' | 'judged' | 'tiered' | 'counted';

// One band of a tiered or counted part (quests.bands, JSON).
export interface Band {
  from: number;
  points: number;
}

// What a submission put on the tab (submissions.credit, JSON): the codes
// and how many of each, `counts` where a code was counted apart from
// `amount`, `amounts` where a judged code was given part of its points,
// `numbers` the number a tiered code reached and `points` a line's worth
// set outright (an adjustment). Each map is left out when it is empty,
// and read back as null (readCredit in src/points.ts).
export interface Credit {
  codes: string[];
  amount: number;
  counts?: Record<string, number> | null;
  amounts?: Record<string, number> | null;
  numbers?: Record<string, number> | null;
  points?: Record<string, number> | null;
}

// What a quest takes and counts (quest_groups.rules, JSON, src/rules.ts),
// always read back whole. It rides the dashboard's and the public quest
// lists.
export type FileKind = 'photo' | 'video' | 'gpx' | 'pdf';
export type TallyKind = '' | 'picks' | 'sum' | 'highest' | 'submissions';
export interface QuestRules {
  files: { kinds: FileKind[]; max: number; required: boolean };
  tally: { kind: TallyKind; awards: number[]; public: boolean };
  // read from rules stored before parts had types; never written
  partial: boolean;
}

// One answer in a submission's answer (submissions.answer, JSON;
// cleanEntry in src/submit.ts): a count is a number, text and a choice a
// string, picks and codes a list. `prompt` is the question as worded
// when it was answered.
export interface AnswerEntry {
  kind: string;
  value: number | string | string[] | null;
  prompt?: string;
}
// The whole answer: the first question's at the top and the rest under
// `more`, in order, null for one left blank.
export interface Answer extends AnswerEntry {
  more?: (AnswerEntry | null)[];
}

// Who is asking: a team signed in with its submit code and the team
// groups it is in, or null for nobody signed in (src/access.ts).
export type Viewer = { team_id: number; audiences: Record<number, boolean> } | null;

// ---------- the database ----------
// One interface per table, column for column. A column that schema.sql
// does not declare NOT NULL can come back null. A query that reads some
// of the columns types its rows as a Pick of these, so a column renamed
// here is an error at every query that names it.

/** the view `held`: each team's live ledger lines on a code, added up */
export interface HeldRow {
  team_id: number;
  quest_code: string;
  amount: number;
  points: number;
  updated_at: string;
}

/** `teams` */
export interface TeamRow {
  id: number;
  name: string;
  hidden: number;
  dnf: number;
}

/** `quest_regions` */
export interface QuestRegionRow {
  id: number;
  name: string;
  sort: number;
  colour: string;
}

/** `quest_groups` */
export interface QuestGroupRow {
  id: number;
  key: string;
  name: string;
  region: string;
  description: string;
  flavour: string;
  keywords: string;
  location: string;
  coords: string;
  submit_kind: string;
  prompt: string;
  options: string;
  sort: number;
  hidden: number;
  ask_kind: string;
  ask_prompt: string;
  ask_options: string;
  ask_open: number;
  ask_open_until: string;
  ask_settled: string;
  visibility: string;
  opens_at: string;
  mystery: number;
  questions: string;
  rules: string;
  tally_settled: string;
  ask_reveal: string;
  ask_reveal_live: number;
}

/** `quest_tags` */
export interface QuestTagRow {
  id: number;
  name: string;
  dash_hidden: number;
  sort: number;
}

/** `quest_group_tags` */
export interface QuestGroupTagRow {
  group_id: number;
  tag_id: number;
}

/** `audiences` */
export interface AudienceRow {
  id: number;
  name: string;
}

/** `audience_teams` */
export interface AudienceTeamRow {
  audience_id: number;
  team_id: number;
}

/** `quest_audiences` */
export interface QuestAudienceRow {
  group_id: number;
  audience_id: number;
}

/** `quests` */
export interface QuestRow {
  code: string;
  norm: string;
  points: number;
  group_id: number | null;
  label: string;
  sort: number;
  hidden: number;
  scoring: string;
  most: number | null;
  bands: string;
}

/** `completions` */
export interface CompletionRow {
  team_id: number;
  quest_code: string;
  amount: number;
  updated_at: string;
}

/** `entries` */
export interface EntryRow {
  id: number;
  team_id: number;
  code: string;
  units: number;
  points: number;
  input: string;
  source_kind: string;
  source_id: number | null;
  note: string;
  made_by: string;
  made_at: string;
  at: string;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

/** `awards` */
export interface AwardRow {
  id: number;
  kind: string;
  group_id: number | null;
  code: string;
  token: string;
  basis: string;
  note: string;
  made_by: string;
  made_at: string;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

/** `submission_log` */
export interface SubmissionLogRow {
  id: number;
  at: string;
  action: string;
  team_name: string;
  quest_code: string;
  points_delta: number;
  old_total: number;
  new_total: number;
  actor: string | null;
}

/** `team_checkins` */
export interface TeamCheckinRow {
  team_name: string;
  completed_at: string;
  people: number;
}

/** `team_arrivals` */
export interface TeamArrivalRow {
  team_name: string;
  last_at: string;
  checked_in: number;
  people: number;
}

/** `console_sessions` */
export interface ConsoleSessionRow {
  token: string;
  name: string;
  created_at: string;
  expires_at: string;
}

/** `console_users` */
export interface ConsoleUserRow {
  name: string;
  secret: string;
  confirmed_at: string | null;
  last_step: number;
  last_seen: string | null;
  created_at: string;
  password_hash: string | null;
  admin: number;
  perms: string;
  require_2fa: number;
  created_by: string | null;
  quests: string;
}

/** `console_backup_codes` */
export interface ConsoleBackupCodeRow {
  name: string;
  code_hash: string;
  used_at: string | null;
}

/** `console_attempts` */
export interface ConsoleAttemptRow {
  id: number;
  at: string;
  name: string;
  ip: string;
  outcome: string;
  detail: string;
}

/** `team_codes` */
export interface TeamCodeRow {
  team_id: number;
  code: string;
}

/** `submit_sessions` */
export interface SubmitSessionRow {
  token: string;
  team_id: number;
  created_at: string;
  expires_at: string;
}

/** `submissions` */
export interface SubmissionRow {
  id: number;
  team_id: number;
  quest_code: string;
  note: string | null;
  status: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reason: string | null;
  gallery: number;
  answer: string | null;
  claimed_by: string;
  claimed_at: string;
  added_by: string;
  credit: string | null;
}

/** `push_subs` */
export interface PushSubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  team_id: number | null;
  label: string;
  created_at: string;
}

/** `registrations` */
export interface RegistrationRow {
  id: number;
  team_id: number | null;
  team_name: string;
  societies: string | null;
  photo_permission: number;
  questions: string | null;
  ip_hash: string | null;
  submitted_at: string;
  hidden: number;
}

/** `participants` */
export interface ParticipantRow {
  id: number;
  registration_id: number;
  team_id: number | null;
  position: number;
  name: string;
  zid: string;
  email: string | null;
  arc: number;
  dietary: string | null;
  discord: string | null;
  qr_url: string | null;
  email_status: string | null;
  email_tries: number;
  terms_key: string | null;
  terms_at: string | null;
  photo_ok: number | null;
}

/** `discord_guilds` */
export interface DiscordGuildRow {
  guild_id: string;
  name: string;
  organiser_role_id: string;
  category_name: string;
  category_id: string | null;
  enabled: number;
  announce_channel_id: string | null;
  added_at: string;
  legend_role_id: string;
  unknown_role_id: string;
  staff_role_ids: string;
  accept_posts: number;
  no_team_role_id: string;
  held: number;
}

/** `discord_teams` */
export interface DiscordTeamRow {
  guild_id: string;
  team_id: number;
  role_id: string | null;
  channel_id: string | null;
  role_name: string;
  channel_name: string;
  updated_at: string;
}

/** `discord_role_menus` */
export interface DiscordRoleMenuRow {
  id: number;
  guild_id: string;
  title: string;
  body: string;
  pick: string;
  options: string;
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string | null;
}

/** `discord_members` */
export interface DiscordMemberRow {
  guild_id: string;
  user_id: string;
  username: string;
  participant_id: number | null;
  team_id: number | null;
  verified_at: string;
}

/** `submission_files` */
export interface SubmissionFileRow {
  id: number;
  submission_id: number;
  r2_key: string;
  content_type: string;
  bytes: number;
  name: string | null;
  status: string;
  upload_id: string | null;
  part_size: number | null;
  encode_state: string;
  encode_claimed_at: string;
  taken_at: string | null;
  picked_type: string;
}

/** `submission_renditions` */
export interface SubmissionRenditionRow {
  id: number;
  file_key: string;
  height: number;
  key: string;
  bytes: number;
  created_at: string;
}

/** `encoders` */
export interface EncoderRow {
  name: string;
  last_seen: string;
  state: string;
  working_on: string;
  jobs_done: number;
  encode_ms: number;
}

/** `tab_freeze` */
export interface TabFreezeRow {
  id: number;
  frozen: number;
  frozen_at: string | null;
  snapshot: string | null;
  closed: number;
  closed_at: string | null;
}

/** `tab_snapshots` */
export interface TabSnapshotRow {
  id: number;
  taken_at: string;
  kind: string;
  taken_by: string;
  digest: string;
  summary: string;
  snapshot: string;
}

/** `submission_upload_parts` */
export interface SubmissionUploadPartRow {
  file_id: number;
  part_n: number;
  etag: string;
}

/** `site_flags` */
export interface SiteFlagRow {
  name: string;
  value: number;
}

/** `drop_files` */
export interface DropFileRow {
  id: number;
  key: string;
  name: string;
  type: string;
  bytes: number;
  note: string;
  created_at: string;
  created_by: string;
}

/** `short_links` */
export interface ShortLinkRow {
  slug: string;
  kind: string;
  target: string;
  file_key: string;
  hits: number;
  created_at: string;
  created_by: string;
}

/** `push_outbox` */
export interface PushOutboxRow {
  id: number;
  title: string;
  body: string;
  url: string;
  tag: string;
  renotify: number;
  urgency: string;
  topic: string;
  after_id: number;
  sent: number;
  failed: number;
  created_at: string;
  team_ids: string | null;
}

/** `countdown_stops` */
export interface CountdownStopRow {
  sort: number;
  label: string;
  at: string;
}

/** `site_text` */
export interface SiteTextRow {
  name: string;
  value: string;
}

/** `home_slides` */
export interface HomeSlideRow {
  id: number;
  key: string;
  name: string;
  type: string;
  bytes: number;
  alt: string;
  caption: string;
  sort: number;
  created_at: string;
  created_by: string;
  focus_x: number;
  focus_y: number;
  hidden: number;
}

/** `counters` */
export interface CounterRow {
  name: string;
  value: number;
}

/** `messages` */
export interface MessageRow {
  id: number;
  title: string;
  body: string;
  created_at: string;
  updated_at: string | null;
  hidden: number;
  sort: number;
  archived: number;
  urgency: string;
  publish_at: string;
  visibility: string;
  seq: number;
}

/** `message_audiences` */
export interface MessageAudienceRow {
  message_id: number;
  audience_id: number;
}

/** `message_files` */
export interface MessageFileRow {
  id: number;
  message_id: number;
  key: string;
  name: string | null;
  type: string | null;
  bytes: number | null;
  sort: number;
}

/** `quest_files` */
export interface QuestFileRow {
  id: number;
  group_id: number;
  key: string;
  name: string;
  type: string;
  bytes: number;
  sort: number;
}

/** `quest_responses` */
export interface QuestResponseRow {
  id: number;
  group_id: number;
  team_id: number;
  choice: string;
  amount: number;
  created_at: string;
  updated_at: string;
}

/** `email_sends` */
export interface EmailSendRow {
  id: number;
  subject: string;
  format: string;
  body: string;
  audience: string;
  team_id: number | null;
  total: number;
  sent: number;
  failed: number;
  status: string;
  created_by: string;
  created_at: string;
  finished_at: string | null;
  footer: string | null;
  reply_to: string | null;
}

/** `email_queue` */
export interface EmailQueueRow {
  id: number;
  send_id: number;
  email: string;
  status: string;
  claimed_at: string | null;
  error: string;
}

/** `eoi_people` */
export interface EoiPersonRow {
  id: number;
  email: string;
  zid: string;
}

/** `albums` */
export interface AlbumRow {
  id: number;
  slug: string;
  name: string;
  about: string;
  adding: string;
  gallery: number;
  hidden: number;
  sort: number;
  created_at: string;
  created_by: string;
  unlisted: number;
  link_key: string;
  show_hidden: number;
  details: number;
  photo_order: string;
  merges: string;
}

/** `album_photos` */
export interface AlbumPhotoRow {
  id: number;
  album_id: number;
  r2_key: string;
  content_type: string;
  bytes: number;
  name: string;
  team_id: number | null;
  added_by: string;
  ip: string;
  added_at: string;
  width: number;
  height: number;
  status: string;
  upload_id: string | null;
  part_size: number | null;
  upload_token: string;
  encode_state: string;
  encode_claimed_at: string;
  taken_at: string | null;
  picked_type: string;
  version: number;
  replaces: number;
  points_to: string;
}

/** `album_upload_parts` */
export interface AlbumUploadPartRow {
  photo_id: number;
  part_n: number;
  etag: string;
}

/** `album_skips` */
export interface AlbumSkipRow {
  album_id: number;
  r2_key: string;
}

/** `album_teams` */
export interface AlbumTeamRow {
  album_id: number;
  team_id: number;
}

/** `staged_uploads` */
export interface StagedUploadRow {
  id: number;
  r2_key: string;
  upload_id: string | null;
  purpose: string;
  name: string;
  content_type: string;
  bytes: number;
  part_size: number;
  actor: string;
  status: string;
  created_at: string;
}

