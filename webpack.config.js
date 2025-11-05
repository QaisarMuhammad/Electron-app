const path = require('path');

module.exports = {
    entry: {
        main: './index.js',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'main.bundle.js',
    },
    target: 'electron-main',
    node: {
        __dirname: false,
        __filename: false
    }
};
