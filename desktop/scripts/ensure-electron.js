'use strict';

const path = require('path');

process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
if (process.env.ELECTRON_CACHE) process.env.electron_config_cache = process.env.ELECTRON_CACHE;

require(path.join(__dirname, '..', 'node_modules', 'electron', 'install.js'));
