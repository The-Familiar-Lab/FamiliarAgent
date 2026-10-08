import { describe, expect, it } from "vitest";
import { authorityRequestError } from "./authority.js";

describe("shared server error messages", () => {
  it.each(["stdout", "stderr"])("preserves the actual remote error from %s", (channel) => {
    const cause = Object.assign(new Error("Command failed: launcher plugin call /private/input"), {
      [channel]: JSON.stringify({
        error: { message: "Source connection expired; reopen the session" },
      }),
    });
    const result = authorityRequestError(cause);
    expect(result.message).toBe("Source connection expired; reopen the session");
    expect(result.cause).toBe(cause);
  });

  it("keeps transport failures and invalid CLI output intact", () => {
    const cause = Object.assign(new Error("SSH connection failed"), { stderr: "not JSON" });
    expect(authorityRequestError(cause)).toBe(cause);
    expect(authorityRequestError(new Error("timeout")).message).toBe("timeout");
  });
});
