import { describe, expect, it } from "vitest";
import { remoteSetupArgs } from "./remote-setup.js";

describe("remote server setup boundary", () => {
  it("preserves an SSH alias and uses strict host-key verification", () => {
    const args = remoteSetupArgs({ host: "example-host", daemonPort: 6787, sshPort: 2222 });
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.slice(-6)).toEqual(["example-host", "sh", "-s", "--", "6787", "22.20.0"]);
    expect(args).toContain("2222");
  });
  it.each(["-oProxyCommand=evil", "host name", "\nhost"])("rejects unsafe target %s", (host) => {
    expect(() => remoteSetupArgs({ host, daemonPort: 6787 })).toThrow();
  });
  it.each([0, 65536, 1.5])("rejects invalid ports %s", (daemonPort) => {
    expect(() => remoteSetupArgs({ host: "server", daemonPort })).toThrow();
  });
});
