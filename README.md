# Gadgets POS

POS application for Gadgets POS built with Electron.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Scripts](#scripts)
- [Building](#building)
- [Environment Variables](#environment-variables)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)

## Overview

Gadgets POS is a Point of Sale (POS) application built using Electron. It provides a desktop interface for managing sales and inventory for a gadgets store.

## Features

- Online and offline functionality.
- Printing support.
- Cross-platform support (Windows, macOS, and Linux).
- Environment variable support for easy configuration.

## Installation

To get started with Gadgets POS, clone the repository and install the dependencies:

```js
git clone https://github.com/yourusername/electron-app.git
cd electron-app
npm install
```

## Usage
To run the application, use the following command:

```js
npm start
```

Scripts
Here are the main scripts available in this project:

start: Runs the Electron application.
build: Uses electron-builder to package the application.
package: Uses electron-packager to package the application for all platforms.
test: Placeholder for running tests.

## Building
To build the application for distribution, you can use the following commands:



## Using Electron Builder
Using Electron Packager
```js
npm run package
```

```js
npm run build
```


The built application will be found in the dist folder for Electron Builder or in platform-specific folders for Electron Packager.

## Environment Variables
The application uses environment variables for configuration. Create a .env file in the root directory and define your variables there:


APP_URL=http://localhost:3000
Load these variables in your Electron app using dotenv:

```js
require('dotenv').config();
const defaultURL = `${process.env.APP_URL}/vendor/dashboard`;
```


Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.