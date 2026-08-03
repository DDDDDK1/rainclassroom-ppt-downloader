const fs = require('fs');
const path = require('path');

const logic = fs.readFileSync(path.join(__dirname, 'src', 'logic.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'src', 'app.js'), 'utf8');

const output = app.replace('/* __LOGIC__ */', logic);
fs.writeFileSync(
  path.join(__dirname, 'rainclassroom-ppt-downloader.user.js'),
  output,
  { encoding: 'utf8' }
);
console.log('Build complete: rainclassroom-ppt-downloader.user.js');
