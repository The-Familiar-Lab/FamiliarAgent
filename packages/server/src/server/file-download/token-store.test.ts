import { describe, expect, it } from "vitest";
import { DownloadTokenStore } from "./token-store.js";
const file = {
  path: "video.mp4",
  absolutePath: "/tmp/video.mp4",
  fileName: "video.mp4",
  mimeType: "video/mp4",
  size: 1024,
};
describe("file capabilities", () => {
  it("keeps downloads single use", () => {
    const store = new DownloadTokenStore({ ttlMs: 1000 });
    const { token } = store.issueToken(file);
    expect(store.consumeToken(token)).not.toBeNull();
    expect(store.consumeToken(token)).toBeNull();
  });
  it("leases media for seeking with a bounded lifetime", () => {
    let now = 0;
    const store = new DownloadTokenStore({ ttlMs: 1000, now: () => now });
    const { token } = store.issueToken(file);
    expect(store.peekToken(token)).not.toBeNull();
    now = 2 * 60 * 1000;
    expect(store.peekToken(token)).not.toBeNull();
    now = 30 * 60 * 1000;
    expect(store.peekToken(token)).toBeNull();
  });
  it("does not revive an expired initial token", () => {
    let now = 0;
    const store = new DownloadTokenStore({ ttlMs: 1000, now: () => now });
    const { token } = store.issueToken(file);
    now = 1001;
    expect(store.peekToken(token)).toBeNull();
  });
});

it("bounds memory without evicting active downloads and recovers after expiry", () => {
  let now = 0;
  const store = new DownloadTokenStore({ ttlMs: 100, now: () => now, maxTokens: 1 });
  store.issueToken(file);
  expect(() => store.issueToken(file)).toThrow("Too many");
  now = 101;
  expect(store.issueToken(file)).toMatchObject({ fileName: "video.mp4" });
});
