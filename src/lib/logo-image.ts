import sharp from "sharp";

/**
 * Canonical ecosystem-map logo geometry.
 *
 * Every logo rendered on the ecosystem map is a 250×250 tile with 30px
 * rounded corners. Submitted logos are normalised to this exact format before
 * they are stored in S3, so the grid stays visually uniform regardless of what
 * the submitter uploaded (any aspect ratio, PNG/JPEG/SVG/WebP).
 */
export const LOGO_SIZE = 250;
export const LOGO_CORNER_RADIUS = 30;
export const LOGO_CONTENT_TYPE = "image/png";

/** SVG rasterisation density — higher than the 72dpi default for crisp 250px edges. */
const SVG_RASTER_DENSITY = 384;

function roundedRectMask(): Buffer {
    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_SIZE}" height="${LOGO_SIZE}">` +
            `<rect width="${LOGO_SIZE}" height="${LOGO_SIZE}" rx="${LOGO_CORNER_RADIUS}" ry="${LOGO_CORNER_RADIUS}"/>` +
            `</svg>`,
    );
}

/**
 * Normalise an arbitrary submitted logo into the canonical 250×250 PNG with
 * 30px rounded corners and a transparent background.
 *
 * - `fit: "contain"` preserves the source aspect ratio (no cropping or
 *   distortion) and pads with transparency, so wordmarks and non-square logos
 *   survive intact.
 * - The rounded-corner mask is applied with the `dest-in` blend: pixels inside
 *   the rounded rectangle are kept; the four corners become transparent.
 * - Output is always PNG (the stored object is `explorer-dapp-<id>.png`).
 *
 * Throws if `input` is not a decodable image.
 */
export async function normalizeLogo(input: Buffer): Promise<Buffer> {
    return sharp(input, { density: SVG_RASTER_DENSITY })
        .resize(LOGO_SIZE, LOGO_SIZE, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .composite([{ input: roundedRectMask(), blend: "dest-in" }])
        .png()
        .toBuffer();
}
