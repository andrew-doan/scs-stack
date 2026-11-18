// The service worker's scope, for tsconfig.sw.json. lib.webworker types
// `self` as any kind of worker's; these are the parts a service worker
// has, which sw.js uses. Nothing here is served.
interface WorkerGlobalScope {
  readonly clients: Clients;
  readonly registration: ServiceWorkerRegistration;
  skipWaiting(): Promise<void>;
}
interface WorkerGlobalScopeEventMap {
  install: ExtendableEvent;
  activate: ExtendableEvent;
  fetch: FetchEvent;
  push: PushEvent;
  notificationclick: NotificationEvent;
  message: ExtendableMessageEvent;
}
declare var clients: Clients;
