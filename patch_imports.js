const fs = require('fs');
const path = require('path');

const distDir = 'F:/eikon/CubismSdkForWeb-5-r.5/Framework/dist';

function patchDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += patchDir(fullPath);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.js.map')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      // Add .js to relative import paths that don't have an extension
      const newContent = content.replace(
        /from\s+['"](\.[^'"]+)['"]/g,
        (match, p1) => {
          if (!p1.endsWith('.js')) {
            return `from '${p1}.js'`;
          }
          return match;
        }
      );
      if (newContent !== content) {
        fs.writeFileSync(fullPath, newContent);
        count++;
      }
    }
  }
  return count;
}

const patched = patchDir(distDir);
console.log(`Patched ${patched} files`);
