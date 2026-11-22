// The site's own scripts are written in ES5 (var, function, no arrow
// functions, no classes), the house style that keeps them running on the
// browsers of September 2021 with no build step. The one later piece of
// syntax used is import(), which loads a library only when it is needed
// and which every one of those browsers has. So the files are parsed as
// modern JavaScript and each newer construct is reported by name, along
// with the two newer calls that have broken a page before. Run it from
// tab/ with `npm run lint`. Inline scripts in the HTML pages are not
// checked.
const NOT_ES5 = [
  ['ArrowFunctionExpression', 'an arrow function'],
  ['ClassDeclaration', 'a class'], ['ClassExpression', 'a class'],
  ["VariableDeclaration[kind='let']", 'let'], ["VariableDeclaration[kind='const']", 'const'],
  ['TemplateLiteral', 'a template literal'],
  ['SpreadElement', 'spread syntax'], ['RestElement', 'rest syntax'],
  ['ObjectPattern', 'destructuring'], ['ArrayPattern', 'destructuring'],
  ['AssignmentPattern', 'a default value'],
  ['ForOfStatement', 'for…of'],
  [':function[async=true]', 'an async function'], [':function[generator=true]', 'a generator'],
  ['Property[shorthand=true]', 'a shorthand property'], ['Property[method=true]', 'a method shorthand'],
  ['Property[computed=true]', 'a computed property name'],
  ['ChainExpression', 'optional chaining'],
  ["LogicalExpression[operator='??']", '??'], ["BinaryExpression[operator='**']", '**'],
  ['MetaProperty', 'import.meta or new.target']
].map(([selector, what]) => ({ selector, message: 'Not ES5: ' + what + '. The site\'s scripts are written in ES5 (website/assets/CLAUDE.md).' }));

export default [
  {
    ignores: [
      'tab/**', 'checkin/**', 'tile-server/**', 'text/**', '.claude/**',
      '**/tests/**',
      // libraries copied in as published
      'website/assets/maplibre/**', 'website/assets/ffmpeg/**', 'website/assets/ffmpeg-mt/**', 'website/assets/pdfjs/**',
      'website/assets/heic/**', 'website/assets/haptics/**', 'website/assets/mp4box/**',
      'website/assets/mp4-muxer/**', 'website/ticket/qrcode.js'
    ]
  },
  {
    files: ['website/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script' },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-syntax': ['error'].concat(NOT_ES5),
      'no-restricted-properties': ['error',
        { object: 'Object', property: 'hasOwn', message: 'Safari before 15.4 has no Object.hasOwn.' }],
      'no-restricted-globals': ['error',
        { name: 'structuredClone', message: 'Safari before 15.4 has no structuredClone.' }]
    }
  }
];
