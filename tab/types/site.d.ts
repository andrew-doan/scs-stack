// The names the site's scripts share through window: window.scs (the
// helpers every page uses), window.scsSite and window.scsQuestList (the
// parts of the shared script and of the quest page, and the names the
// parts hand each other), and the smaller globals one script sets for
// another. Read by tsconfig.site.json; nothing here is served.
//
// A member is optional when it is put there after the object is made
// (by a later part, or later in the same one), so that the object
// literal that makes it is still held to the rest. Parameters are
// optional where the function is written to be called without them.

// ---- window.scs: assets/site.js and its parts ----

interface ScsPushSub {
  supported(): boolean;
  label(): string;
  state(): Promise<string>;
  enable(): Promise<any>;
  disable(): Promise<any>;
  busy(): boolean;
  unlink(): Promise<any>;
  platform(): string;
  hint(state: string): string;
  paint(el: any, text?: any): void;
}

interface ScsChartStep {
  name: string;
  rows: string;
  busiest: string;
}

interface Scs {
  TAB_API: string;
  fetch(url: string, opts?: any): Promise<Response>;
  again(key: string, fn: () => void, opts?: { timer?: boolean }): void;
  gotIt(key: string): void;
  needScript(src: string): void;
  needsConverting(file: any): boolean;
  toJpeg(file: any): Promise<any>;
  exifOf(file: any): Promise<any>;
  pickedType(file: any): string;
  fileUrl(key: string): string;
  animatedType(type: any): boolean;
  keepPicture(img: any, url: string, opts?: any): any;
  videoFrame(url: string): Promise<any>;
  thumbUrl(key: string, type?: any): string;
  normQuest(text: any): string;
  textScore(query: any, text: any): number;
  questScore(quest: any, query: any, extra: any): number;
  questSearch(quests: any[], query: any, extraOf?: (quest: any) => string): any[];
  questList(opts?: { fresh?: boolean }): Promise<any>;
  fetchQuestList(version?: number): Promise<any>;
  pulse(fresh?: boolean): Promise<any>;
  teamSession(): string;
  setTeamSession(token: string, team?: string): void;
  readAs(publicPath: string, teamPath: string): any;
  reader(): string;
  seen(key: string): any;
  markSeen(key: string, value: any): void;
  seenSet(key: string): number[] | null;
  addSeen(key: string, values: number[], cap?: number): number[];
  readMessages(seqs: number[]): void;
  syncBell(): boolean;
  pushSub: ScsPushSub;
  markdown(text: any): string;
  messageBody(container: any, text: any): void;
  rocker(className: string, text?: string | Node): { label: HTMLLabelElement; input: HTMLInputElement };
  isToday(d: Date): boolean;
  hideDates(): boolean;
  hour24(): boolean;
  fmtTime(utc: any, withYear?: boolean): string;
  fmtDay(utc: any, withYear?: boolean): string;
  fmtHour(utc: any, withMinutes?: boolean): string;
  figure(parts: any): any;
  fact(list: any, name: string, value: any): void;
  hourBars(container: any, rows: any[], opts: any): void;
  CHART_STEPS: { [step: string]: ScsChartStep };
  chartStep(box: any, storeKey: string, onPick: (step: string) => void): { step(): string };
  postJson(url: string, body: any, token?: string): Promise<{ status: number; data: any }>;
  reducedMotion: boolean;
  ms(name: string, fallback: number): number;
  mapPixelRatio(): number;
  replay(node: any, className: string): void;
  rise(node: any): void;
  shake(node: any): void;
  swapText(node: any, text: string): void;
  digits(node: any, text: any): void;
  // site-viewer.js
  pullTab?(panel: any, opts: any): any;
  lightbox?(media: any[], index: number, origin: any, opts?: any): void;
  // site-chrome.js
  closePanels?(except: any): void;
  // site-input.js
  confirmSlide?(opts: any): any;
  guardLeaving?(fn: () => any): any;
  hapticTap?(host: any): void;
}

// What one part of the shared script hands the next
// (website/assets/CLAUDE.md, the shared script is five files).
interface ScsSite {
  parts: Array<(site: ScsSite) => void>;
  // site.js
  handheld?(): boolean;
  appLayoutWanted?(): boolean;
  syncAppLayout?(): void;
  fetchRetry?(url: string, opts?: any): Promise<Response>;
  sitePath?(page: string): string;
  readAs?(publicPath: string, teamPath: string): any;
  fetchPulse?(): Promise<any>;
  afterLayout?: (() => void) | null;
  pulsePromise?: Promise<any> | null;
  lastPulse?: any;
  hiddenAt?: number;
  root?: HTMLElement;
  installed?: boolean;
  APP_LAYOUT_KEY?: string;
  DATES_KEY?: string;
  CLOCK_KEY?: string;
  phoneish?: boolean;
  TAB_API?: string;
  PULSE_STALE?: number;
  // site-chrome.js
  placeTapSwitches?(): void;
  themeBtn?: any;
  settingsBtn?: any;
  // site-input.js
  askBeforeLeaving?(why: string, url: string | (() => void)): void;
  creepOn?(at: number): any;
  hapticHost?(node: any): any;
  isHapticEcho?(e: any): boolean;
  leaveReason?(): any;
  LOAD_WAIT?: number;
  LOAD_STEP?: number;
}

declare var scs: Scs;
declare var scsSite: ScsSite;

// ---- the chrome's other globals (site-chrome.js, site-input.js) ----

interface ScsBackLayerEntry {
  close: () => void;
  open: boolean;
  noHistory?: boolean;
}
declare var scsBackLayer: {
  arm(closeFn: () => void): ScsBackLayerEntry;
  disarm(layer: ScsBackLayerEntry | null): void;
  after(fn: () => void): void;
  isTop(layer: ScsBackLayerEntry | null): boolean;
  isOpen(): boolean;
  ownPop(e: any): boolean;
};
declare var scsToast: (message: string) => void;
declare var scsHaptic: (kind?: string) => void;

// ---- the quest page: questlist/scs-2-questlist*.js ----

interface QuestListState {
  map: any;
  mapStyled: boolean;
  mapDrawn?: boolean;
  viewKept?: boolean;
  pins: any[];
  litQuest: any;
  litQuiet?: boolean;
  userPos: any;
  radiusKm: number;
  search: string;
  category: string;
  lists: any[];
  list: string;
  showUnlocated: boolean;
  anywhereOnly: boolean;
  liveOnly: boolean;
  done: any;
  hideDone: boolean;
  noChecklist: boolean;
  fullInfo: boolean;
  transit: boolean;
  lightMap: boolean;
  submitMode: boolean;
  activeQuest: any;
  pinTapAt?: number;
  pinTips?: any;
  styleLayers?: any;
  tileUrl?: string;
}

// What one part of the quest page hands the next
// (website/questlist/CLAUDE.md).
interface ScsQuestList {
  parts: Array<(ql: ScsQuestList) => void>;
  // scs-2-questlist.js
  loadQuests?(): any;
  loadDoneMap?(): any;
  loadLists?(): any[];
  saveDoneMap?(): void;
  saveHideDone?(): void;
  saveFullInfo?(): void;
  saveLists?(): void;
  listById?(id: string): any;
  inList?(list: any, quest: any): boolean;
  listCount?(list: any): number;
  isDone?(quest: any): boolean;
  isComplete?(quest: any): boolean;
  tickedCodes?(quest: any): any[];
  doneCount?(quest: any): number;
  setDone?(quest: any, value?: any): void;
  toggleCode?(quest: any, code: any): void;
  setCount?(quest: any, n: number): void;
  clearDone?(quest: any): void;
  stopFlashCodes?(): void;
  paintRoute?(sheet: any, region: any): void;
  regionLetter?(region: any): string;
  loadMapLibre?(): Promise<any>;
  haversineKm?(a: any, b: any): number;
  questDistanceKm?(quest: any): number;
  locationText?(quest: any): string;
  pointsSummary?(points: any): string;
  isLive?(quest: any): boolean;
  matchesFilters?(quest: any, skipSearch?: boolean): boolean;
  renderList?(quiet: boolean): void;
  siteColor?(token: string, fallback: string): string;
  renderMarkers?(): void;
  drawPins?(): void;
  clearQuestHighlight?(): void;
  highlightQuestMarkers?(quest: any): void;
  fetchTabStats?(): any;
  submitHref?(quest: any): string;
  normTabCode?(text: any): string;
  state?: QuestListState;
  QUESTS?: any[];
  CATEGORY_ORDER?: string[];
  MAP_STYLE_URL?: string;
  MAP_GLYPHS?: string;
  LOCAL_GLYPH_RANGES?: any;
  REMOTE_GLYPHS?: string;
  DONE_STORAGE_KEY?: string;
  TRANSIT_STORAGE_KEY?: string;
  LIGHT_MAP_STORAGE_KEY?: string;
  LISTS_STORAGE_KEY?: string;
  SAVED_LIST?: string;
  MAX_LISTS?: number;
  LIST_NAME_MAX?: number;
  TAB_API?: string;
  // scs-2-questlist-sheet.js
  bookmarkIcon?(cls: string, filled: boolean, label?: string): any;
  closeDetail?(): void;
  glideSheetHeight?(mutate: () => void): void;
  isSheet?(): boolean;
  openDetail?(quest: any, panMap: boolean, fromCard?: any, opts?: any): void;
  openQuestPanel?(quest: any, panMap: boolean, opts?: any): void;
  renderDetailCodes?(quest: any): void;
  renderDetailLists?(): void;
  sheetStop?(): any;
  srHeights?(): any;
  updateDetailDoneButton?(): void;
  wheelStop?(): void;
  sheet?: any;
  sheetMq?: MediaQueryList;
  sheetOpenedAt?: number;
  overlay?: any;
  newListOpen?: boolean;
  // scs-2-questlist-controls.js
  afterDrawerCloses?(fn: () => void): any;
  filtersArePanel?(): boolean;
  foldChips?(): void;
  measureChips?(): void;
  placeFilters?(on: boolean): void;
  refresh?(quiet?: boolean): void;
  setAnywhereOnly?(on: boolean): void;
  setFiltersOpen?(open: boolean): void;
  syncDrawer?(): void;
  setShowUnlocated?(on: boolean): void;
  chipBarIn?: boolean;
  chipsRow?: any;
  countEl?: any;
  listEl?: any;
  // scs-2-questlist-map.js
  applyControlLift?(top: number): void;
  buildStyle?(): any;
  discoverTileUrl?(): any;
  featureSet?(features?: any): any;
  fetchTransit?(): void;
  frameAboveCard?(loc: any): void;
  hideHoverTip?(): void;
  hoverAt?(point: any): void;
  installTapZoom?(map: any): void;
  loadBaseStyle?(): Promise<any>;
  mapTip?(offset: any): any;
  onMapClick?(e: any): void;
  paintMapGround?(): void;
  positionMapControls?(): void;
  repaintMap?(): void;
  resizeMap?(ifChanged?: boolean): void;
  startMap?(): void;
  startMapSoon?(): void;
  setMapData?(key: string, data: any): void;
  syncMarkInks?(): void;
  mapArrived?(): void;
  syncTransit?(): void;
  unfadeMapUi?(): void;
  baseStyle?: any;
  mapData?: any;
  mapBox?: any;
  mapCardEl?: any;
  mapFullBtn?: any;
  mapLocateBtn?: any;
  MAP_BOUNDS?: any;
  MAP_CENTER?: any;
  // scs-2-questlist-screen.js
  collapseMapSearch?(): void;
  raiseMapSearch?(): void;
  placePill?(e?: any): void;
  readSearchBox?(raw: string): any;
  realFullscreen?(on: boolean): void;
  renderSearchResults?(): void;
  resetSearchChevron?(): void;
  restoreSearchAfterSheet?(): void;
  setMapFull?(on: boolean): void;
  setSearchChevron?(dir: any): void;
  setSearchState?(next: string): void;
  applySearchText?(raw: string, from: any): void;
  mapLayerOnTop?(): boolean;
  showMapShot?(): void;
  dropMapShot?(fade: boolean): void;
  watchMapShot?(map: any): void;
  mapDrawnBefore?(): boolean;
  keptView?(): { lng: number; lat: number; zoom: number } | null;
  keepView?(map: any): void;
  syncPinGroups?(): void;
  watchCounts?(map: any): void;
  redrawCounts?(): void;
  syncPop?(): void;
  syncSide?(): void;
  onDesk?: boolean;
  searchBody?: any;
  searchReturnState?: string | null;
  searchState?: string;
  searchWrap?: any;
  travelled?: any;
}

declare var scsQuestList: ScsQuestList;

// ---- what one page's script hands another (and shared.d.ts) ----

// assets/push.js
declare var scsPush: {
  ready: Promise<any>;
  back(): void;
};
// assets/slideshow.js
declare var scsSlideshow: {
  start(list: any[]): void;
  stop(): void;
  isOn(): boolean;
};
// assets/photo-view.js, loaded by the worker's file pages
declare var SCSPhotoView: {
  open(o: any): any;
};
// assets/photo-details.js
declare var scsPhotoDetails: {
  rows(d: any, video?: boolean): any;
};
// tab/replay/replay-map.js, on the replay page and a team's page
declare var SCSReplay: {
  start(host: HTMLElement, opts?: any): { ready: Promise<any>; teams(): string[]; stop(): void };
  preload?(): void;
};
// questlist/full/full.js
declare var scsFullQuest: {
  details(g: any, opts?: any): any;
  points(g: any): string;
  live(g: any): boolean;
};
// submit/webcodecs.js
declare var scsWebCodecs: {
  compress(file: any, opts: any): Promise<any>;
};
// ticket/qrcode.js
declare var scs2qrcode: (typeNumber: number, errorCorrectionLevel: string) => any;

// ---- events the scripts send each other on document ----
interface DocumentEventMap {
  'scs-close-panels': CustomEvent<{ except: string }>;
  'scs-dates-changed': CustomEvent;
  'scs-session-changed': CustomEvent;
  'scs-checklist-changed': CustomEvent;
  'scs-run': CustomEvent<any>;
  'scs-push-changed': CustomEvent;
}

// ---- events on window ----
interface WindowEventMap {
  'scs-pulse': CustomEvent<any>;
}

// ---- what a script keeps on something it made ----
// the haptic switch laid over a control (site-input.js)
interface HTMLInputElement {
  _scsHost?: HTMLElement;
}
// a row of the submit page's uploads
interface HTMLDivElement {
  fill?: HTMLSpanElement;
  count?: HTMLParagraphElement;
}
// the label a subscription is sent with (scs.pushSub.label)
interface PushSubscriptionJSON {
  label?: string;
}
// MP4Box reads where a buffer sits in the file from fileStart
interface ArrayBuffer {
  fileStart?: number;
}

// ---- libraries copied in as published (eslint.config.mjs lists them) ----
declare var Mp4Muxer: any;
declare var FFmpegWASM: any;
