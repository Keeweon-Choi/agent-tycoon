/**
 * The push picture link (pushImage.ts): the signature (valid, expired, tampered, another file),
 * and the route (serves the one image, refuses everything else with the same empty 404).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PUSH_IMAGE_MAX_BYTES,
  PUSH_IMAGE_PATH,
  PUSH_IMAGE_ROUTE,
  PUSH_IMAGE_TTL_MS,
  PushImages,
  registerPushImageRoute,
} from './pushImage.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-pushimage-'));
  dirs.push(dir);
  const outbox = path.join(dir, '.agty-outbox');
  fs.mkdirSync(outbox);
  const put = (name: string, body: Buffer | string = 'x', where = outbox) => {
    const file = path.join(where, name);
    fs.writeFileSync(file, body);
    return file;
  };
  return { dir, outbox, put };
}
const tokenOf = (url: string) => url.slice(PUSH_IMAGE_ROUTE.length);

describe('PushImages: the signature', () => {
  it('opens the image it signed, until it expires', () => {
    let now = 1_800_000_000_000;
    const images = new PushImages(Buffer.alloc(32, 1), () => now);
    const a = project().put('a.png', 'PNGDATA');
    const url = images.mint(a)!;
    expect(url).toMatch(PUSH_IMAGE_PATH);
    const file = images.open(tokenOf(url))!;
    expect([file.type, file.size]).toEqual(['image/png', 7]);
    fs.closeSync(file.fd);
    now += PUSH_IMAGE_TTL_MS - 1;
    const still = images.open(tokenOf(url));
    expect(still).not.toBeNull();
    fs.closeSync(still!.fd);
    now += 1;
    expect(images.open(tokenOf(url))).toBeNull();
  });

  it('refuses a tampered token, another file\'s id, a moved expiry and another daemon\'s secret', () => {
    const images = new PushImages(Buffer.alloc(32, 1));
    const p = project();
    const [a, b] = [p.put('a.png'), p.put('b.png')];
    const [ua, ub] = [images.mint(a)!, images.mint(b)!];
    const [ida, expa, siga] = tokenOf(ua).split('.');
    const [idb] = tokenOf(ub).split('.');
    expect(images.open(`${idb}.${expa}.${siga}`)).toBeNull(); // another file under a's signature
    expect(images.open(`${ida}.${Number(expa) + 60_000}.${siga}`)).toBeNull(); // a longer life
    expect(images.open(`${ida}.${expa}.${siga.slice(0, -1)}${siga.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(images.open(`${ida}.${expa}.`)).toBeNull();
    expect(images.open('../../etc/passwd')).toBeNull();
    expect(new PushImages(Buffer.alloc(32, 2)).open(tokenOf(ua))).toBeNull();
    expect(images.open(tokenOf(ua))).not.toBeNull();
  });

  it('offers only a small image copy in an outbox folder', () => {
    const images = new PushImages();
    const p = project();
    expect(images.mint(p.put('big.png', Buffer.alloc(PUSH_IMAGE_MAX_BYTES + 1)))).toBeNull();
    expect(images.mint(p.put('note.txt'))).toBeNull();
    expect(images.mint(p.put('clip.mp4'))).toBeNull();
    expect(images.mint(p.put('elsewhere.png', 'x', p.dir))).toBeNull(); // not under .agty-outbox
    expect(images.mint(path.join(p.outbox, 'missing.png'))).toBeNull();
    fs.symlinkSync(p.put('real.png', 'x', p.dir), path.join(p.outbox, 'link.png'));
    expect(images.mint(path.join(p.outbox, 'link.png'))).toBeNull();
    expect(images.mint(p.put('ok.jpg'))).not.toBeNull();
  });

  it('a copy replaced by a symlink after the push is refused', () => {
    const images = new PushImages();
    const p = project();
    const file = p.put('a.png');
    const url = images.mint(file)!;
    fs.unlinkSync(file);
    fs.symlinkSync(p.put('secret.png', 'S', p.dir), file);
    expect(images.open(tokenOf(url))).toBeNull();
  });
});

describe('the public path', () => {
  it('matches a minted link and nothing looser', () => {
    const p = project();
    expect(new PushImages().mint(p.put('a.png'))).toMatch(PUSH_IMAGE_PATH);
    for (const bad of ['/api/agty/push-image/', '/api/agty/push-image/a.b.c', '/api/agty/push-image/../x', '/api/agty/files/content/x'])
      expect(PUSH_IMAGE_PATH.test(bad)).toBe(false);
  });
});

describe('the push picture route', () => {
  it('serves the image; every other request is the same empty 404', async () => {
    const images = new PushImages(Buffer.alloc(32, 1));
    const app = Fastify();
    registerPushImageRoute(app, images);
    const p = project();
    const url = images.mint(p.put('a.png', 'PNGDATA'))!;
    const hit = await app.inject({ method: 'GET', url });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers['content-type']).toBe('image/png');
    expect(hit.headers['x-content-type-options']).toBe('nosniff');
    expect(hit.body).toBe('PNGDATA');
    const [id, exp, sig] = tokenOf(url).split('.');
    for (const bad of [
      `${PUSH_IMAGE_ROUTE}${id}.${exp}.${sig.slice(1)}A`,
      `${PUSH_IMAGE_ROUTE}${id}.1.${sig}`,
      `${PUSH_IMAGE_ROUTE}..%2F..%2Fetc%2Fpasswd`,
      `${PUSH_IMAGE_ROUTE}`,
      `${PUSH_IMAGE_ROUTE}a.b.c`,
    ]) {
      const miss = await app.inject({ method: 'GET', url: bad });
      expect([miss.statusCode, miss.body]).toEqual([404, '']);
    }
    // The link is for GET only, and the table lists nothing.
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404);
    await app.close();
  });
});
