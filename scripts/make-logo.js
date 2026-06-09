// Convert a photo into the Marketplace icon: media/icon.png (128x128, square).
// 1. Save your image as media/logo-source.png (or .jpg) in this project.
// 2. Run: npm run logo
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const dir = path.join(__dirname, "..", "media");
const candidates = ["logo-source.png", "logo-source.jpg", "logo-source.jpeg", "logo-source.webp"];
const src = candidates.map((f) => path.join(dir, f)).find((p) => fs.existsSync(p));

if (!src) {
  console.error(
    "No source image found. Save your photo as media/logo-source.png (or .jpg) then re-run."
  );
  process.exit(1);
}

const out = path.join(dir, "icon.png");
sharp(src)
  .resize(128, 128, { fit: "cover", position: "attention" }) // center on the face
  .png()
  .toFile(out)
  .then(() => console.log("wrote", out, "from", path.basename(src)))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
