import { expect, it } from "vitest";
import { selectSessionSkill } from "./session-resources.js";
import type { CompositionResource, CompositionSession } from "../../shared/composition.js";
const history = {
  id: "history",
  kind: "history",
  locator: "agent",
  label: "Chat",
  serverId: "mac",
  readOnly: true,
} as CompositionResource;
const base = { resources: [history], disabledResourceIds: ["unrelated"] } as CompositionSession;
const skill: CompositionResource = {
  id: "parent-skill",
  kind: "skill",
  format: "path",
  label: "review",
  locator: "review",
  serverId: "linux",
  readOnly: true,
};
it("adopts an owner-identified registry reference without copying paths or changing history", () => {
  const result = selectSessionSkill(
    base,
    [],
    { serverId: "linux", connection: "ssh://linux", skillId: "review" },
    true,
    "new-skill",
  );
  expect(result.resources).toEqual([
    history,
    { ...skill, id: "new-skill", connection: "ssh://linux" },
  ]);
  expect(result.disabledResourceIds).toEqual(["unrelated"]);
  expect(base.resources).toEqual([history]);
});
it("stops inherited skills only for this child and distinguishes identical IDs on other servers", () => {
  const other = { ...skill, id: "other-skill", serverId: "mac" };
  const result = selectSessionSkill(
    base,
    [skill, other],
    { serverId: "linux", skillId: "review" },
    false,
    "unused",
  );
  expect(result.resources).toEqual([history]);
  expect(result.disabledResourceIds).toEqual(["unrelated", "parent-skill"]);
  expect(skill.locator).toBe("review");
});
it("re-enables a disabled own ID and removes only owned skill refs when stopping", () => {
  const session = {
    ...base,
    resources: [history, skill],
    disabledResourceIds: ["parent-skill", "unrelated"],
  };
  expect(
    selectSessionSkill(session, [], { serverId: "linux", skillId: "review" }, true, "unused"),
  ).toEqual({ resources: [history, skill], disabledResourceIds: ["unrelated"] });
  expect(
    selectSessionSkill(session, [skill], { serverId: "linux", skillId: "review" }, false, "unused"),
  ).toEqual({ resources: [history], disabledResourceIds: ["unrelated"] });
});
