import { z } from 'zod';

const BashSchema = z.object({
  command: z.string().min(1).describe('The command to execute.'),
  cwd: z.string().optional().describe('Working directory'),
  timeout: z.number().int().positive().optional().describe('Timeout in seconds'),
  description: z.string().optional().describe('Description for background'),
  run_in_background: z.boolean().optional().describe('Run as background task'),
  disable_timeout: z.boolean().optional().describe('Disable timeout for background'),
});

const GlobSchema = z.object({
  pattern: z.string().describe('Glob pattern to match'),
  path: z.string().optional().describe('Absolute path to search'),
  include_dirs: z.boolean().default(true).optional().describe('Include directories'),
});

const GrepSchema = z.object({
  pattern: z.string().describe('Regular expression to search for'),
  path: z.string().optional().describe('File or directory to search'),
  glob: z.string().optional().describe('Optional glob filter'),
  type: z.string().optional().describe('ripgrep file type filter'),
  output_mode: z.enum(['content','files_with_matches','count_matches']).optional().describe('Shape of result'),
  '-i': z.boolean().optional().describe('Case-insensitive search'),
  '-n': z.boolean().optional().describe('Prefix each line with line number'),
  '-A': z.number().int().nonnegative().optional().describe('Lines after'),
  '-B': z.number().int().nonnegative().optional().describe('Lines before'),
  '-C': z.number().int().nonnegative().optional().describe('Context lines'),
  head_limit: z.number().int().nonnegative().optional().describe('Max N lines'),
  offset: z.number().int().nonnegative().optional().describe('Skip N lines'),
  multiline: z.boolean().optional().describe('Multiline matching'),
  include_ignored: z.boolean().optional().describe('Search gitignored files'),
});

const ReadSchema = z.object({
  path: z.string().describe('Path to text file'),
  line_offset: z.union([
    z.number().int().min(1).describe('Positive line offset'),
    z.number().int().min(-1000).max(-1).describe('Negative line offset'),
  ]).optional().describe('Line number to start from'),
  n_lines: z.number().int().positive().optional().describe('Number of lines to read'),
});

const EditSchema = z.object({
  path: z.string().describe('Path to text file'),
  old_string: z.string().min(1).describe('Text to replace'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace all occurrences'),
});

const WriteSchema = z.object({
  path: z.string().describe('Path to file'),
  content: z.string().describe('File content'),
  mode: z.enum(['overwrite','append']).optional().describe('Write mode'),
});

const all = { Bash: BashSchema, Glob: GlobSchema, Grep: GrepSchema, Read: ReadSchema, Edit: EditSchema, Write: WriteSchema };

let totalChars = 0;
for (const [name, schema] of Object.entries(all)) {
  const json = JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }));
  // Also add additionalProperties: false if not present
  const parsed = JSON.parse(json);
  if (parsed.type === 'object' && parsed.additionalProperties === undefined) {
    parsed.additionalProperties = false;
  }
  const final = JSON.stringify(parsed, null, 2);
  const chars = final.length;
  totalChars += chars;
  const tokens = Math.ceil(chars / 3.5);
  console.log(`=== ${name} (${chars} chars, ~${tokens} tokens) ===`);
  console.log(final);
  console.log('');
}
console.log(`=== TOTAL SCHEMA CHARS: ${totalChars} (~${Math.ceil(totalChars / 3.5)} tokens) ===`);
