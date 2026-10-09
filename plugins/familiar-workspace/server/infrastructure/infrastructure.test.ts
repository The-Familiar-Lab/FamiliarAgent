import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type {
  ToolActionContext,
  ToolActionRequest,
  ToolCommand,
} from "../tool-actions/contracts.js";
import { INFRASTRUCTURE_ADAPTERS } from "./index.js";
import { bsshAdapter } from "./bssh.js";
import { coderAdapter } from "./coder.js";
import { firetowerAdapter } from "./firetower.js";
import { juicefsAdapter } from "./juicefs.js";
import { skulkAdapter } from "./skulk.js";
import { httpEndpoint, privateProfile } from "./common.js";
import { ToolRunStore } from "../tool-actions/store.js";
import { ToolActions } from "../tool-actions/service.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-infrastructure-"));
  directories.push(directory);
  const exec = vi
    .fn<ToolActionContext["exec"]>()
    .mockResolvedValue({ stdout: "native output", stderr: "", exitCode: 0 });
  const request = vi
    .fn<ToolActionContext["request"]>()
    .mockResolvedValue({ status: 200, body: "[]" });
  const context: ToolActionContext = {
    runDirectory: directory,
    signal: new AbortController().signal,
    resolveCommand: async (binary) => binary,
    exec,
    request,
  };
  const input: ToolActionRequest = {
    toolId: "",
    action: "",
    sessionId: "session",
    cwd: directory,
    input: "",
    parameters: {},
  };
  async function profile(contents: unknown) {
    const file = path.join(directory, "profile.json");
    await writeFile(file, JSON.stringify(contents), { mode: 0o600 });
    return file;
  }
  return { directory, context, input, exec, request, profile };
}
describe("native infrastructure boundaries", () => {
  it("uses private files for connection secrets and rejects symlinks, public modes and unknown keys", async () => {
    const f = await fixture(),
      file = await f.profile({ token: "private" }),
      schema = z.object({ token: z.string() }).strict();
    expect(await privateProfile(file, schema)).toEqual({ token: "private" });
    const link = path.join(f.directory, "link");
    await symlink(file, link);
    await expect(privateProfile(link, schema)).rejects.toThrow("regular file");
    await chmod(file, 0o644);
    await expect(privateProfile(file, schema)).rejects.toThrow("0600");
    await chmod(file, 0o600);
    await f.profile({ token: "private", unrecognized: true });
    await expect(privateProfile(file, schema)).rejects.toThrow("profile format");
  });
  it.each([
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "file:///tmp/socket",
  ])("rejects unsafe credential endpoint %s", (url) => {
    expect(httpEndpoint.safeParse(url).success).toBe(false);
  });
  it.each(["http://127.0.0.1:8080", "http://[::1]:8080", "https://example.com"])(
    "accepts protected endpoint %s",
    (url) => {
      expect(httpEndpoint.safeParse(url).success).toBe(true);
    },
  );
  it("rejects unknown saved settings before running an actual adapter", async () => {
    const f = await fixture(),
      service = new ToolActions(
        new ToolRunStore(path.join(f.directory, "store"), "server"),
        INFRASTRUCTURE_ADAPTERS,
        async (command) => command,
      );
    try {
      await expect(
        service.start({
          ...f.input,
          toolId: "coder",
          action: "list",
          parameters: { token: "must-not-store" },
          operationId: "unknown-parameter",
        }),
      ).rejects.toThrow("Unknown action setting");
    } finally {
      await service.close();
    }
  });
  it("preserves one exact Coder shell command and checks exit status", async () => {
    const f = await fixture(),
      input = {
        ...f.input,
        action: "exec",
        nativeId: "workspace",
        input: "printf '%s' 'a b; $(not-expanded-locally)'",
      };
    await coderAdapter.execute(input, f.context);
    expect(f.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "coder",
        args: ["ssh", "workspace", "--", input.input],
        cwd: f.directory,
      }),
    );
    f.exec.mockResolvedValue({ stdout: "", stderr: "agent offline", exitCode: 7 });
    await expect(coderAdapter.execute(input, f.context)).rejects.toThrow("agent offline");
  });
  it("does not invent a successful Coder inventory for invalid native JSON", async () => {
    const f = await fixture();
    await expect(coderAdapter.execute({ ...f.input, action: "list" }, f.context)).rejects.toThrow(
      "invalid JSON",
    );
  });
  it("prevents option-shaped native IDs and validates explicit profile directories", async () => {
    const f = await fixture();
    await expect(
      coderAdapter.execute({ ...f.input, action: "stop", nativeId: "--all" }, f.context),
    ).rejects.toThrow("valid native");
    await expect(
      coderAdapter.execute(
        { ...f.input, action: "list", parameters: { configDirectory: "relative" } },
        f.context,
      ),
    ).rejects.toThrow("absolute");
    expect(f.exec).not.toHaveBeenCalled();
  });
  it("returns Skulk send as an acknowledgement, retaining exact input behind --", async () => {
    const f = await fixture(),
      input = {
        ...f.input,
        action: "send",
        nativeId: "agent-one",
        input: "--untrusted-option; echo hello",
      };
    expect((await skulkAdapter.execute(input, f.context)).state).toBe("submitted");
    expect(f.exec.mock.calls[0]?.[0].args).toEqual([
      "--no-color",
      "--json",
      "send",
      "agent-one",
      "--",
      input.input,
    ]);
  });
  it("does not send malformed Skulk names or oversized input", async () => {
    const f = await fixture();
    await expect(
      skulkAdapter.execute({ ...f.input, action: "new", nativeId: "../outside" }, f.context),
    ).rejects.toThrow("Skulk names");
    await expect(
      skulkAdapter.execute(
        { ...f.input, action: "send", nativeId: "safe", input: "가".repeat(30_000) },
        f.context,
      ),
    ).rejects.toThrow("64 KiB");
    expect(f.exec).not.toHaveBeenCalled();
  });
  it("creates only a supported Firetower driver and preserves native ACK semantics", async () => {
    const f = await fixture(),
      profile = await f.profile({ url: "http://127.0.0.1:9000", token: "private" }),
      input = { ...f.input, action: "create", parameters: { profile, agent: "ClaudeCode" } };
    f.request.mockResolvedValue({
      status: 201,
      body: JSON.stringify({ id: "session-original", status: "Starting" }),
    });
    const result = await firetowerAdapter.execute(input, f.context);
    expect(result).toMatchObject({ state: "submitted", nativeId: "session-original" });
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      body: { agent: "ClaudeCode" },
      headers: { Authorization: "Bearer private" },
    });
    await expect(
      firetowerAdapter.execute({ ...input, parameters: { profile, agent: "Shell" } }, f.context),
    ).rejects.toThrow("Unknown Firetower agent");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("surfaces Firetower readiness rejection and redacts the private token", async () => {
    const f = await fixture(),
      profile = await f.profile({ url: "http://localhost:9000", token: "private-token" });
    f.request.mockResolvedValue({
      status: 400,
      body: JSON.stringify({ message: "Missing native driver private-token" }),
    });
    await expect(
      firetowerAdapter.execute({ ...f.input, action: "hosts", parameters: { profile } }, f.context),
    ).rejects.toThrow("Missing native driver [private connection]");
  });
  it("does not make unbounded or recursive WebDAV listing requests", async () => {
    const f = await fixture(),
      profile = await f.profile({ webdavUrl: "http://localhost:8000" });
    f.request.mockResolvedValue({ status: 207, body: "<multistatus/>" });
    await juicefsAdapter.execute(
      { ...f.input, action: "list", parameters: { profile, path: "folder with spaces" } },
      f.context,
    );
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      method: "PROPFIND",
      url: "http://localhost:8000/folder%20with%20spaces",
      headers: { Depth: "1" },
      maxBytes: 256 * 1024,
    });
    await expect(
      juicefsAdapter.execute(
        { ...f.input, action: "read", parameters: { profile, path: "../secret" } },
        f.context,
      ),
    ).rejects.toThrow("parent traversal");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("sends raw WebDAV text, checks HTTP status and never reports rejection as completion", async () => {
    const f = await fixture(),
      profile = await f.profile({
        webdavUrl: "http://localhost:8000",
        username: "user",
        password: "password",
      });
    f.request.mockResolvedValue({ status: 403, body: "forbidden" });
    await expect(
      juicefsAdapter.execute(
        {
          ...f.input,
          action: "write",
          input: '{"exact":"text"}',
          parameters: { profile, path: "sample" },
        },
        f.context,
      ),
    ).rejects.toThrow("403");
    expect(f.request.mock.calls[0]?.[0].body).toBe('{"exact":"text"}');
  });
  it("URL-encodes special local filenames before passing them to native JuiceFS sync", async () => {
    const f = await fixture(),
      profile = await f.profile({ metadataUrl: "sqlite3:///tmp/test.db" });
    const source = path.join(f.directory, "file #1?.txt");
    await writeFile(source, "sample");
    await juicefsAdapter.execute(
      { ...f.input, action: "upload", parameters: { profile, path: "folder/#file?.txt", source } },
      f.context,
    );
    expect(f.exec.mock.calls[0]?.[0].args.slice(-2)).toEqual([
      "file://" + source.replaceAll(" ", "%20").replaceAll("#", "%23").replaceAll("?", "%3F"),
      "jfs://familiar_volume/folder/%23file%3F.txt",
    ]);
  });
  it("keeps JuiceFS metadata credentials out of returned CLI diagnostics", async () => {
    const f = await fixture(),
      metadataUrl = "redis://private:password@localhost/1",
      profile = await f.profile({ metadataUrl });
    f.exec.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "failed " + metadataUrl + " password",
    });
    try {
      await juicefsAdapter.execute(
        { ...f.input, action: "status", parameters: { profile } },
        f.context,
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain(metadataUrl);
      expect(String(error)).not.toContain("password");
    }
  });
});
function bsshProcess(command: ToolCommand) {
  if (command.args[0] === "-Q")
    return {
      stdout: "ssh-ed25519\ncurve25519-sha256\naes256-ctr\nhmac-sha2-256\n",
      stderr: "",
      exitCode: 0,
    };
  if (command.args[0] === "-G")
    return {
      stdout:
        "host familiar_alias\nhostname 127.0.0.1\nuser user\nport 2200\nverifyhostkeydns false\nconnecttimeout none\nhostkeyalgorithms unsupported,ssh-ed25519\npubkeyacceptedalgorithms ssh-ed25519\nkexalgorithms curve25519-sha256\nciphers aes256-ctr\nmacs hmac-sha2-256\n",
      stderr: "",
      exitCode: 0,
    };
  return { stdout: "command completed", stderr: "", exitCode: 0 };
}
describe("bssh profile compatibility", () => {
  it("expands existing OpenSSH aliases and intersects native algorithms without broadening user policy", async () => {
    const f = await fixture();
    f.exec.mockImplementation(async (command) => bsshProcess(command));
    await bsshAdapter.execute(
      {
        ...f.input,
        action: "exec",
        input: "printf exact",
        parameters: { hosts: "familiar_alias" },
      },
      f.context,
    );
    const config = await readFile(path.join(f.directory, "bssh-resolved-config"), "utf8");
    expect(config).toContain("Host familiar-native-1");
    expect(config).toContain("hostname 127.0.0.1");
    expect(config).toContain("hostkeyalgorithms ssh-ed25519");
    expect(config).not.toContain("unsupported");
    expect(config).toContain("verifyhostkeydns no");
    const command = f.exec.mock.calls.at(-1)?.[0];
    expect(command?.args.slice(-2)).toEqual(["--", "printf exact"]);
    expect(command?.args).toContain("UpdateHostKeys=no");
    expect(command?.cwd).toBe(f.directory);
  });
  it("fails closed when original host-key policy and bssh capabilities do not overlap", async () => {
    const f = await fixture();
    f.exec.mockImplementation(async (command) => {
      const output = bsshProcess(command);
      if (command.args[0] === "-G")
        output.stdout = output.stdout.replace("unsupported,ssh-ed25519", "unsupported");
      return output;
    });
    await expect(
      bsshAdapter.execute(
        { ...f.input, action: "ping", parameters: { hosts: "familiar_alias" } },
        f.context,
      ),
    ).rejects.toThrow("no hostkeyalgorithms allowed");
    expect(f.exec.mock.calls.some(([command]) => command.args.includes("--batch"))).toBe(false);
  });
  it.each(["--proxy-command=evil", "host;evil", "", Array(33).fill("host").join(",")])(
    "rejects malformed or unbounded host input",
    async (hosts) => {
      const f = await fixture();
      await expect(
        bsshAdapter.execute({ ...f.input, action: "ping", parameters: { hosts } }, f.context),
      ).rejects.toThrow();
      expect(f.exec).not.toHaveBeenCalled();
    },
  );
});
