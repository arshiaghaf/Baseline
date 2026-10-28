// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

const { imageSizeFromFile } = require("image-size-parser/fromFile");

// appdmg only uses the legacy asynchronous filename/callback API. Keep parsing
// in the patched upstream implementation; do not vendor or patch its parsers.
module.exports = function sizeOf(filename, callback) {
  imageSizeFromFile(filename)
    .then((dimensions) => {
      if (
        !Number.isFinite(dimensions.width) ||
        !Number.isFinite(dimensions.height) ||
        dimensions.width <= 0 ||
        dimensions.height <= 0
      ) {
        throw new Error("Image has no valid dimensions");
      }
      return dimensions;
    })
    .then(
      (dimensions) => callback(null, dimensions),
      (error) => callback(error)
    );
};
