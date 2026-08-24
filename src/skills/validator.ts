/**
 * Skill Validator — validates AI-suggested skills before saving.
 *
 * Prevents skill poisoning by enforcing:
 * - Length limits (max 100 lines)
 * - Forbidden content (rate limits, core identity overrides)
 * - Format requirements (must have title, must be markdown)
 * - Name safety (no path traversal, no reserved names)
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────

const MAX_SKILL_LINES = 100;
const MAX_SKILL_CHARS = 4000;
const MAX_TOTAL_SKILLS = 15;
const RESERVED_NAMES = [
  "nimjiagent", // core identity — locked
];

const FORBIDDEN_PATTERNS = [
  /rate\s*limit.*(?:ignore|bypass|skip|override)/i,
  /cooldown.*(?:ignore|bypass|skip)/i,
  /post.*every\s*\d+\s*(?:sec|min|hour)/i,
  /comment.*every\s*\d+\s*sec/i,
  /ignore.*rate\s*limit/i,
  /bypass.*cooldown/i,
  /override.*limit/i,
  /sudo\s*mode/i,
  /admin\s*mode/i,
  /system\s*prompt/i,
  /ignore.*previous/i,
  /disregard.*instruction/i,
  /you\s*are\s*now/i,
  /new\s*identity/i,
  /forget.*persona/i,
];

// ── Types ────────────────────────────────────────────────────────────

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type SkillSuggestion = {
  name: string;
  content: string;
  reason: string;
  suggestedAt: number;
};

export type SkillChangelogEntry = {
  action: "suggested" | "promoted" | "rejected" | "deleted";
  skillName: string;
  timestamp: number;
  reason: string;
  content?: string;
};

// ── Validator ────────────────────────────────────────────────────────

export class SkillValidator {
  private skillsDir: string;
  private draftsDir: string;
  private changelogPath: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.draftsDir = join(skillsDir, "drafts");
    this.changelogPath = join(skillsDir, "changelog.json");
  }

  /** Validate a suggested skill. */
  validate(name: string, content: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Name checks
    if (!name || typeof name !== "string") {
      errors.push("Skill name is required");
    } else {
      if (RESERVED_NAMES.includes(name.toLowerCase())) {
        errors.push(`"${name}" is a reserved name and cannot be used`);
      }
      if (/[^a-z0-9-]/.test(name)) {
        errors.push("Skill name must be lowercase alphanumeric with hyphens only");
      }
      if (name.length < 3 || name.length > 30) {
        errors.push("Skill name must be 3-30 characters");
      }
      if (/\.\./.test(name) || /[\\/]/.test(name)) {
        errors.push("Skill name contains path traversal characters");
      }
    }

    // Content checks
    if (!content || typeof content !== "string") {
      errors.push("Skill content is required");
    } else {
      const lines = content.split("\n");

      if (lines.length > MAX_SKILL_LINES) {
        errors.push(`Skill exceeds ${MAX_SKILL_LINES} lines (got ${lines.length})`);
      }

      if (content.length > MAX_SKILL_CHARS) {
        errors.push(`Skill exceeds ${MAX_SKILL_CHARS} characters (got ${content.length})`);
      }

      if (!content.trimStart().startsWith("#")) {
        warnings.push("Skill should start with a markdown title (# Title)");
      }

      // Check for forbidden patterns (rate limit overrides, etc.)
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          errors.push(`Skill contains forbidden pattern: ${pattern.source}`);
        }
      }
    }

    // Total skill count check
    const existingSkills = this.listActiveSkills();
    if (existingSkills.length >= MAX_TOTAL_SKILLS) {
      errors.push(`Maximum ${MAX_TOTAL_SKILLS} skills reached. Delete unused skills first.`);
    }

    // Check for duplicate names
    if (existingSkills.includes(name)) {
      errors.push(`Skill "${name}" already exists. Use a different name.`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /** Save a validated skill to drafts directory. */
  saveDraft(suggestion: SkillSuggestion): { success: boolean; path: string; error?: string } {
    const validation = this.validate(suggestion.name, suggestion.content);
    if (!validation.valid) {
      return {
        success: false,
        path: "",
        error: validation.errors.join("; "),
      };
    }

    try {
      mkdirSync(this.draftsDir, { recursive: true });
      const filePath = join(this.draftsDir, `${suggestion.name}.md`);
      writeFileSync(filePath, suggestion.content, "utf-8");

      // Log to changelog
      this.logChangelog({
        action: "suggested",
        skillName: suggestion.name,
        timestamp: suggestion.suggestedAt,
        reason: suggestion.reason,
        content: suggestion.content,
      });

      return { success: true, path: filePath };
    } catch (err) {
      return {
        success: false,
        path: "",
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  /** Promote a draft skill to active. */
  promoteDraft(skillName: string): { success: boolean; error?: string } {
    const draftPath = join(this.draftsDir, `${skillName}.md`);
    const activePath = join(this.skillsDir, `${skillName}.md`);

    if (!existsSync(draftPath)) {
      return { success: false, error: `Draft "${skillName}" not found` };
    }

    try {
      const content = readFileSync(draftPath, "utf-8");
      writeFileSync(activePath, content, "utf-8");

      this.logChangelog({
        action: "promoted",
        skillName,
        timestamp: Date.now(),
        reason: "Manually promoted from drafts",
      });

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  /** List active skill names. */
  listActiveSkills(): string[] {
    try {
      const files = readdirSync(this.skillsDir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
      return files.map((f) => f.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }

  /** List draft skill names. */
  listDraftSkills(): string[] {
    try {
      const files = readdirSync(this.draftsDir).filter((f) => f.endsWith(".md"));
      return files.map((f) => f.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }

  /** Delete a skill (active or draft). */
  deleteSkill(name: string, draft = false): boolean {
    const dir = draft ? this.draftsDir : this.skillsDir;
    const filePath = join(dir, `${name}.md`);

    if (!existsSync(filePath)) return false;

    try {
      unlinkSync(filePath);
      this.logChangelog({
        action: "deleted",
        skillName: name,
        timestamp: Date.now(),
        reason: draft ? "Deleted draft" : "Deleted active skill",
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Get the changelog. */
  getChangelog(): SkillChangelogEntry[] {
    try {
      const data = readFileSync(this.changelogPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private logChangelog(entry: SkillChangelogEntry): void {
    const changelog = this.getChangelog();
    changelog.push(entry);
    // Keep last 100 entries
    const trimmed = changelog.slice(-100);
    writeFileSync(this.changelogPath, JSON.stringify(trimmed, null, 2), "utf-8");
  }
}
