// What a link to the site looks like when it is posted in Discord.
//
// Discord builds a link's preview from the page's head. Open Graph tags
// give it a title, a line and a picture; a `discord:component-embed`
// payload gives it a laid-out card instead — text, a picture and link
// buttons, drawn with the same components a bot message uses, with no
// bot involved and nothing for anyone to click but the links. Discord
// does not run scripts, and the site is static, so the payload cannot
// be written into the page on the day: each main page carries a
//
//   <link rel="discord:component-embed" href="…/api/embed/<page>">
//
// and this builds the card when Discord asks. The link may point at a
// subdomain of the page's own host, which files.scs.andyrew.space is.
// Built here rather than written into each page, because the picture
// is the slideshow's first and the third button follows the sign-up
// guard, and neither is known to a static file.
//
// The Open Graph tags stay in the pages, saying the same title and
// line: they are what Discord falls back to when the card cannot be
// drawn, and what every other app that previews a link reads. Each
// page's two strings and the PAGES entry here have to agree, and
// tests/verify-embed.mjs checks that they do.
//
// Discord's rules, as its link preview documentation states them: one
// Container at the top, at most 40 components and 3,000 bytes, buttons
// link-style only (`style: 5`) with no keys beyond id, type, url, style,
// label, emoji and disabled — any other key throws the whole card away
// — and a picture's URL ending in its extension. The whole fetch,
// pictures included, has ten seconds.

import { cleanText, fileNameFor } from './shared.ts';
import { guardClosed } from './rego.ts';
import { firstShown } from './slides.ts';
import type { Env, HomeSlideRow } from './types.ts';

type SlideFile = Pick<HomeSlideRow, 'key' | 'name' | 'type' | 'alt'>;

var SITE_URL = 'https://scs.andyrew.space';
var ACCENT = 0x00933c;   // the site's accent green, --accent-solid
var NAME = 'SCS.2 Legends of the City';
var WHEN = 'Tuesday 20 October 2026 · 09:15 to 18:00 · UNSW Kensington';
var LOGO = SITE_URL + '/assets/icons/icon-512.png';

// The page's name and the line under it. The lines are the 404 page's
// "Where to go" list, so a page is described the same way wherever the
// site describes it.
export var PAGES: Record<string, { path: string; title: string; line: string }> = {
  home: { path: '/', title: 'One Day to Become a Legend of the City.',
    line: 'A free, student-run scavenger hunt, challenge filled race all across Sydney, with free food and a $700 prize pool, organised by UNSW societies.' },
  info: { path: '/info/', title: 'Event Info', line: 'Times, place, rules and what to bring.' },
  questlist: { path: '/questlist/', title: 'Quest List', line: 'Every quest, its points and where it is.' },
  tab: { path: '/tab/', title: 'Live Tab', line: 'Scores as they come in.' },
  submit: { path: '/submit/', title: 'Submit a Quest', line: 'Send proof from your phone.' },
  welfare: { path: '/welfare/', title: 'Welfare & Safety', line: 'Who to call, and where to get help.' },
  rego: { path: '/rego/', title: 'Register',
    line: 'Teams of three to five. One person signs up the whole team.' },
  messages: { path: '/messages/', title: 'Messages', line: 'Announcements from OrgCom.' },
  gallery: { path: '/gallery/', title: 'Gallery', line: 'Photos and videos from the day, for teams.' }
};

// The first picture the home page plays, or null. A database made
// before the slideshow existed reads as no pictures.
function firstSlide(db: D1Database): Promise<SlideFile | null> {
  return firstShown<'key' | 'name' | 'type' | 'alt'>(db, 'key, name, type, alt');
}

// The slide at a path that ends in its name, since Discord decides a
// link is a picture from its shape (slides.ts serves this path).
export function slideLink(api: string, slide: SlideFile): string {
  return api + '/api/slides/file/' + slide.key.split('/').map(encodeURIComponent).join('/') +
    '/' + encodeURIComponent(fileNameFor(slide.name || 'photo', slide.type));
}

function button(label: string, path: string): object {
  return { type: 2, style: 5, label: label, url: SITE_URL + path };
}

export async function embedPayload(env: Env, page: string): Promise<{ component: object } | null> {
  var spec = PAGES[page];
  if (!spec) return null;
  var api = String(env.PUBLIC_API || 'https://files.scs.andyrew.space').replace(/\/+$/, '');
  var slide = await firstSlide(env.DB);
  // Sign up while the form takes sign-ups; once the guard has shut it,
  // a button to a closed form is a button to nothing, and the quest
  // list is what people come for after that.
  var open = !(await guardClosed(env.DB));

  // the event's name small over the page's, since a card for the
  // welfare page says nothing about whose page it is otherwise
  var head = { type: 10, content: '-# ' + NAME + '\n## ' + spec.title + '\n' + spec.line };
  var parts: object[] = [];
  if (slide) {
    parts.push(head);
    parts.push({ type: 12, items: [{
      media: { url: slideLink(api, slide) },
      description: cleanText(slide.alt, 200)
    }] });
  } else {
    // no pictures uploaded: the mark beside the words instead of a gap
    parts.push({ type: 9, components: [head], accessory: {
      type: 11, media: { url: LOGO }, description: 'SCS.2'
    } });
  }
  parts.push({ type: 10, content: '-# ' + WHEN });
  parts.push({ type: 1, components: [
    button('Home', '/'),
    button('Event Info', '/info/'),
    open ? button('Sign Up', '/rego/') : button('Quest List', '/questlist/')
  ] });
  return { component: { type: 17, accent_color: ACCENT, components: parts } };
}

// GET /api/embed/<page> (a trailing .json is allowed). Five minutes:
// Discord keeps a preview with the message it was posted in, so this is
// asked once per share, and a new first picture or a closed form shows
// on the next one.
export async function handleEmbedApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  var m = url.pathname.match(/^\/api\/embed\/([a-z]+)(?:\.json)?$/);
  if (!m) return null;
  var payload = await embedPayload(env, m[1]);
  var headers: Record<string, string> = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300'
  };
  if (!payload) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: headers });
  return new Response(JSON.stringify(payload), { headers: headers });
}
