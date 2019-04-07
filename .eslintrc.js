"use strict";

var fs = require("fs");
var path = require("path");
var PACKAGE_NAME = require("./package").name;
var SYMLINK_LOCATION = path.join(__dirname, "node_modules", PACKAGE_NAME);

// Symlink node_modules/eslint-plugin-qml to this directory so that ESLint
// resolves this plugin name correctly.
if (!fs.existsSync(SYMLINK_LOCATION)) {
  fs.symlinkSync(__dirname, SYMLINK_LOCATION);
}

module.exports = {
  root: true,
  plugins: [PACKAGE_NAME],
  env: {
    node: true,
    es6: true
  },
  extends: "eslint",
  rules: {
    indent: ["error", 2]
  },
  parserOptions: {
    ecmaVersion: 6,
    ecmaFeatures: {
      spread: true
    }
  }
};
