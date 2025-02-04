const path = require('path');
const webpack = require('webpack');

module.exports = {
    entry: './index.js', // Adjust the entry point according to your project structure
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'bundle.js',
        publicPath: '/',
    },
    target: 'electron-renderer', // Ensure it's set for Electron
    module: {
        rules: [
            // Add your loaders here
        ],
    },
    plugins: [
        new webpack.IgnorePlugin({
            resourceRegExp: /^fs$|^net$/,
        }),
    ],
    resolve: {
        fallback: {
            // Other fallbacks if necessary
        },
    },
};
