import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";

import sharp from "sharp";

import {
  AVATAR_SIZE,
  TOO_MANY_PIXELS,
  UNREADABLE,
  UNSUPPORTED_FORMAT,
  UnsupportedImageError,
  oneAtATime,
  processImage,
  sniff,
} from "../src/avatars/image.js";

/**
 * Real sharp, on pictures generated in memory. The point of this module is
 * what libvips does to hostile or awkward input, which a fake cannot show.
 */

function solid(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: "#c03030" },
  });
}

async function refusal(input: Uint8Array): Promise<string> {
  try {
    await processImage(input);
  } catch (error) {
    assert.ok(error instanceof UnsupportedImageError);
    return error.message;
  }
  assert.fail("expected the input to be refused");
}

test("sniff names the four accepted formats and nothing else", async () => {
  assert.equal(sniff(await solid(4, 4).png().toBuffer()), "png");
  assert.equal(sniff(await solid(4, 4).jpeg().toBuffer()), "jpeg");
  assert.equal(sniff(await solid(4, 4).webp().toBuffer()), "webp");
  assert.equal(sniff(await solid(4, 4).gif().toBuffer()), "gif");
  assert.equal(sniff(await solid(4, 4).tiff().toBuffer()), undefined);
  assert.equal(
    sniff(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ),
    undefined,
  );
  assert.equal(sniff(new Uint8Array()), undefined);
});

test("a wide JPEG becomes a 256px square WebP named by its hash", async () => {
  const out = await processImage(
    new Uint8Array(await solid(1000, 600).jpeg().toBuffer()),
  );

  const meta = await sharp(out.bytes).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, AVATAR_SIZE);
  assert.equal(meta.height, AVATAR_SIZE);
  assert.match(out.hash, /^[0-9a-f]{64}$/);
});

test("the same picture always gets the same name", async () => {
  const input = new Uint8Array(await solid(300, 300).png().toBuffer());
  assert.equal(
    (await processImage(input)).hash,
    (await processImage(input)).hash,
  );
});

test("EXIF orientation is applied, then the metadata is dropped", async () => {
  // Red on the left, blue on the right, tagged "rotate 90 degrees clockwise".
  // Displayed upright, red is on top — which is what the avatar must show.
  const tagged = await sharp({
    create: { width: 200, height: 100, channels: 3, background: "#ff0000" },
  })
    .composite([
      {
        input: {
          create: {
            width: 100,
            height: 100,
            channels: 3,
            background: "#0000ff",
          },
        },
        left: 100,
        top: 0,
      },
    ])
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const out = await processImage(new Uint8Array(tagged));
  const { data, info } = await sharp(out.bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const at = (y * info.width + x) * info.channels;
    return { r: data[at] ?? 0, b: data[at + 2] ?? 0 };
  };

  const top = pixel(128, 20);
  const bottom = pixel(128, 236);
  assert.ok(
    top.r > 180 && top.b < 80,
    `top should be red: ${JSON.stringify(top)}`,
  );
  assert.ok(
    bottom.b > 180 && bottom.r < 80,
    `bottom should be blue: ${JSON.stringify(bottom)}`,
  );

  const meta = await sharp(out.bytes).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.orientation, undefined);
});

test("PNG, WebP and GIF are accepted too", async () => {
  for (const encoded of [
    await solid(64, 64).png().toBuffer(),
    await solid(64, 64).webp().toBuffer(),
    await solid(64, 64).gif().toBuffer(),
  ]) {
    const out = await processImage(new Uint8Array(encoded));
    assert.equal((await sharp(out.bytes).metadata()).format, "webp");
  }
});

test("formats libvips could read but this does not accept are refused unparsed", async () => {
  assert.equal(
    await refusal(
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      ),
    ),
    UNSUPPORTED_FORMAT,
  );
  assert.equal(
    await refusal(new Uint8Array(await solid(8, 8).tiff().toBuffer())),
    UNSUPPORTED_FORMAT,
  );
  assert.equal(
    await refusal(new TextEncoder().encode("just some text")),
    UNSUPPORTED_FORMAT,
  );
});

test("a file with the right signature but no picture behind it is unreadable", async () => {
  const png = await solid(8, 8).png().toBuffer();
  assert.equal(await refusal(new Uint8Array(png.subarray(0, 12))), UNREADABLE);
});

/** One PNG chunk: length, type, data, CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

/**
 * A well-formed PNG declaring a canvas, with almost no pixels behind it: a
 * few dozen bytes that would ask libvips for the whole canvas on decode.
 */
function declaredPng(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc(16))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

test("a declared canvas over the pixel cap is refused from its header", async () => {
  // 100 megapixels in a few dozen bytes: the decompression bomb shape.
  assert.equal(await refusal(declaredPng(10_000, 10_000)), TOO_MANY_PIXELS);
});

test("decodes run one at a time, so parallel uploads cannot exhaust memory", async () => {
  let running = 0;
  let peak = 0;
  const task = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
  };

  await Promise.all([oneAtATime(task), oneAtATime(task), oneAtATime(task)]);

  assert.equal(peak, 1);
});

test("a failed decode does not block the ones queued behind it", async () => {
  const failed = oneAtATime(() => Promise.reject(new Error("bad input")));
  const next = oneAtATime(() => Promise.resolve("done"));

  await assert.rejects(failed, /bad input/);
  assert.equal(await next, "done");
});

test("parallel real uploads all succeed through the queue", async () => {
  const inputs = await Promise.all(
    ["#102030", "#405060", "#708090"].map(
      async (background) =>
        new Uint8Array(
          await sharp({
            create: { width: 300, height: 200, channels: 3, background },
          })
            .png()
            .toBuffer(),
        ),
    ),
  );

  const outputs = await Promise.all(inputs.map((input) => processImage(input)));

  assert.equal(new Set(outputs.map((output) => output.hash)).size, 3);
});
