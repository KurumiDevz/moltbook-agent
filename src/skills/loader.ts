/**
 * Skill Loader — loads agent skills from the skills/ directory.
 *
 * Each skill is a .md file that defines personality, rules, and behavior.
 * The loader finds all skills, caches them, and provides them to the brain.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

export type Skill = {
  name: string;
  path: string;
  content: string;
};

export type SkillLoaderConfig = {
  /** Directory containing skill .md files (default: ./skills) */
  skillsDir?: string;
};

export class SkillLoader {
  private skillsDir: string;
  private cache = new Map<string, Skill>();

  constructor(config: SkillLoaderConfig = {}) {
    this.skillsDir = config.skillsDir ?? resolve(process.cwd(), "skills");
  }

  /** Load all skills from the skills directory. */
  loadAll(): Skill[] {
    this.cache.clear();

    let files: string[];
    try {
      files = readdirSync(this.skillsDir).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }

    for (const file of files) {
      const name = file.replace(/\.md$/, "");
      const path = join(this.skillsDir, file);
      const content = readFileSync(path, "utf-8");
      const skill: Skill = { name, path, content };
      this.cache.set(name, skill);
    }

    return [...this.cache.values()];
  }

  /** Load a specific skill by name. */
  get(name: string): Skill | null {
    if (this.cache.has(name)) return this.cache.get(name)!;

    const path = join(this.skillsDir, `${name}.md`);
    try {
      const content = readFileSync(path, "utf-8");
      const skill: Skill = { name, path, content };
      this.cache.set(name, skill);
      return skill;
    } catch {
      return null;
    }
  }

  /** List all available skill names. */
  list(): string[] {
    try {
      return readdirSync(this.skillsDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }

  /** Reload a specific skill from disk. */
  reload(name: string): Skill | null {
    this.cache.delete(name);
    return this.get(name);
  }
}
