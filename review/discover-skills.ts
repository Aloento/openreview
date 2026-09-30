import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SkillMetadata } from "@/lib/skills";
import { parseFrontmatter } from "@/lib/skills";

export const discoverSkills = async (
  directories: string[]
): Promise<SkillMetadata[]> => {
  const skills: SkillMetadata[] = [];
  const seenNames = new Set<string>();

  for (const dir of directories) {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDir = join(dir, entry.name);
      const skillFile = join(skillDir, "SKILL.md");

      try {
        const raw = await readFile(skillFile, "utf8");
        const { body, description, name } = parseFrontmatter(raw);

        if (seenNames.has(name)) {
          continue;
        }

        seenNames.add(name);

        skills.push({
          content: body,
          description,
          name,
        });
      } catch {
        continue;
      }
    }
  }

  return skills;
};
