// What the site's and the dashboard's scripts take for granted about the
// browser, on top of lib.dom. Read by tsconfig.site.json and
// tsconfig.dash.json; nothing here is served.
//
// An element found by id or selector is used as the element the markup
// has there: an input's value, a video's play(). lib.dom answers a plain
// Element or HTMLElement, which the scripts would need a cast for at
// every lookup, and they are plain JavaScript with no casts. So the
// lookups answer `any`, and what is done with the element is not
// checked. An element the scripts make themselves (createElement) keeps
// its type. These overloads are read before lib.dom's own.

interface Document {
  getElementById(elementId: string): any;
}

interface ParentNode {
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): NodeListOf<any>;
}

interface Element {
  closest(selectors: string): any;
}

// The same for an element reached from another: the focused one, a
// template's first, a copy of one.
interface Document {
  readonly activeElement: any;
}
interface DocumentFragment {
  readonly firstElementChild: any;
}
interface Node {
  cloneNode(deep?: boolean): any;
}

// The element a tap, a key or a menu's toggle came from, read off the
// event the same way.
interface UIEvent {
  readonly target: any;
}
interface ToggleEvent {
  readonly target: any;
}

// An attribute given a number is written as its text.
interface Element {
  setAttribute(qualifiedName: string, value: string | number): void;
}

// What readAsArrayBuffer leaves in a FileReader's result.
interface Uint8ArrayConstructor {
  new (result: FileReader['result']): Uint8Array;
}

// The page's own load is the one navigation entry.
interface Performance {
  getEntriesByType(type: 'navigation'): PerformanceNavigationTiming[];
}

// document.currentScript can be an SVG script, which has no src.
interface SVGScriptElement {
  readonly src?: undefined;
}

// A promise a script makes itself resolves with no value as often as
// with one: resolve() is a call TypeScript reads as missing its argument.
interface PromiseConstructor {
  new (executor: (resolve: (value?: any) => void, reject: (reason?: any) => void) => void): Promise<any>;
}

// The scripts build their date and time options in a variable first, so
// the option values read as strings rather than as the words lib.dom
// lists.
interface Date {
  toLocaleDateString(locales?: string | string[], options?: object): string;
  toLocaleTimeString(locales?: string | string[], options?: object): string;
  toLocaleString(locales?: string | string[], options?: object): string;
}

// What a browser has that lib.dom leaves out: Safari's installed-app
// flag, the connection hints and the prefixed full screen.
interface Navigator {
  standalone?: boolean;
  connection?: any;
}
interface Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?(): void;
}
interface HTMLElement {
  webkitRequestFullscreen?(): void;
}
