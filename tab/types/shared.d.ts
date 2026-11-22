// Globals from scripts that both the site's pages and the dashboard load.
// Read by tsconfig.site.json and tsconfig.dash.json; nothing here is
// served.

// website/assets/video-sizes.js: which copy of a video plays
declare var scsVideo: {
  sizes(heights: any, url: (res: string) => string): any[];
  pick(list: any[]): any;
  play(video: any, list: any[], opts?: any): any;
  pref(): string;
  setPref(v: string): void;
};

// website/assets/share-image.js: a receipt or the standings as a picture
declare var SCSShareImage: {
  receipt(d: any, logo?: any): any;
  leaderboard(d: any, logo?: any): any;
  logo(src: string): Promise<any>;
  png(kind: string, data: any, logoSrc?: string): Promise<Blob>;
  copy(blob: Promise<Blob>, filename: string): Promise<string>;
  fileName(text: string): string;
};

// website/tab/replay/track-clean.js: the GPX cleaner, which the
// dashboard's Routes tab loads from the site (tracks/clean.mjs runs it
// under Node)
declare var SCSTrackClean: {
  network(geojson: any): any;
  trips(files: any[]): any[];
  readGpx(text: string): any[];
  gpxName(text: string): string;
  clean(net: any, raw: any[], opts?: any): { pts: any[]; legs: any[]; stays: any[]; notes: string[] };
  toGpx(name: string, pts: any[]): string;
  toReplay(team: string, res: any): any;
  slug(s: string): string;
  clock(t: number): string;
  dist(a: any, b: any): number;
};

// Cloudflare Turnstile, from its own script, which calls
// scsTurnstileReady once it has loaded
declare var turnstile: {
  render(container: string | HTMLElement, params: any): string;
  getResponse(widget?: string): string;
  reset(widget?: string): void;
  remove?(widget?: string): void;
};
declare var scsTurnstileReady: (() => void) | undefined;

// libraries copied in as published (eslint.config.mjs lists them)
declare var maplibregl: any;
declare var HeicTo: any;
