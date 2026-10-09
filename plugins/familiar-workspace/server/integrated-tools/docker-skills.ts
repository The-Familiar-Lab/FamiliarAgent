import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { nativeId, parameter, result } from "./common.js";

const skillId = z.string().regex(/^docker-[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const indexSchema = z.object({
  groupings: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        skills: z.array(skillId).min(1).max(64),
      }),
    )
    .min(1)
    .max(16),
});
const pack = { key: "packRoot", label: "Original Docker skills folder", required: true };

async function boundedText(file: string) {
  const opened = await open(file, "r");
  try {
    const info = await opened.stat();
    if (!info.isFile() || info.size > 65_536)
      throw new Error("Docker skill metadata must be a regular file below 64 KiB.");
    return await opened.readFile("utf8");
  } finally {
    await opened.close();
  }
}

/** Docker's generated index owns the inventory. Project projections reference these original folders. */
export async function inspectDockerSkills(selected: string) {
  if (!isAbsolute(selected)) throw new Error("Select an absolute Docker skills folder.");
  const root = await realpath(selected);
  const index = indexSchema.parse(JSON.parse(await boundedText(join(root, "skills.sh.json"))));
  const seen = new Set<string>();
  const skills = [];
  for (const group of index.groupings) {
    for (const id of group.skills) {
      if (seen.has(id)) throw new Error("Docker skill index contains duplicate IDs.");
      seen.add(id);
      const directory = await realpath(join(root, "skills", id));
      const inside = relative(root, directory);
      if (inside.startsWith("..") || isAbsolute(inside))
        throw new Error("Docker skill directory must stay inside the selected pack.");
      const text = await boundedText(join(directory, "SKILL.md"));
      if (!text.startsWith("---\n") || !text.split("\n").includes(`name: ${id}`))
        throw new Error(`Docker skill ${id} has inconsistent metadata.`);
      skills.push({ id, path: directory, group: group.title, description: group.description });
    }
  }
  return skills;
}

export const dockerSkillsAdapter: ToolActionAdapter = {
  id: "docker-skills",
  actions: [
    {
      id: "inspect",
      label: "Browse original Docker skills",
      description:
        "Read Docker's published skill inventory and validate its source folders. Set up / Use installed paths registers references in Memory & Skills; no Docker engine or model is started.",
      mutates: false,
      parameters: [pack],
    },
    {
      id: "read",
      label: "Read original skill",
      description:
        "Read one original SKILL.md, with its native compatibility requirements and guidance.",
      mutates: false,
      nativeId: true,
      parameters: [pack],
    },
  ],
  async execute(request) {
    const skills = await inspectDockerSkills(parameter(request, "packRoot"));
    if (request.action === "inspect") return result({ skills });
    if (request.action !== "read") throw new Error("Unknown Docker skills action.");
    const id = nativeId(request);
    const skill = skills.find((entry) => entry.id === id);
    if (!skill) throw new Error("Choose a skill ID from this original Docker pack.");
    return result(await boundedText(join(skill.path, "SKILL.md")), "completed", id);
  },
};
