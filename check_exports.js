const fs = require('fs');
const f = [
  'motion/cubismupdatescheduler.js',
  'motion/cubismeyeblinkupdater.js',
  'motion/cubismbreathupdater.js',
  'motion/cubismlookupdater.js',
  'model/cubismmoc.js',
  'cubismmodelsettingjson.js',
  'rendering/cubismrenderer_webgl.js',
  'math/cubismmatrix44.js',
  'cubismdefaultparameterid.js',
  'live2dcubismframework.js',
  'effect/cubismbreath.js',
  'effect/cubismeyeblink.js',
  'effect/cubismlook.js'
];
f.forEach(fn => {
  try {
    const c = fs.readFileSync('F:/eikon/live2d-example/framework/dist/' + fn, 'utf8');
    const lines = c.split('\n');
    lines.forEach((l, i) => {
      if (l.match(/^export/)) {
        console.log(fn + ':' + (i+1) + ': ' + l.trim());
      }
    });
  } catch(e) {
    console.log(fn + ': ERROR ' + e.message);
  }
});
