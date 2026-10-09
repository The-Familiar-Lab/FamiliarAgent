import { expect, it } from "vitest";
import {
  discordSourceCommand,
  discordSourceSchema,
  discordSourceSshArgs,
} from "./discord-source.js";
it("retains SSH port and alias and quotes original configuration paths", () => {
  const source = discordSourceSchema.parse({
    sshEndpoint: "ssh://user@server:2222?daemonPort=6787",
    configPath: "/private/a'$(touch nope)/config.json",
  });
  expect(discordSourceSshArgs(source)).toContain("2222");
  expect(discordSourceSshArgs(source).at(-1)).toBe("user@server");
  const command = discordSourceCommand(source, "a".repeat(64), "inspect");
  expect(command).toContain("'/private/a'\\''$(touch nope)/config.json'");
  expect(command).not.toContain("token");
});
it("refuses relative paths, non-SSH routes and forged bundle paths", () => {
  expect(() =>
    discordSourceSchema.parse({ sshEndpoint: "https://server", configPath: "/private/config" }),
  ).toThrow();
  expect(() =>
    discordSourceSchema.parse({ sshEndpoint: "ssh://server", configPath: "./config" }),
  ).toThrow();
  expect(() =>
    discordSourceCommand(
      { sshEndpoint: "ssh://server", configPath: "/config" },
      "../bad",
      "inspect",
    ),
  ).toThrow();
});
