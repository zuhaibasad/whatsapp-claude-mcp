import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { DEFAULT_MAX_TEXT_CHARS, DEFAULT_RETENTION_DAYS } from '../core/constants.js';
import type { ChatNote, Config, Department, PriorityRules } from '../core/contracts.js';
import type { DataPaths } from '../core/paths.js';

/** Thrown for unreadable YAML or invalid values. The message always starts with the file path. */
export class ConfigError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = 'ConfigError';
    this.filePath = filePath;
  }
}

// ---------- schemas (YAML snake_case) ----------

// A list entry may be written as a number in YAML (e.g. a chat named 2024); keep it as text.
const textItem = z.union([z.string(), z.number()]).transform((v) => String(v));
const textList = z.array(textItem).nullish();

const ConfigSchema = z.object({
  retention_days: z.number().int().min(1).nullish(),
  timezone: z.string().nullish(),
  include_groups: z.boolean().nullish(),
  include_direct_chats: z.boolean().nullish(),
  include_channels: z.boolean().nullish(),
  allowlist: textList,
  denylist: textList,
  my_names: textList,
  max_text_chars: z.number().int().min(1).nullish(),
  log_level: z.enum(['error', 'warn', 'info', 'debug']).nullish(),
});

const nonEmptyText = z.string().refine((s) => s.trim() !== '', 'must not be empty');

const DepartmentSchema = z.object({
  name: nonEmptyText,
  keywords: textList,
  examples: textList,
});

const PrioritiesSchema = z.object({
  critical: textList,
  high: textList,
  low: textList,
});

// ---------- helpers ----------

type YamlRead = { exists: false } | { exists: true; data: unknown };

function readYamlFile(file: string): YamlRead {
  if (!existsSync(file)) return { exists: false };
  let data: unknown;
  try {
    data = parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(file, `invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { exists: true, data };
}

/** Top-level mapping. An empty file counts as an empty mapping. */
function asMapping(data: unknown, file: string): Record<string, unknown> {
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError(file, 'expected key: value pairs at the top level');
  }
  return data as Record<string, unknown>;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.map(String).join('.');
      return where ? `${where}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function unknownKeyWarnings(obj: Record<string, unknown>, known: readonly string[], file: string, where = ''): string[] {
  return Object.keys(obj)
    .filter((key) => !known.includes(key))
    .map((key) => `${file}: ${where}unknown key "${key}" ignored`);
}

function cleanList(items: string[] | null | undefined): string[] {
  return (items ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function resolveTimezone(value: string | null | undefined, file: string, warnings: string[]): string {
  const tz = (value ?? '').trim();
  const system = systemTimeZone();
  if (tz === '') return system;
  if (isValidTimeZone(tz)) return tz;
  warnings.push(`${file}: timezone "${tz}" is not a valid IANA zone; using system zone ${system}`);
  return system;
}

// ---------- loaders ----------

/**
 * Reads config.yaml. A missing file gives defaults plus a warning.
 * Invalid YAML or values throw ConfigError.
 */
export function loadConfig(paths: DataPaths): { config: Config; warnings: string[] } {
  const file = paths.config;
  const warnings: string[] = [];
  const read = readYamlFile(file);
  if (!read.exists) {
    warnings.push(`${file}: not found, using default settings`);
  }
  const raw = read.exists ? asMapping(read.data, file) : {};

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(file, formatIssues(parsed.error));
  warnings.push(...unknownKeyWarnings(raw, Object.keys(ConfigSchema.shape), file));

  const d = parsed.data;
  const config: Config = {
    retentionDays: d.retention_days ?? DEFAULT_RETENTION_DAYS,
    timezone: resolveTimezone(d.timezone, file, warnings),
    includeGroups: d.include_groups ?? true,
    includeDirectChats: d.include_direct_chats ?? false,
    includeChannels: d.include_channels ?? false,
    allowlist: cleanList(d.allowlist),
    denylist: cleanList(d.denylist),
    myNames: cleanList(d.my_names),
    maxTextChars: d.max_text_chars ?? DEFAULT_MAX_TEXT_CHARS,
    logLevel: d.log_level ?? 'info',
  };
  return { config, warnings };
}

const ChatNoteSchema = z.object({
  chat: z.union([z.string(), z.number()]).transform((v) => String(v)).refine((s) => s.trim() !== '', 'must not be empty'),
  department: z.string().nullish(),
  note: z.string().nullish(),
});

/**
 * departments.yaml is either a top-level list of departments, or a mapping with `departments:` and/or `chats:`.
 * Returns the raw lists (validated by the callers). Anything else throws.
 */
function readDepartmentsDoc(file: string, read: YamlRead & { exists: true }): { departments: unknown[]; chats: unknown[]; warnings: string[] } {
  const data = read.data;
  if (data === null || data === undefined) return { departments: [], chats: [], warnings: [] };
  if (Array.isArray(data)) return { departments: data as unknown[], chats: [], warnings: [] };
  const isMap = typeof data === 'object' && ('departments' in (data as object) || 'chats' in (data as object));
  if (!isMap) throw new ConfigError(file, 'expected a list of departments, each with name, keywords and examples');
  const obj = data as Record<string, unknown>;
  const list = (key: string): unknown[] => {
    const v = obj[key];
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) throw new ConfigError(file, `"${key}" must be a list`);
    return v as unknown[];
  };
  return {
    departments: list('departments'),
    chats: list('chats'),
    warnings: unknownKeyWarnings(obj, ['departments', 'chats'], file),
  };
}

/**
 * Reads departments.yaml (a top-level list, or a mapping with `departments:` and `chats:`). A missing file gives []
 * plus a warning pushed onto `warnings` (optional out-param, keeps the signature `Department[]`).
 */
export function loadDepartments(paths: DataPaths, warnings: string[] = []): Department[] {
  const file = paths.departments;
  const read = readYamlFile(file);
  if (!read.exists) {
    warnings.push(`${file}: not found, no departments defined`);
    return [];
  }
  const doc = readDepartmentsDoc(file, read);
  warnings.push(...doc.warnings);
  const known = Object.keys(DepartmentSchema.shape);
  const departments: Department[] = [];
  doc.departments.forEach((item, i) => {
    const parsed = DepartmentSchema.safeParse(item);
    if (!parsed.success) throw new ConfigError(file, `department #${i + 1}: ${formatIssues(parsed.error)}`);
    const obj = item as Record<string, unknown>;
    const label = `department "${parsed.data.name.trim()}": `;
    warnings.push(...unknownKeyWarnings(obj, known, file, label));
    departments.push({
      name: parsed.data.name.trim(),
      keywords: cleanList(parsed.data.keywords),
      examples: cleanList(parsed.data.examples),
    });
  });
  return departments;
}

/**
 * Reads the optional `chats:` list of departments.yaml: per-chat guidance for Claude `{ chat, department?, note? }`.
 * Entries with neither department nor note are dropped with a warning. Unknown keys produce warnings.
 * A missing file or section gives [].
 */
export function loadChatNotes(paths: DataPaths, warnings: string[] = []): ChatNote[] {
  const file = paths.departments;
  const read = readYamlFile(file);
  if (!read.exists) return [];
  const doc = readDepartmentsDoc(file, read);
  warnings.push(...doc.warnings);
  const known = Object.keys(ChatNoteSchema.shape);
  const notes: ChatNote[] = [];
  doc.chats.forEach((item, i) => {
    const parsed = ChatNoteSchema.safeParse(item);
    if (!parsed.success) throw new ConfigError(file, `chats #${i + 1}: ${formatIssues(parsed.error)}`);
    const match = parsed.data.chat.trim();
    warnings.push(...unknownKeyWarnings(item as Record<string, unknown>, known, file, `chat "${match}": `));
    const department = parsed.data.department?.trim() || null;
    const note = parsed.data.note?.trim() || null;
    if (!department && !note) {
      warnings.push(`${file}: chat "${match}" has no department or note, ignored`);
      return;
    }
    notes.push({ match, department, note });
  });
  return notes;
}

/** The note for a chat, matched by id or by name (case-insensitive, exact). */
export function findChatNote(notes: readonly ChatNote[], chat: { id: string; name: string | null }): ChatNote | null {
  const id = chat.id.toLowerCase();
  const name = (chat.name ?? '').trim().toLowerCase();
  return notes.find((n) => n.match.toLowerCase() === id) ?? (name ? notes.find((n) => n.match.toLowerCase() === name) ?? null : null);
}

/**
 * Reads priorities.yaml. A missing file gives empty lists plus a warning
 * pushed onto `warnings` (optional out-param, keeps the signature `PriorityRules`).
 */
export function loadPriorities(paths: DataPaths, warnings: string[] = []): PriorityRules {
  const file = paths.priorities;
  const read = readYamlFile(file);
  if (!read.exists) {
    warnings.push(`${file}: not found, no priority rules defined`);
    return { critical: [], high: [], low: [] };
  }
  const raw = asMapping(read.data, file);
  const parsed = PrioritiesSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(file, formatIssues(parsed.error));
  warnings.push(...unknownKeyWarnings(raw, Object.keys(PrioritiesSchema.shape), file));
  return {
    critical: cleanList(parsed.data.critical),
    high: cleanList(parsed.data.high),
    low: cleanList(parsed.data.low),
  };
}

// ---------- default files ----------

const TEMPLATE_NAMES = ['config.yaml', 'departments.yaml', 'priorities.yaml'] as const;

/** Walks up from this file until a `templates/` folder holding config.yaml is found (works from src/ and dist/). */
function findTemplatesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'templates');
    if (existsSync(path.join(candidate, 'config.yaml'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('templates/ folder not found above ' + path.dirname(fileURLToPath(import.meta.url)));
    dir = parent;
  }
}

/**
 * Copies the templates into paths.dataDir. Existing files are skipped unless `overwrite` is set.
 * Returns the paths that were written.
 */
export function writeDefaultConfigs(paths: DataPaths, opts: { overwrite?: boolean } = {}): string[] {
  const templates = findTemplatesDir();
  mkdirSync(paths.dataDir, { recursive: true });
  const destinations: Record<(typeof TEMPLATE_NAMES)[number], string> = {
    'config.yaml': paths.config,
    'departments.yaml': paths.departments,
    'priorities.yaml': paths.priorities,
  };
  const written: string[] = [];
  for (const name of TEMPLATE_NAMES) {
    const dest = destinations[name];
    if (existsSync(dest) && !opts.overwrite) continue;
    copyFileSync(path.join(templates, name), dest);
    written.push(dest);
  }
  return written;
}
