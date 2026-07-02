import { readFileSync } from 'node:fs';
import { cpus, platform } from 'node:os';

// ── 1. Render system.md ────────────────────────────────────────────────
const systemMd = readFileSync(
  'packages/agent-core/src/profile/default/system.md',
  'utf8',
);

const shellPath = process.env.SHELL || 'C:\\Program Files\\Git\\bin\\bash.exe';
const shellName = 'bash';

const vars = [
  ['{{ KIMI_OS }}', platform() === 'win32' ? 'Windows' : platform()],
  ['{{ KIMI_SHELL }}', `${shellName} (\`${shellPath}\`)`],
  ['{{ KIMI_NOW }}', new Date().toISOString()],
  ['{{ KIMI_WORK_DIR }}', process.cwd()],
  ['{{ KIMI_WORK_DIR_LS }}', ''],
  ['{{ KIMI_AGENTS_MD }}', ''],
  ['{{ KIMI_SKILLS }}', ''],
  ['{{ KIMI_ADDITIONAL_DIRS_INFO }}', ''],
  ['{{ ROLE_ADDITIONAL }}', ''],
  ['{% if KIMI_OS == "Windows" %}', '[if-windows]'],
  ['{% endif %}', '[/if]'],
];

let rendered = systemMd;
for (const [key, val] of vars) {
  rendered = rendered.replaceAll(key, val);
}
// Strip conditional blocks manually
rendered = rendered.replace(
  /\[if-windows\]\n?/g,
  platform() === 'win32' ? '' : '',
);
rendered = rendered.replace(/\[if-windows\].*?\[\/if\]\n?/gs, '');
rendered = rendered.replace(/\[\/if\]\n?/g, '');

const outputLines = [];
outputLines.push('='.repeat(78));
outputLines.push('  SYSTEM PROMPT (system.md renderizado)');
outputLines.push('='.repeat(78));
outputLines.push('');
outputLines.push(rendered);
outputLines.push('');

// ── 2. Tool definitions ────────────────────────────────────────────────
// Read every tool definition file and extract schema + description
import { globSync } from 'glob';

const agentYaml = readFileSync(
  'packages/agent-core/src/profile/default/agent.yaml',
  'utf8',
);
const toolListMatch = agentYaml.match(/tools:\n([\s\S]*?)(?=\n\w|$)/);
const toolNames = toolListMatch
  ? [...toolListMatch[1].matchAll(/^\s+-\s+(\S+)/gm)].map((m) => m[1])
  : [];
const toolNameSet = new Set(toolNames);

// Get all builtin tool files
const toolFiles = globSync(
  'packages/agent-core/src/tools/builtin/**/*.ts',
  { ignore: 'node_modules/**' },
);

// Find the InputSchema const names and export names for each tool
import { execSync } from 'node:child_process';

const toolInfo = [];
for (const file of toolFiles) {
  const content = readFileSync(file, 'utf8');
  // Find export const XxxInputSchema or XxxSchema
  const schemaMatch = content.match(/export\s+const\s+(\w+InputSchema|\w+Schema)\s*=/);
  if (!schemaMatch) continue;
  const schemaName = schemaMatch[1];

  // Find tool name/description/parameters declaration
  const nameMatch = content.match(/name\s*[=:]\s*['"]([^'"]+)['"]/);
  const descMatch = content.match(/description\s*[=:]\s*['"]([^'"]+)['"]/);
  const paramsMatch = content.match(/parameters[^;]+toInputJsonSchema\((\w+)\)/);

  if (nameMatch) {
    toolInfo.push({
      file,
      name: nameMatch[1],
      description: descMatch ? descMatch[1] : '',
      schemaName: paramsMatch ? paramsMatch[1] : schemaName,
    });
  }
}

// For each tool in the profile, find its info
outputLines.push('='.repeat(78));
outputLines.push('  TOOL DEFINITIONS (formato OpenAI API)');
outputLines.push('='.repeat(78));
outputLines.push('');

// Try to import actual schemas using dynamic import with tsx
// Fallback: read the Zod schema definition and approximate
outputLines.push('[');
for (let i = 0; i < toolNames.length; i++) {
  const toolName = toolNames[i];
  if (toolName === 'mcp__*') {
    outputLines.push('  {');
    outputLines.push('    "type": "function",');
    outputLines.push('    "function": {');
    outputLines.push('      "name": "mcp__*",');
    outputLines.push('      "description": "All MCP server tools (wildcard pattern)",');
    outputLines.push('      "parameters": {');
    outputLines.push('        "type": "object",');
    outputLines.push('        "properties": {},');
    outputLines.push('        "additionalProperties": true');
    outputLines.push('      }');
    outputLines.push('    }');
    outputLines.push('  }' + (i < toolNames.length - 1 ? ',' : ''));
    continue;
  }

  const info = toolInfo.find(t => t.name === toolName);
  if (info) {
    // Read the file to extract the Zod schema definition
    const content = readFileSync(info.file, 'utf8');
    // Find the schema definition
    const schemaDefStart = content.indexOf(`const ${info.schemaName}`);
    if (schemaDefStart >= 0) {
      const schemaBlock = content.slice(schemaDefStart);
      // Extract until the first semicolon at top level, or until "as const" or ";"
      const endMatch = schemaBlock.match(/;\s*(?:\n|$)/);
      const schemaDef = endMatch ? schemaBlock.slice(0, endMatch.index + 1) : schemaBlock.split('\n').slice(0, 30).join('\n');

      outputLines.push('  {');
      outputLines.push('    "type": "function",');
      outputLines.push('    "function": {');
      outputLines.push(`      "name": "${info.name}",`);
      outputLines.push(`      "description": ${JSON.stringify(info.description)},`);
      outputLines.push('      "parameters": <Zod schema — see source at ' + info.file.replace(/\\/g, '/') + '>');
      outputLines.push('    }');
      outputLines.push('  }' + (i < toolNames.length - 1 ? ',' : ''));
      outputLines.push(`  // Zod: ${schemaDef.substring(0, 200).trim()}...`);
    }
  } else {
    outputLines.push('  {');
    outputLines.push('    "type": "function",');
    outputLines.push('    "function": {');
    outputLines.push(`      "name": "${toolName}",`);
    outputLines.push('      "description": "(schema no encontrado)",');
    outputLines.push('      "parameters": {}');
    outputLines.push('    }');
    outputLines.push('  }' + (i < toolNames.length - 1 ? ',' : ''));
  }
}
outputLines.push(']');
outputLines.push('');

// ── 3. Stats ───────────────────────────────────────────────────────────
const sysChars = rendered.length;
const sysTokens = Math.round(sysChars / 3.5);
outputLines.push('='.repeat(78));
outputLines.push('  STATS');
outputLines.push('='.repeat(78));
outputLines.push(`  System prompt chars:     ${sysChars}`);
outputLines.push(`  System prompt tokens:    ~${sysTokens}`);
outputLines.push(`  Tools count:             ${toolNames.length}`);
outputLines.push(`  CPU cores:               ${cpus().length}`);
outputLines.push(`  Total tool defs files:   ${toolFiles.length}`);
outputLines.push('');
outputLines.push('  Full file saved to: todo.txt');
outputLines.push('='.repeat(78));

readFileSync('todo.txt', 'utf8');

const finalText = outputLines.join('\n');
process.stdout.write(finalText);
