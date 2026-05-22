const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/comment.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'netlify/functions/comment.js',
  external: [],
}).then(() => {
  console.log('Bundle complete: netlify/functions/comment.js');
}).catch(() => process.exit(1));
