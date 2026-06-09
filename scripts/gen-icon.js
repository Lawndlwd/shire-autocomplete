// Rasterize media/icon.svg → media/icon.png (128x128) for the Marketplace.
// Run: npm run icon  (requires the `sharp` devDependency)
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const svg = path.join(__dirname, "..", "media", "icon.svg");
const png = path.join(__dirname, "..", "media", "icon.png");

sharp(fs.readFileSync(svg))
  .resize(128, 128)
  .png()
  .toFile(png)
  .then(() => console.log("wrote", png))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
