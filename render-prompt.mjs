// Quick render script — run with: node render-prompt.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function findFiles(dir, ext) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith('node_modules') && !e.name.startsWith('.')) {
      results.push(...findFiles(p, ext));
    } else if (e.isFile() && e.name.endsWith(ext)) {
      results.push(p);
    }
  }
  return results;
}

// ── Read system.md ──────────────────────────────────────────────
const systemMd = readFileSync(
  resolve(here, 'packages/agent-core/src/profile/default/system.md'),
  'utf8',
);

let rendered = systemMd
  .replaceAll('{{ KIMI_OS }}', platform() === 'win32' ? 'Windows' : platform())
  .replaceAll('{{ KIMI_SHELL }}', 'bash (`C:\\Program Files\\Git\\bin\\bash.exe`)')
  .replaceAll('{{ KIMI_NOW }}', new Date().toISOString())
  .replaceAll('{{ KIMI_WORK_DIR }}', process.cwd())
  .replaceAll('{{ KIMI_WORK_DIR_LS }}', '')
  .replaceAll('{{ KIMI_AGENTS_MD }}', '')
  .replaceAll('{{ KIMI_SKILLS }}', '')
  .replaceAll('{{ ROLE_ADDITIONAL }}', '')
  .replaceAll('{{ KIMI_ADDITIONAL_DIRS_INFO }}', '')
  .replace(/\{%[^%]+%\}[^]*?\{%[^%]+%\}/g, '')
  .replace(/\{%[^%]+%\}/g, '');

// ── Read agent.yaml tools ─────────────────────────────────────────
const agentYaml = readFileSync(
  resolve(here, 'packages/agent-core/src/profile/default/agent.yaml'),
  'utf8',
);
const tlMatch = agentYaml.match(/tools:\n([\s\S]*?)(?=\n\w|$)/);
const toolNames = tlMatch
  ? [...tlMatch[1].matchAll(/^\s+-\s+(\S+)/gm)].map((m) => m[1])
  : [];

// ── Gather tool files ─────────────────────────────────────────────
const toolFiles = findFiles(resolve(here, 'packages/agent-core/src/tools/builtin'), '.ts');
const toolDefs = [];
for (const f of toolFiles) {
  const content = readFileSync(f, 'utf8');
  const nameM = content.match(/name\s*[=:]\s*['"]([^'"]+)['"]/);
  if (!nameM || !toolNames.includes(nameM[1])) continue;
  const descM = content.match(/description\s*[=:]\s*['"]([^'"]+)['"]/);
  const paramsM = content.match(/parameters[^;]+toInputJsonSchema\((\w+)\)/);
  const schemaVar = paramsM ? paramsM[1] : null;
  let schemaSrc = '';
  if (schemaVar) {
    const sM = content.match(new RegExp(`const\\s+${schemaVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*([^;]+);`));
    if (sM) schemaSrc = sM[1].trim().substring(0, 250);
  }
  toolDefs.push({ name: nameM[1], desc: descM ? descM[1] : '', schemaSrc, file: f.replace(here + '/', '') });
}

// ── Build output ──────────────────────────────────────────────────
const parts = [];
parts.push('='.repeat(78));
parts.push('  SYSTEM PROMPT (system.md renderizado con variables reales)');
parts.push('  Generado: ' + new Date().toLocaleString());
parts.push('='.repeat(78));
parts.push('');
parts.push(rendered);
parts.push('');
parts.push('='.repeat(78));
parts.push('  TOOL DEFINITIONS (OpenAI API format)');
parts.push('='.repeat(78));
parts.push('');

for (let i = 0; i < toolNames.length; i++) {
  const n = toolNames[i];
  const comma = i < toolNames.length - 1 ? ',' : '';
  if (n === 'mcp__*') {
    parts.push('  {\n    "type": "function",\n    "function": {\n      "name": "mcp__*",\n      "description": "Wildcard — any MCP server tool",\n      "parameters": { "type": "object", "properties": {}, "additionalProperties": true }\n    }\n  }' + comma);
    continue;
  }
  const td = toolDefs.find(d => d.name === n);
  if (td) {
    parts.push('  {\n    "type": "function",\n    "function": {\n      "name": "' + td.name + '",\n      "description": ' + JSON.stringify(td.desc) + ',\n      "parameters": <Zod schema — see ' + td.file.replace(/\\/g, '/') + '>\n    }\n  }' + comma);
    if (td.schemaSrc) {
      parts.push('  // Zod source: ' + td.schemaSrc);
    }
  } else {
    parts.push('  {\n    "type": "function",\n    "function": {\n      "name": "' + n + '",\n      "description": "(auto-detected)",\n      "parameters": {}\n    }\n  }' + comma);
  }
}

parts.push('');
parts.push('='.repeat(78));
parts.push('  STATS');
parts.push('='.repeat(78));
parts.push('  System prompt chars:    ' + rendered.length);
parts.push('  System prompt tokens:   ~' + Math.round(rendered.length / 3.5));
parts.push('  Tools in profile:       ' + toolNames.length);
parts.push('  Tool defs found:        ' + toolDefs.length + ' / ' + toolNames.filter(n => n !== 'mcp__*').length);
parts.push('  CPU cores:              ' + cpus().length);
parts.push('');
parts.push('  Archivo guardado: todo.txt');
parts.push('='.repeat(78));

const finalText = parts.join('\n');
writeFileSync(resolve(here, 'todo.txt'), finalText, 'utf8');
console.log('OK — todo.txt generado (' + finalText.length + ' bytes)');
