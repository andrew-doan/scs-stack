// For the type checker only. Parsed JSON is unknown until something has
// checked it, rather than `any`, and an array found by Array.isArray in
// a value of unknown shape holds unknown things. Merged into the
// standard declarations, these come first, so they are the ones used.

interface JSON {
  parse(text: string): unknown;
}

interface ArrayConstructor {
  isArray(arg: unknown): arg is unknown[];
}
